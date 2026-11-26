'use strict';

// DZ-B1 B1-6 — the extension link (daemon side), the driver's routing to the
// extension, the native host relay, and the extension's shared files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createExtLink } = require('../src/browser-ext-link');
const { createBrowserDriver } = require('../src/browser-driver');

const ROOT = path.join(__dirname, '..');
const tmpSock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obx-')), 'e.sock');

// A fake extension on the daemon's socket: answers each cmd with handler(cmd).
const fakeExtension = (socketPath, handler) => new Promise((resolve) => {
  const s = net.createConnection(socketPath, () => {
    s.write(JSON.stringify({ type: 'hello', version: '0.1.0', browser: 'Chrome/142' }) + '\n');
    resolve(s);
  });
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.type === 'cmd') s.write(JSON.stringify(Object.assign({ type: 'res', id: m.id }, handler(m))) + '\n');
    }
  });
});

const until = async (fn, ms) => {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
  return false;
};

test('extension copies of the guards and page files match src', () => {
  for (const f of ['browser-guards.js', 'browser-page.js']) {
    assert.strictEqual(fs.readFileSync(path.join(ROOT, 'extension', 'lib', f), 'utf8'), fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), f);
  }
});

test('extension manifest: pinned id, no cookie / history / debugger permissions', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.strictEqual(m.manifest_version, 3);
  assert.ok(m.key && m.key.length > 300);
  for (const p of ['cookies', 'history', 'debugger', 'webRequest', 'downloads', 'management', 'proxy']) assert.ok(m.permissions.indexOf(p) === -1, p);
  const crypto = require('crypto');
  const h = crypto.createHash('sha256').update(Buffer.from(m.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...h].map((x) => String.fromCharCode(97 + parseInt(x, 16))).join('');
  assert.strictEqual(id, fs.readFileSync(path.join(ROOT, 'extension', 'EXTENSION_ID'), 'utf8').trim());
});

test('ext link: not connected until hello; request round trip; stop event', async () => {
  const link = createExtLink({ socketPath: tmpSock() });
  assert.ok(await link.start());
  assert.strictEqual(fs.statSync(link.socketPath).mode & 0o777, 0o600);
  assert.strictEqual(link.connected(), false);
  assert.deepStrictEqual(await link.request({ action: 'read' }, 1000), { ok: false, error: 'extension_not_connected' });
  let stops = 0;
  link.onStop(() => { stops += 1; });
  const ext = await fakeExtension(link.socketPath, (m) => ({ ok: true, result: { echoed: m.action, grants: m.grants } }));
  assert.ok(await until(() => link.connected()));
  const r = await link.request({ action: 'read', args: {}, grants: { 'a.com': 'read' } }, 2000);
  assert.deepStrictEqual(r, { ok: true, result: { echoed: 'read', grants: { 'a.com': 'read' } } });
  ext.write(JSON.stringify({ type: 'stop' }) + '\n');
  assert.ok(await until(() => stops === 1));
  ext.destroy();
  assert.ok(await until(() => !link.connected()));
  link.close();
});

test('ext link: a pending request fails when the extension disconnects', async () => {
  const link = createExtLink({ socketPath: tmpSock() });
  await link.start();
  const ext = await fakeExtension(link.socketPath, () => null);
  await until(() => link.connected());
  ext.removeAllListeners('data'); // never answers
  const p = link.request({ action: 'read' }, 5000);
  setTimeout(() => ext.destroy(), 50);
  assert.deepStrictEqual(await p, { ok: false, error: 'extension_disconnected' });
  link.close();
});

test('driver routes page actions to the extension, keeps grants, Stop and audit local', async () => {
  const link = createExtLink({ socketPath: tmpSock() });
  await link.start();
  const seen = [];
  const ext = await fakeExtension(link.socketPath, (m) => {
    seen.push(m);
    if (m.action === 'open') return { ok: true, result: { tab: 't1', url: 'https://a.com/x', title: 'A' } };
    return { ok: false, error: 'site_not_granted', site: 'b.com', message: 'no' };
  });
  await until(() => link.connected());
  const auditPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oba-')), 'audit.jsonl');
  let launched = 0;
  const driver = createBrowserDriver({ ext: link, auditPath, launcher: async () => { launched += 1; throw new Error('no'); } });
  const exp = new Date(Date.now() + 20000).toISOString();
  const cfg = { browserGrants: { 'a.com': 'read' } };

  const r1 = await driver.run({ cmdId: 'c1', runId: 'r1', action: 'open', args: { url: 'https://a.com/x?secret=1' }, expiresAt: exp }, cfg);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.result.where, 'my_browser');
  assert.strictEqual(launched, 0, 'the OBTO profile window is not launched');
  assert.deepStrictEqual(seen[0].grants, { 'a.com': 'read' });

  // A run grant from a DevZone card reaches the extension with the command.
  await driver.run({ cmdId: 'c2', runId: 'r1', action: 'grant', args: { site: 'b.com', level: 'act', scope: 'run' }, expiresAt: exp }, cfg);
  const r3 = await driver.run({ cmdId: 'c3', runId: 'r1', action: 'click', args: { target: '3' }, expiresAt: exp }, cfg);
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.error, 'site_not_granted');
  assert.strictEqual(seen[1].grants['b.com'], 'act');

  // Stop in the extension ends the run.
  ext.write(JSON.stringify({ type: 'stop' }) + '\n');
  await new Promise((r) => setTimeout(r, 100));
  const r4 = await driver.run({ cmdId: 'c4', runId: 'r1', action: 'read', args: {}, expiresAt: exp }, cfg);
  assert.strictEqual(r4.error, 'stopped_by_user');
  assert.strictEqual(seen.length, 2, 'a stopped run never reaches the extension');

  const rows = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows[0].url, 'https://a.com/x');
  assert.ok(!fs.readFileSync(auditPath, 'utf8').includes('secret'));

  // browserTarget "profile" bypasses the extension.
  const r5 = await driver.run({ cmdId: 'c5', runId: 'r2', action: 'open', args: { url: 'https://a.com/' }, expiresAt: exp }, { browserGrants: { 'a.com': 'read' }, browserTarget: 'profile' });
  assert.strictEqual(r5.ok, false);
  assert.strictEqual(launched, 1);
  assert.strictEqual(seen.length, 2);
  ext.destroy();
  link.close();
});

test('native host relays Chrome frames to the daemon socket and back', async () => {
  const link = createExtLink({ socketPath: tmpSock() });
  await link.start();
  const host = spawn(process.execPath, [path.join(ROOT, 'bin', 'obto-bridge-native-host.js')], { env: Object.assign({}, process.env, { OBTO_BRIDGE_EXT_SOCK: link.socketPath }) });
  const frames = [];
  let buf = Buffer.alloc(0);
  host.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const n = buf.readUInt32LE(0);
      frames.push(JSON.parse(buf.slice(4, 4 + n).toString('utf8')));
      buf = buf.slice(4 + n);
    }
  });
  const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0); host.stdin.write(Buffer.concat([h, b])); };
  frame({ type: 'hello', version: '0.1.0', browser: 'Chrome/142' });
  assert.ok(await until(() => link.connected(), 3000));
  const p = link.request({ action: 'tabs', args: {}, grants: {} }, 3000);
  assert.ok(await until(() => frames.some((f) => f.type === 'cmd'), 3000));
  const cmd = frames.find((f) => f.type === 'cmd');
  frame({ type: 'res', id: cmd.id, ok: true, result: { tabs: [] } });
  assert.deepStrictEqual(await p, { ok: true, result: { tabs: [] } });
  host.kill();
  link.close();
});

test('pack script builds a store zip without key, and refuses remote code', () => {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pack-extension.js')], { encoding: 'utf8' });
  assert.match(out, /Packed dist\/obto-agent-\d+\.\d+\.\d+\.zip/);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const zipped = JSON.parse(execFileSync('unzip', ['-p', path.join(ROOT, 'dist', 'obto-agent-' + m.version + '.zip'), 'manifest.json'], { encoding: 'utf8' }));
  assert.strictEqual(zipped.key, undefined);
  assert.strictEqual(zipped.version, m.version);
  assert.ok(m.description.length <= 132);
  for (const f of fs.readdirSync(path.join(ROOT, 'extension')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'extension', f), 'utf8');
    assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(src), f);
  }
});
