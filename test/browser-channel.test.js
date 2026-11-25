'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createBrowserChannel } = require('../src/browser-channel');
const { detect } = require('../src/capabilities');

const setup = (cfgOver) => {
  const posted = [];
  const cfg = Object.assign({ agentId: 'mac-1', browser: true }, cfgOver || {});
  const ch = createBrowserChannel({
    getConfig: () => cfg,
    postResult: async (b) => { posted.push(b); return { ok: true, status: 200 }; },
    log: () => {},
    version: 'test',
  });
  return { ch, posted, cfg };
};

const cmd = (over) => JSON.stringify(Object.assign({
  cmdId: 'cmd_' + Math.random().toString(36).slice(2, 12),
  agentId: 'mac-1',
  action: 'echo',
  args: { hello: 'world' },
  expiresAt: new Date(Date.now() + 60000).toISOString(),
}, over || {}));

test('echo round trip returns the args', async () => {
  const { ch, posted } = setup();
  const r = await ch.handle(cmd());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.result.echo, { hello: 'world' });
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].agentId, 'mac-1');
});

test('ping answers pong', async () => {
  const { ch } = setup();
  const r = await ch.handle(cmd({ action: 'ping' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result.pong, true);
});

test('browser off on this machine refuses', async () => {
  const { ch } = setup({ browser: false });
  const r = await ch.handle(cmd());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'browser_disabled');
});

test('a command for another machine is refused', async () => {
  const { ch } = setup();
  const r = await ch.handle(cmd({ agentId: 'other' }));
  assert.strictEqual(r.error, 'wrong_machine');
});

test('an expired command is refused', async () => {
  const { ch } = setup();
  const r = await ch.handle(cmd({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  assert.strictEqual(r.error, 'expired');
});

test('a replayed command id runs once', async () => {
  const { ch, posted } = setup();
  const c = cmd();
  await ch.handle(c);
  const again = await ch.handle(c);
  assert.strictEqual(again, null);
  assert.strictEqual(posted.length, 1);
});

test('unknown actions answer not_implemented', async () => {
  const { ch } = setup();
  const r = await ch.handle(cmd({ action: 'teleport' }));
  assert.strictEqual(r.error, 'not_implemented');
});

test('bad input is dropped without a post', async () => {
  const { ch, posted } = setup();
  assert.strictEqual(await ch.handle('not json'), null);
  assert.strictEqual(await ch.handle(JSON.stringify({ cmdId: 'x' })), null);
  assert.strictEqual(posted.length, 0);
});

test('oversized echo args are refused', async () => {
  const { ch } = setup();
  const r = await ch.handle(cmd({ args: 'x'.repeat(9000) }));
  assert.strictEqual(r.error, 'args_too_large');
});

test('browser capability is advertised only when enabled', () => {
  assert.ok(detect({ browser: true }).includes('browser'));
  assert.ok(!detect({ browser: false }).includes('browser'));
  assert.ok(!detect().includes('browser'));
});
