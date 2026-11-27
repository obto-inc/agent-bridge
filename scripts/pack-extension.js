'use strict';
// Builds dist/obto-agent-<version>.zip for the Chrome Web Store from extension/.
// Refuses to pack when a store rule would be broken:
//   - lib/ copies differ from src/ (the daemon and the extension must share guards);
//   - any packaged script uses eval, new Function, importScripts of a URL, or a
//     remote <script src> (no remote code, Blue Argon);
//   - an icon or a manifest field the store needs is missing.
// The `key` field and EXTENSION_ID are left out: the store assigns the item id.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const problems = [];

for (const f of ['browser-guards.js', 'browser-page.js']) {
  if (fs.readFileSync(path.join(EXT, 'lib', f), 'utf8') !== fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')) problems.push('extension/lib/' + f + ' differs from src/' + f + ' (copy it)');
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) problems.push('manifest version must be x.y.z');
if (!manifest.description || manifest.description.length > 132) problems.push('manifest description must be 1-132 characters');
for (const s of ['16', '32', '48', '128']) if (!manifest.icons || !fs.existsSync(path.join(EXT, manifest.icons[s] || '-'))) problems.push('icon ' + s + ' missing');

const files = [];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return walk(p);
  const rel = path.relative(EXT, p);
  if (rel === 'EXTENSION_ID' || rel === 'STORE_ID' || d.name.startsWith('.')) return;
  files.push(rel);
});
walk(EXT);

for (const rel of files) {
  if (!/\.(js|html)$/.test(rel)) continue;
  const src = fs.readFileSync(path.join(EXT, rel), 'utf8');
  if (/\beval\s*\(/.test(src)) problems.push(rel + ': eval(');
  if (/new\s+Function\s*\(/.test(src)) problems.push(rel + ': new Function(');
  if (/importScripts\(\s*['"]https?:/.test(src)) problems.push(rel + ': importScripts of a URL');
  if (/<script[^>]+src=["']https?:/i.test(src)) problems.push(rel + ': remote <script src>');
}

if (problems.length) {
  console.error('Not packed:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// Stage a copy without `key`, then zip it.
const stage = fs.mkdtempSync(path.join(require('os').tmpdir(), 'obto-ext-'));
for (const rel of files) {
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.copyFileSync(path.join(EXT, rel), path.join(stage, rel));
}
const m = Object.assign({}, manifest);
delete m.key;
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
fs.mkdirSync(DIST, { recursive: true });
const zip = path.join(DIST, 'obto-agent-' + manifest.version + '.zip');
try { fs.unlinkSync(zip); } catch (_) {}
execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });
console.log('Packed ' + path.relative(ROOT, zip) + ' (' + files.length + ' files, no key).');
