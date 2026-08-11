// This runs on Netlify's server, never in the visitor's browser.
// It keeps the Anthropic API key private and relays coach conversations to Claude.

// author-notes.txt is now fetched LIVE from GitHub on every request instead of
// being bundled with the function. Edit and commit the file on GitHub and your
// very next message to the coach will use the updated notes — no Netlify
// redeploy or cold-start wait required.
//
// citations.txt is still large and stable, so it stays as a bundled local file
// read once at cold-start (no need to re-fetch it on every request).
const fs = require('fs');
const path = require('path');

const AUTHOR_NOTES_URL = 'https://raw.githubusercontent.com/tleewhalen-ux/REVEALED-AI-Coach/main/netlify/functions/author-notes.txt';

let citationSources = '';
try {
  citationSources = fs.readFileSync(path.join(__dirname, 'citations.txt'), 'utf8').trim();
} catch (err) {
  // File missing or unreadable — fail silently so the coach still works
  // without the external-source bibliography.
  console.log('citations.txt not found or unreadable:', err.message);
}

async function fetchAuthorNotes() {
  try {
    const res = await fetch(AUTHOR_NOTES_URL, {
      // Ask GitHub's raw CDN not to hand back a stale cached copy.
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      console.log('author-notes.txt fetch failed with status:', res.status);
      return '';
    }
    return (await res.text()).trim();
  } catch (err) {
    // Network hiccup or file missing — fail silently so the coach still works
    // with just the built-in BOOK_CONTEXT from coach.html.
    console.log('author-notes.txt fetch error:', err.message);
    return '';
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Netlify > Project configuration > Environment variables.' })
    };
  }
  try {
    const { system, messages } = JSON.parse(event.body);

    // Fetch the latest author notes fresh for this request.
    const authorNotes = await fetchAuthorNotes();

    // STABLE block: coach.html's system prompt + citations.txt. This almost
    // never changes between requests, so it's marked cacheable. Anthropic
    // caches this block for ~5 minutes; repeat requests within that window
    // are billed at a fraction of normal input-token cost for this portion.
    let stableSystem = system;
    if (citationSources) {
      stableSystem += '\n\nEXTERNAL SOURCE BIBLIOGRAPHY (real sources cited in the book — you may name these when relevant, but never reproduce their text, only attribute to them):\n' + citationSources;
    }

    // Build the system parameter as an array of content blocks. Only the
    // stable block gets cache_control — author notes are deliberately left
    // OUT of the cached block so live edits on GitHub still take effect on
    // the very next message, exactly as before.
    const systemBlocks = [
      {
        type: 'text',
        text: stableSystem,
        cache_control: { type: 'ephemeral' }
      }
    ];

    if (authorNotes) {
      systemBlocks.push({
        type: 'text',
        text: 'ADDITIONAL AUTHOR NOTES (treat these as authoritative, up-to-date guidance from Terry — follow them even if they refine or add to anything above):\n' + authorNotes
      });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        system: systemBlocks,
        messages: messages
      })
    });
    const data = await response.json();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};