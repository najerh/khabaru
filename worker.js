/**
 * Khabaru feed proxy - Cloudflare Worker.
 *
 * GET /feeds        -> JSON { fetchedAt, channels:[{id,status,feedUrl}], articles:[...] }
 * GET /feeds?fresh=1 -> skip the 5-minute cache
 *
 * Deploy: npm i -g wrangler && wrangler login && wrangler deploy
 * (wrangler.toml beside this file). Free tier is plenty for one app.
 */

const CHANNELS = [
  { id: 'mihaaru', home: 'https://mihaaru.com' },
  { id: 'sun', home: 'https://sun.mv' },
  { id: 'avas', home: 'https://avas.mv' },
  { id: 'dhauru', home: 'https://dhauru.com' },
  { id: 'adhadhu', home: 'https://adhadhu.com' },
  { id: 'psm', home: 'https://psmnews.mv' },
  { id: 'raajje', home: 'https://raajje.mv' },
  { id: 'vaguthu', home: 'https://vaguthu.mv' },
  { id: 'thepress', home: 'https://thepress.mv' },
  { id: 'dhen', home: 'https://dhen.mv' },
  // Known feed address? Add feed: 'https://.../rss' and discovery is skipped.
];

const CANDIDATE_PATHS = ['/rss', '/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/feeds', '/rss/latest', '/api/rss', '/feed/rss', '/dv/rss', '/dv/feed'];
const CACHE_SECONDS = 300;
const UA = 'Khabaru/0.1 (+news reader)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname !== '/feeds') {
      return new Response('Khabaru feed proxy. GET /feeds', { headers: CORS });
    }
    const cache = caches.default;
    const cacheKey = new Request(url.origin + '/feeds', request);
    if (!url.searchParams.has('fresh')) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const body = JSON.stringify(await loadAll(env));
    const res = new Response(body, {
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};

async function loadAll(env) {
  const results = await Promise.all(CHANNELS.map((c) => loadChannel(c, env)));
  return {
    fetchedAt: new Date().toISOString(),
    channels: results.map((r) => ({ id: r.id, status: r.status, feedUrl: r.feedUrl })),
    articles: results.flatMap((r) => r.articles),
  };
}

async function loadChannel(c, env) {
  const feedUrl = c.feed || (await discover(c, env));
  if (!feedUrl) return { id: c.id, status: 'noFeed', feedUrl: null, articles: [] };
  const xml = await get(feedUrl);
  if (!xml) return { id: c.id, status: 'fetchFailed', feedUrl, articles: [] };
  const articles = parseFeed(xml, c.id);
  return { id: c.id, status: articles.length ? 'ok' : 'fetchFailed', feedUrl, articles };
}

// Feed discovery, remembered in KV when bound (wrangler.toml), else per request.
async function discover(c, env) {
  const kvKey = 'feed:' + c.id;
  if (env && env.FEEDS) {
    const saved = await env.FEEDS.get(kvKey);
    if (saved === '-') return null;
    if (saved) return saved;
  }
  let found = null;
  const html = await get(c.home);
  if (html) {
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/type\s*=\s*["']application\/(rss|atom)\+xml/i.test(tag)) continue;
      const href = (tag.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
      if (!href) continue;
      const u = new URL(href, c.home).toString();
      if (await isFeed(u)) { found = u; break; }
    }
  }
  if (!found) {
    for (const p of CANDIDATE_PATHS) {
      const u = new URL(p, c.home).toString();
      if (await isFeed(u)) { found = u; break; }
    }
  }
  if (env && env.FEEDS) await env.FEEDS.put(kvKey, found || '-', { expirationTtl: found ? 7 * 86400 : 3600 });
  return found;
}

async function isFeed(u) {
  const t = await get(u, 4000);
  return !!t && /<(rss|feed|rdf:RDF)\b/.test(t.trimStart());
}

async function get(u, maxChars) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, text/html, */*' }, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    return maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return null;
  }
}

// --- RSS / Atom parsing with regex (Workers have no DOMParser) ---

function parseFeed(xml, channelId) {
  let items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  if (!items.length) items = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const out = [];
  for (const it of items) {
    const title = strip(tag(it, 'title'));
    const link = linkOf(it);
    if (!title || !link) continue;
    if (!isThaana(title)) continue; // Dhivehi only: drop English and romanised items
    const rawDesc = tag(it, 'description') || tag(it, 'summary') || tag(it, 'content:encoded') || tag(it, 'content') || '';
    const cats = [...it.matchAll(/<category\b([^>]*)>([\s\S]*?)<\/category>|<category\b[^>]*term\s*=\s*["']([^"']+)["'][^>]*\/>/gi)]
      .map((m) => (m[3] || m[2] || '').trim()).join(' ');
    const date = tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date');
    const ts = Date.parse(date);
    out.push({
      channel: channelId,
      title,
      summary: strip(rawDesc).slice(0, 400),
      url: link,
      published: Number.isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString(),
      hint: (cats + ' ' + link).toLowerCase(),
      image: imageOf(it, rawDesc),
    });
  }
  return out;
}

function tag(s, name) {
  const m = s.match(new RegExp('<' + name.replace(':', '\\:') + '\\b[^>]*>([\\s\\S]*?)<\\/' + name.replace(':', '\\:') + '>', 'i'));
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

function linkOf(it) {
  for (const m of it.matchAll(/<link\b([^>]*)>([\s\S]*?)<\/link>|<link\b([^>]*)\/>/gi)) {
    const attrs = m[1] || m[3] || '';
    const href = (attrs.match(/href\s*=\s*["']([^"']+)/i) || [])[1];
    if (href && !/rel\s*=\s*["'](self|replies|enclosure)/i.test(attrs)) return href.trim();
    const t = (m[2] || '').trim();
    if (t) return t;
  }
  return tag(it, 'guid');
}

function imageOf(it, rawDesc) {
  for (const m of it.matchAll(/<(media:content|media:thumbnail|enclosure)\b([^>]*)>/gi)) {
    const attrs = m[2];
    const url = (attrs.match(/url\s*=\s*["']([^"']+)/i) || [])[1];
    const type = (attrs.match(/type\s*=\s*["']([^"']+)/i) || [])[1] || '';
    if (!url) continue;
    if (m[1].toLowerCase() === 'enclosure' && type && !type.startsWith('image')) continue;
    return url;
  }
  const m = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

// True when most letters in the text are Thaana (U+0780-U+07B1).
function isThaana(text) {
  let th = 0, latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x0780 && c <= 0x07b1) th++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  return th > 0 && th >= latin * 2;
}

function strip(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, ' ')
    .trim();
}
