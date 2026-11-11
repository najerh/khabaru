// Runs in GitHub Actions: fetches every channel's feed, adds article text, writes docs/feeds.json.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8')
  .replace('export default', 'const _handler =') + '\nexport { loadAll, get, extractBody, clip, CHANNELS, EXCERPT_MAX, FULL_MAX };';
fs.writeFileSync('/tmp/feedlib.mjs', src);
const { loadAll, get, extractBody, clip, CHANNELS, EXCERPT_MAX, FULL_MAX } = await import('/tmp/feedlib.mjs');

const data = await loadAll(null);
data.articles.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
data.articles = data.articles.slice(0, 400);

// Article text: reuse what the last run stored, fetch pages only for new articles.
const prev = new Map();
const prevLogo = new Map();
try {
  const old = JSON.parse(fs.readFileSync('docs/feeds.json', 'utf8'));
  for (const a of old.articles) if (a.body || a.tried) prev.set(a.url, a);
  for (const c of old.channels) if (c.logo) prevLogo.set(c.id, c.logo);
} catch {}

// Channel logos: each site's own app icon (apple-touch-icon, else favicon).
await Promise.all(data.channels.map(async (ch) => {
  if (prevLogo.has(ch.id)) { ch.logo = prevLogo.get(ch.id); return; }
  const c = CHANNELS.find((x) => x.id === ch.id);
  const html = await get(c.home, 80000);
  let best = null, bestScore = -1;
  for (const m of (html || '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (tag.match(/rel\s*=\s*["']([^"']+)/i) || [])[1] || '';
    const href = (tag.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    if (!href || !/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
    const size = +((tag.match(/sizes\s*=\s*["'](\d+)/i) || [])[1] || 0);
    const score = (/apple-touch/i.test(rel) ? 1000 : 0) + size + (/\.svg/i.test(href) ? 500 : 0);
    if (score > bestScore) { bestScore = score; best = href; }
  }
  try { ch.logo = new URL(best || '/favicon.ico', c.home).toString(); } catch { ch.logo = null; }
}));
const fullText = new Set(CHANNELS.filter((c) => c.fullText).map((c) => c.id));
const todo = [];
for (const a of data.articles) {
  if (a.body) continue;
  const old = prev.get(a.url);
  if (old && !!old.full === fullText.has(a.channel)) { a.body = old.body || ''; a.full = !!old.full; if (old.tried) a.tried = 1; if (!a.image && old.image) a.image = old.image; continue; }
  todo.push(a);
}
const MAX_NEW = 80; // per run, to stay gentle on the publishers
const queue = todo.slice(0, MAX_NEW);
let fetched = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  for (;;) {
    const a = queue.shift();
    if (!a) return;
    const html = await get(a.url);
    a.tried = 1; // remember, so pages with no readable text are not refetched every run
    if (!html) continue;
    const paras = extractBody(html);
    const full = fullText.has(a.channel);
    a.body = clip(paras, full ? FULL_MAX : EXCERPT_MAX);
    a.full = full && paras.length > 0;
    if (!a.image) { const m = html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i); if (m) a.image = m[1]; }
    fetched++;
  }
}));

fs.writeFileSync('docs/feeds.json', JSON.stringify(data));
console.log('channels:', data.channels.map((c) => c.id + '=' + c.status).join(' '));
console.log('articles:', data.articles.length, '| with text:', data.articles.filter((a) => a.body).length, '| pages fetched:', fetched, '| waiting:', Math.max(0, todo.length - MAX_NEW));
