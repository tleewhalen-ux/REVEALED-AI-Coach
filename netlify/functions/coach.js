// This runs on Netlify's server, never in the visitor's browser.
// It keeps the Anthropic API key private and relays coach conversations to Claude.
//
// author-notes.txt is fetched live from GitHub on every request.
// citations.txt is bundled and cached with the stable system prompt.
// passages/ holds book text. Only the sections that match the latest
// question are attached, and they are not part of the cached block.

const fs = require('fs');
const path = require('path');

const AUTHOR_NOTES_URL = 'https://raw.githubusercontent.com/tleewhalen-ux/REVEALED-AI-Coach/main/netlify/functions/author-notes.txt';
const PASSAGES_DIR = path.join(__dirname, 'passages');
const MAX_PASSAGE_CHARS = 12000;
const MAX_PASSAGES = 3;

const BIBLE_BOOKS = [
  ['genesis', 'gen'], ['exodus', 'exod', 'exo'], ['leviticus', 'lev'],
  ['numbers', 'num'], ['deuteronomy', 'deut', 'deu'], ['joshua', 'josh'],
  ['judges', 'judg'], ['ruth'], ['1 samuel', '1samuel', '1 sam'],
  ['2 samuel', '2samuel', '2 sam'], ['1 kings', '1kings', '1 kgs'],
  ['2 kings', '2kings', '2 kgs'], ['1 chronicles', '1chronicles', '1 chr'],
  ['2 chronicles', '2chronicles', '2 chr'], ['ezra'], ['nehemiah', 'neh'],
  ['esther', 'esth'], ['job'], ['psalm', 'psalms', 'psa'],
  ['proverbs', 'prov'], ['ecclesiastes', 'eccl'], ['song of solomon', 'song of songs', 'canticles'],
  ['isaiah', 'isa'], ['jeremiah', 'jer'], ['lamentations', 'lam'],
  ['ezekiel', 'ezek'], ['daniel', 'dan'], ['hosea', 'hos'], ['joel'],
  ['amos'], ['obadiah', 'obad'], ['jonah'], ['micah', 'mic'],
  ['nahum', 'nah'], ['habakkuk', 'hab'], ['zephaniah', 'zeph'],
  ['haggai', 'hag'], ['zechariah', 'zech'], ['malachi', 'mal'],
  ['matthew', 'matt', 'mt'], ['mark', 'mk'], ['luke', 'lk'], ['john', 'jn'],
  ['acts'], ['romans', 'rom'], ['1 corinthians', '1corinthians', '1 cor'],
  ['2 corinthians', '2corinthians', '2 cor'], ['galatians', 'gal'],
  ['ephesians', 'eph'], ['philippians', 'phil'], ['colossians', 'col'],
  ['1 thessalonians', '1thessalonians', '1 thess'],
  ['2 thessalonians', '2thessalonians', '2 thess'],
  ['1 timothy', '1timothy', '1 tim'], ['2 timothy', '2timothy', '2 tim'],
  ['titus'], ['philemon', 'phlm'], ['hebrews', 'heb'], ['james', 'jas'],
  ['1 peter', '1peter', '1 pet'], ['2 peter', '2peter', '2 pet'],
  ['1 john', '1john', '1 jn'], ['2 john', '2john', '2 jn'],
  ['3 john', '3john', '3 jn'], ['jude'], ['revelation', 'rev']
];

let citationSources = '';
try {
  citationSources = fs.readFileSync(path.join(__dirname, 'citations.txt'), 'utf8').trim();
} catch (err) {
  console.log('citations.txt not found or unreadable:', err.message);
}

function walkFiles(dir, found) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, found);
    else if (/\.txt$/i.test(entry.name)) found.push(full);
  }
  return found;
}

function loadPassages() {
  return walkFiles(PASSAGES_DIR, []).map((file) => {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      console.log('passage unreadable:', file, err.message);
    }
    const relative = path.relative(PASSAGES_DIR, file).replace(/\\/g, '/');
    const title = (text.split(/\r?\n/)[0] || path.basename(file, '.txt')).replace(/^#\s*/, '');
    return { file: relative, title, text };
  }).filter((passage) => passage.text);
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => part && part.text ? part.text : '').join('\n');
      }
    }
  }
  return '';
}

function referenceNeedles(question) {
  const needles = [];
  const q = question.toLowerCase();
  for (const names of BIBLE_BOOKS) {
    const hit = names.find((name) => q.includes(name));
    if (!hit) continue;
    const chapter = q.match(new RegExp(hit.replace(/\s+/g, '\\s*') + '\\s+(\\d{1,3})'));
    needles.push(chapter ? names[0] + ' ' + chapter[1] : names[0]);
  }
  return needles;
}

function scorePassage(passage, question) {
  const q = question.toLowerCase();
  const label = (passage.file + ' ' + passage.title).toLowerCase();
  let score = 0;
  for (const needle of referenceNeedles(question)) {
    if (label.includes(needle) || passage.text.toLowerCase().includes(needle)) score += 10;
  }
  const words = q.split(/[^a-z0-9]+/).filter((word) => word.length > 4);
  for (const word of words) {
    if (label.includes(word)) score += 3;
    else if (passage.text.toLowerCase().includes(word)) score += 1;
  }
  return score;
}

function selectPassages(question) {
  const ranked = loadPassages()
    .map((passage) => ({ passage, score: scorePassage(passage, question) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PASSAGES);

  let used = 0;
  const chosen = [];
  for (const item of ranked) {
    if (used >= MAX_PASSAGE_CHARS) break;
    const room = MAX_PASSAGE_CHARS - used;
    const excerpt = item.passage.text.slice(0, room);
    used += excerpt.length;
    chosen.push('SOURCE: ' + item.passage.file + '\n' + excerpt);
  }
  return chosen.join('\n\n---\n\n');
}

async function fetchAuthorNotes() {
  try {
    const res = await fetch(AUTHOR_NOTES_URL, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!res.ok) {
      console.log('author-notes.txt fetch failed with status:', res.status);
      return '';
    }
    return (await res.text()).trim();
  } catch (err) {
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
    const authorNotes = await fetchAuthorNotes();
    const passages = selectPassages(latestUserText(messages));

    let stableSystem = system;
    if (citationSources) {
      stableSystem += '\n\nEXTERNAL SOURCE BIBLIOGRAPHY (real sources cited in the book \u2014 you may name these when relevant, but never reproduce their text, only attribute to them):\n' + citationSources;
    }

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
        text: 'ADDITIONAL AUTHOR NOTES (treat these as authoritative, up-to-date guidance from Terry \u2014 follow them even if they refine or add to anything above):\n' + authorNotes
      });
    }

    if (passages) {
      systemBlocks.push({
        type: 'text',
        text: 'RETRIEVED PASSAGES (use these when they bear on the question; quote only what is here, and do not claim a book says something this text does not):\n' + passages
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
