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
  { id: 'dhauru', home: 'https://dhauru.com', scrape: true }, // its RSS is romanised; scrape Thaana pages instead
  { id: 'adhadhu', home: 'https://adhadhu.com' },
  { id: 'psm', home: 'https://psmnews.mv' },
  { id: 'raajje', home: 'https://raajje.mv' },
  { id: 'vaguthu', home: 'https://vaguthu.mv' },
  { id: 'thepress', home: 'https://thepress.mv' },
  { id: 'dhen', home: 'https://dhen.mv' },
  { id: 'vnews', home: 'https://vnews.mv' },
  { id: 'dhiyares', home: 'https://dhiyares.com' },
  { id: 'adhives', home: 'https://adhives.mv' },
  { id: 'hoara', home: 'https://hoara.mv' },
  { id: 'mmtv', home: 'https://mmtv.mv' },
  { id: 'dhuvas', home: 'https://dhuvas.mv' },
  { id: 'cnm', home: 'https://cnm.mv' },
  { id: 'oneonline', home: 'https://oneonline.mv' },
  { id: 'hama', home: 'https://hama.mv' },
  { id: 'voice', home: 'https://voice.mv' },
  // Known feed address? Add feed: 'https://.../rss' and discovery is skipped.
];

const CANDIDATE_PATHS = [
  '/rss', '/feed', '/feed/', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feeds', '/rss/latest', '/rss/all',
  '/api/rss', '/feed/rss', '/?feed=rss2', '/?feed=atom', '/news/feed', '/category/news/feed', '/dv/rss', '/dv/feed', '/dv/feed/',
  // Google News sitemaps: headlines + times, published by sites that have no RSS.
  '/news-sitemap.xml', '/sitemap-news.xml', '/news_sitemap.xml', '/sitemap/news.xml', '/googlenews.xml',
];
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
  if (!c.scrape) {
    const feedUrl = c.feed || (await discover(c, env));
    if (feedUrl) {
      const xml = await get(feedUrl);
      const articles = xml ? parseFeed(xml, c.id) : [];
      if (articles.length) return { id: c.id, status: 'ok', feedUrl, articles };
    }
  }
  // No usable feed: scrape the homepage for Thaana headlines.
  const articles = await scrapeSite(c);
  return { id: c.id, status: articles.length ? 'scraped' : 'noFeed', feedUrl: null, articles };
}

// --- Generic scraper: homepage links with Thaana text, then og: metadata per article ---

const SCRAPE_MAX = 20;

async function scrapeSite(c) {
  const html = await get(c.home);
  if (!html) return [];
  const host = new URL(c.home).hostname.replace(/^www\./, '');
  const seen = new Set();
  const picks = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1].match(/href\s*=\s*["']([^"'#]+)/i) || [])[1];
    if (!href) continue;
    const rel = relTime(strip(m[2]));
    const text = cleanHeadline(strip(m[2]));
    if (text.length < 12 || !isThaana(text)) continue;
    let u;
    try { u = new URL(href, c.home); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    const path = u.pathname;
    // Article pages have an id or a long slug; category pages don't.
    if (!/\d{3,}/.test(path) && path.length < 25) continue;
    u.search = ''; u.hash = '';
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ url: key, title: text, rel });
    if (picks.length >= SCRAPE_MAX) break;
  }
  const out = await Promise.all(picks.map(async (p) => {
    const page = await get(p.url, 60000);
    const meta = page ? ogMeta(page) : {};
    // Prefer og:title (link text often carries a category label); drop a trailing " - Site name".
    const cleaned = cleanTitle(meta.title);
    const title = cleaned && isThaana(cleaned) ? cleaned : p.title;
    let ts = Date.parse(meta.published || '');
    if (Number.isNaN(ts) && p.rel != null) ts = Date.now() - p.rel * 60000;
    return {
      channel: c.id, title: cleanHeadline(title), summary: meta.description || '', url: p.url,
      published: Number.isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString(),
      hint: (meta.section + ' ' + p.url).toLowerCase(), image: meta.image || null,
    };
  }));
  return out;
}

// "... - 2 ގަޑިއިރު ކުރިން" -> minutes ago, or null.
const REL = /(\d+)\s*(ސިކުންތު|މިނެޓު|މިނިޓު|ގަޑިއިރު|ދުވަސް|ހަފްތާ|މަސް|އަހަރު)\s*ކުރިން/;
const REL_MIN = { 'ސިކުންތު': 1 / 60, 'މިނެޓު': 1, 'މިނިޓު': 1, 'ގަޑިއިރު': 60, 'ދުވަސް': 1440, 'ހަފްތާ': 10080, 'މަސް': 43200, 'އަހަރު': 525600 };
function relTime(t) {
  const m = t.match(REL);
  return m ? Math.round(+m[1] * REL_MIN[m[2]]) : null;
}
// Drop relative-time tails, leftover code and stray arrows/dashes from link text.
function cleanHeadline(t) {
  return t
    .replace(/\s*[-–—|·]?\s*\d+\s*(ސިކުންތު|މިނެޓު|މިނިޓު|ގަޑިއިރު|ދުވަސް|ހަފްތާ|މަސް|އަހަރު)\s*ކުރިން.*$/, '')
    .replace(/['"]?\s*\.?\s*\$[A-Za-z_][\s\S]*$/, '') // leaked server template code
    .replace(/(<-+|-+>|<!-+|-+>)/g, ' ')
    .replace(/[\s'".·|–—-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(t) {
  if (!t) return '';
  const m = t.match(/^(.*\S)\s+[-|–—]\s+[^-|–—]+$/);
  return m && m[1].length >= 12 ? m[1] : t;
}

function ogMeta(html) {
  const head = html.slice(0, 60000);
  const pick = (names) => {
    for (const n of names) {
      const re = new RegExp('<meta\\b[^>]*(?:property|name)\\s*=\\s*["\']' + n.replace(/[.:]/g, '\\$&') + '["\'][^>]*content\\s*=\\s*["\']([^"\']*)["\']', 'i');
      const re2 = new RegExp('<meta\\b[^>]*content\\s*=\\s*["\']([^"\']*)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + n.replace(/[.:]/g, '\\$&') + '["\']', 'i');
      const m = head.match(re) || head.match(re2);
      if (m && m[1]) return strip(m[1]);
    }
    return '';
  };
  let published = pick(['article:published_time', 'og:article:published_time', 'datePublished', 'pubdate', 'publish-date', 'date']);
  if (!published) {
    const ld = head.match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (ld) published = ld[1];
  }
  return {
    title: pick(['og:title', 'twitter:title']),
    description: pick(['og:description', 'description', 'twitter:description']).slice(0, 400),
    image: pick(['og:image', 'og:image:url', 'twitter:image']),
    published,
    section: pick(['article:section']),
  };
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
  if (!t) return false;
  const head = t.trimStart();
  if (/<(rss|feed|rdf:RDF)\b/.test(head)) return true;
  // A news sitemap counts only if it carries headlines.
  return /<urlset\b/.test(head) && /<news:news>|<news:title>/.test(t);
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
  if (/<urlset\b/.test(xml) && /<news:title>/.test(xml)) return parseNewsSitemap(xml, channelId);
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

// Google News sitemap: <url><loc/><news:news><news:title/><news:publication_date/></news:news><image:image><image:loc/></image:image></url>
function parseNewsSitemap(xml, channelId) {
  const out = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const u = m[1];
    const link = tag(u, 'loc');
    const title = strip(tag(u, 'news:title'));
    if (!link || !title || !isThaana(title)) continue;
    const ts = Date.parse(tag(u, 'news:publication_date') || tag(u, 'lastmod'));
    const img = (u.match(/<image:loc>([\s\S]*?)<\/image:loc>/i) || [])[1];
    const kw = tag(u, 'news:keywords');
    out.push({
      channel: channelId, title, summary: '', url: link.trim(),
      published: Number.isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString(),
      hint: (kw + ' ' + link).toLowerCase(), image: img ? img.trim() : null,
    });
  }
  return out.slice(0, 60);
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
    .replace(/<!--[\s\S]*?-->/g, ' ') // comments first: they may contain ">"
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, ' ')
    .trim();
}
