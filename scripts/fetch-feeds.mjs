// Runs in GitHub Actions: fetches every channel's feed and writes docs/feeds.json.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8')
  .replace('export default', 'const _handler =') + '\nexport { loadAll };';
fs.writeFileSync('/tmp/feedlib.mjs', src);
const { loadAll } = await import('/tmp/feedlib.mjs');
const data = await loadAll(null);
data.articles.sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
data.articles = data.articles.slice(0, 400);
fs.writeFileSync('docs/feeds.json', JSON.stringify(data));
console.log('channels:', data.channels.map((c) => c.id + '=' + c.status).join(' '));
console.log('articles:', data.articles.length);
