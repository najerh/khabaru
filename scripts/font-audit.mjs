// Research: how each channel sets Thaana type. Fetches homepage + one article + stylesheets,
// writes research/fonts.json. Run by .github/workflows/font-audit.yml.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8')
  .replace('export default', 'const _handler =') + '\nexport { get, CHANNELS, isThaana, strip };';
fs.writeFileSync('/tmp/feedlib2.mjs', src);
const { get, CHANNELS, isThaana, strip } = await import('/tmp/feedlib2.mjs');

let feed = { articles: [] };
try { feed = JSON.parse(fs.readFileSync('docs/feeds.json', 'utf8')); } catch {}

const PROPS = ['font-family', 'font-size', 'line-height', 'font-weight', 'letter-spacing', 'word-spacing', 'text-align', 'color', 'direction'];
function decls(body) {
  const o = {};
  for (const d of body.split(';')) {
    const i = d.indexOf(':'); if (i < 0) continue;
    const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim();
    if (PROPS.includes(k) || k === 'font') o[k] = v.slice(0, 120);
  }
  return o;
}
function classesOf(tag) { const m = tag.match(/class\s*=\s*["']([^"']*)["']/i); return m ? m[1].split(/\s+/).filter(Boolean) : []; }
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/:]/g, '\\$&'); }

async function audit(c) {
  const out = { id: c.id, home: c.home };
  const home = await get(c.home);
  if (!home) { out.error = 'home not reachable'; return out; }
  let artUrl = (feed.articles.find((a) => a.channel === c.id) || {}).url;
  if (!artUrl) {
    for (const m of home.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = (m[1].match(/href\s*=\s*["']([^"'#]+)/i) || [])[1]; const t = strip(m[2]);
      if (href && t.length > 20 && isThaana(t) && /\d{3,}/.test(href)) { try { artUrl = new URL(href, c.home).toString(); break; } catch {} }
    }
  }
  const art = artUrl ? await get(artUrl) : null;
  out.article = artUrl || null;
  out.generator = (home.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i) || [])[1] || null;
  out.htmlAttrs = (home.match(/<html\b[^>]*>/i) || [''])[0].slice(0, 200);
  out.bodyAttrs = (home.match(/<body\b[^>]*>/i) || [''])[0].slice(0, 300);

  // stylesheets
  const pages = [home, art || ''];
  const hrefs = new Set(); let css = '';
  for (const pg of pages) {
    for (const m of pg.matchAll(/<link\b[^>]*>/gi)) {
      if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(m[0])) continue;
      const h = (m[0].match(/href\s*=\s*["']([^"']+)/i) || [])[1];
      if (h) { try { hrefs.add(new URL(h, c.home).toString()); } catch {} }
    }
    for (const m of pg.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += '\n' + m[1];
  }
  out.stylesheets = [...hrefs].slice(0, 12);
  for (const h of out.stylesheets.slice(0, 8)) { const t = await get(h, 900000); if (t) css += '\n' + t; }
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  out.cssBytes = css.length;

  // @font-face
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const fam = (m[1].match(/font-family\s*:\s*([^;]+)/i) || [])[1];
    const w = (m[1].match(/font-weight\s*:\s*([^;]+)/i) || [])[1];
    const files = [...m[1].matchAll(/url\(([^)]+)\)/gi)].map((x) => x[1].replace(/["']/g, '').split('/').pop().split('?')[0]).slice(0, 2);
    if (fam) faces.push({ family: fam.trim().replace(/["']/g, ''), weight: (w || '').trim(), files });
  }
  const seen = new Set(); out.fontFaces = faces.filter((f) => { const k = f.family + f.weight + f.files[0]; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);

  // font-family usage counts
  const fam = {};
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) { const k = m[1].trim().replace(/\s+/g, ' ').slice(0, 90); fam[k] = (fam[k] || 0) + 1; }
  out.familyUse = Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 12);

  // rules for the elements that matter
  const rules = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (sel.length > 160) continue;
    const d = decls(m[2]); if (!Object.keys(d).length) continue;
    rules.push([sel, d]);
  }
  const want = /(^|[\s,>])(html|body|h1|h2|h3|p|a)([\s,.:>{]|$)|title|headline|heading|article|content|news|post|card|dhivehi|thaana|waheed|faruma|faseyha|typo|text-/i;
  out.keyRules = rules.filter(([s, d]) => want.test(s) && (d['font-family'] || d['font-size'] || d['line-height'] || d.font)).slice(0, 90);

  // what the real headline / paragraph elements use
  function probe(html, re, label) {
    const m = html && html.match(re); if (!m) return null;
    const cls = classesOf(m[0]);
    const hits = [];
    for (const k of cls) for (const [s, d] of rules) if (new RegExp('\\.' + esc(k) + '(?![\\w-])').test(s)) { hits.push([s, d]); if (hits.length > 14) break; }
    return { label, tag: m[0].slice(0, 220), text: strip(m[0] + (m[1] || '')).slice(0, 80), classes: cls, rules: hits.slice(0, 14) };
  }
  out.probes = [
    probe(art, /<h1\b[^>]*>([\s\S]{0,400}?)<\/h1>/i, 'article h1'),
    probe(art, /<p\b[^>]*>([^<]{120,})/i, 'article paragraph'),
    probe(art, /<(article|main)\b[^>]*>/i, 'article container'),
    probe(home, /<h[1-3]\b[^>]*>([\s\S]{0,300}?)<\/h[1-3]>/i, 'home first heading'),
  ].filter(Boolean);
  return out;
}

const res = [];
for (const c of CHANNELS) { try { res.push(await audit(c)); } catch (e) { res.push({ id: c.id, error: String(e) }); } }
fs.mkdirSync('research', { recursive: true });
fs.writeFileSync('research/fonts.json', JSON.stringify({ at: new Date().toISOString(), sites: res }, null, 1));
console.log(res.map((r) => r.id + ':' + (r.error || (r.fontFaces || []).length + ' faces')).join(' | '));
