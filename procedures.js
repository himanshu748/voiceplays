import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Voice replies are spoken, not read. Anything past a couple of sentences is
// unusable out loud, so every reply is capped here rather than at the client.
const SPEECH_LIMIT = 240;
const CACHE_TTL_MS = 30000;

let cache = { at: 0, rows: null };

// CLI output is drawn for a terminal: ANSI colour, box-drawing bars, spinner
// glyphs and tree characters. Read aloud they become noise or silence, so they
// are stripped before anything reaches a speaker.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const DECORATION = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\uE000-\uF8FF\u{1F300}-\u{1FAFF}]/gu;

export function despeak(text) {
  return String(text)
    .replace(ANSI, ' ')
    .replace(DECORATION, ' ')
    .replace(/[*_`|>#]+/g, ' ')
    .replace(/\s*\.\s*(?=\.)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speakable(text) {
  const flat = despeak(text);
  if (flat.length <= SPEECH_LIMIT) return flat;
  return flat.slice(0, SPEECH_LIMIT - 1).replace(/[,;:\s]\S*$/, '') + '.';
}

export async function listProcedures({ fresh = false } = {}) {
  if (!fresh && cache.rows && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { stdout } = await run('rote', ['play', 'list', '--json'], {
    timeout: 20000,
    maxBuffer: 8 * 1024 * 1024
  });
  const parsed = JSON.parse(stdout);
  const raw = Array.isArray(parsed) ? parsed : (parsed.flows ?? parsed.plays ?? []);
  const rows = raw.filter(r => r && typeof r === 'object' && r.name).map(r => {
    const params = Array.isArray(r.parameters) ? r.parameters : [];
    const tags = Array.isArray(r.tags) ? r.tags : [];
    return {
      name: r.name,
      description: r.description ?? '',
      tags,
      status: r.status ?? 'Unknown',
      source: r.source ?? 'unknown',
      requiredParams: params.filter(p => p && p.required).map(p => p.name),
      readOnly: tags.includes('effect-read-only')
    };
  });
  // 32 of 84 plays appear twice, once as `local` and once as `hub` after
  // publishing. Voice cannot disambiguate two identical names, so keep one.
  const byName = new Map();
  for (const r of rows) {
    const prev = byName.get(r.name);
    if (!prev || (prev.source !== 'local' && r.source === 'local')) byName.set(r.name, r);
  }
  const deduped = [...byName.values()];

  cache = { at: Date.now(), rows: deduped };
  return deduped;
}

// Name matches count for more than tag matches, which count for more than a
// word appearing somewhere in a long description. Without this weighting a
// phrase like "check my disk space" ranks every play with "check" in its name
// above the one play that actually reads the disk.
const WEIGHT = { name: 6, tag: 3, description: 1 };

// Filler that appears in nearly every description and would otherwise let a
// phrase like "run the thing" match everything.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'can', 'you',
  'please', 'run', 'start', 'check', 'tell', 'about', 'from', 'are', 'was', 'its'
]);

export function rank(rows, phrase) {
  const terms = [...new Set(
    phrase.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOPWORDS.has(t))
  )];
  if (terms.length === 0) return [];

  return rows
    .map(r => {
      const name = r.name.toLowerCase();
      const tags = r.tags.join(' ').toLowerCase();
      const desc = r.description.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name.includes(t)) score += WEIGHT.name;
        if (tags.includes(t)) score += WEIGHT.tag;
        if (desc.includes(t)) score += WEIGHT.description;
      }
      return { ...r, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
