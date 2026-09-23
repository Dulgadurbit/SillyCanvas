// Set the release version everywhere it matters, in one go:
//   node tools/bump-version.mjs 0.3.0
//
// Browsers cache ES modules hard, so after an update people can keep running
// the old code. Every import between the extension's own files carries
// ?v=<version>, and manifest.json loads index.js the same way, so a new
// version is a new URL and the browser has to fetch it.
// Every file must use the SAME query for a given module, or the browser loads
// two copies of it with separate state — this script keeps them in step.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) { console.error('usage: node tools/bump-version.mjs 1.2.3'); process.exit(1); }

const mf = path.join(root, 'manifest.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
m.version = v;
m.js = `index.js?v=${v}`;
fs.writeFileSync(mf, JSON.stringify(m, null, 4) + '\n');

const files = ['index.js', ...fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => `src/${f}`)];
for (const f of files) {
    const p = path.join(root, f);
    const before = fs.readFileSync(p, 'utf8');
    const after = before.replace(/(from\s+['"])(\.{1,2}\/[^'"?]+\.js)(\?v=[^'"]*)?(['"])/g, `$1$2?v=${v}$4`);
    if (after !== before) fs.writeFileSync(p, after);
}
console.log(`version ${v}: manifest and ${files.length} files updated`);
