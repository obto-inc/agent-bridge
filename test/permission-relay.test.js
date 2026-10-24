'use strict';

// P0-3 — the permission relay must never resolve on a reply frame's text.
// Only the bridge's recorded human decision (consume) may allow a tool.
process.env.BRIDGE_RELAY_PERMISSIONS = '1';
process.env.BRIDGE_RELAY_TIMEOUT_MS = '600';
process.env.BRIDGE_PERM_POLL_MS = '40';

const test = require('node:test');
const assert = require('node:assert/strict');

const bridgeHttp = require('../src/bridge-http');
const driver = require('../src/claude-driver');
const { requestPermissionViaBridge, pendingPermissions } = driver._internal;

const log = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stub the bridge. `decision` is what consume answers next.
const bridge = { registered: [], posts: [], consumed: [], cancelled: [], register: { ok: true }, decision: { decision: 'pending' } };
bridgeHttp.requestPermission = async (b) => {
  bridge.registered.push(b);
  if (!bridge.register.ok) return { ok: false, status: 404, data: { error: 'not_found' } };
  return { ok: true, status: 200, data: { ok: true, registered: true, permId: b.permId } };
};
bridgeHttp.postMessage = async (b) => { bridge.posts.push(b); return { ok: true, status: 200, data: { ok: true } }; };
bridgeHttp.consumePermission = async (threadId, permId) => {
  bridge.consumed.push({ threadId, permId });
  const d = typeof bridge.decision === 'function' ? bridge.decision() : bridge.decision;
  return { ok: d.status ? d.status < 400 : true, status: d.status || 200, data: Object.assign({ ok: true, permId }, d) };
};
bridgeHttp.cancelPermission = async (permId) => { bridge.cancelled.push(permId); return { ok: true, status: 200, data: {} }; };

const reset = () => {
  bridge.registered = []; bridge.posts = []; bridge.consumed = []; bridge.cancelled = [];
  bridge.register = { ok: true }; bridge.decision = { decision: 'pending' };
  pendingPermissions.clear();
};

test('an agent frame saying "approve" does not approve; only the human decision does', async () => {
  reset();
  const p = requestPermissionViaBridge('t1', 'Bash', { command: 'rm -rf /tmp/x' }, log);
  await sleep(5);
  assert.equal(bridge.registered.length, 1);
  assert.match(bridge.registered[0].permId, /^perm-[a-f0-9]{16}$/);
  assert.equal(bridge.posts.length, 1);

  // The model's own bridge_post round-trips as a frame. It must not resolve.
  const handled = await driver.tryResolvePermission('t1', { role: 'agent', author: 'claude', body: 'approve' }, log);
  assert.equal(handled, true, 'frame is swallowed while pending');
  // Even a frame that claims to be human cannot approve by itself.
  await driver.tryResolvePermission('t1', { role: 'human', body: 'approve' }, log);
  assert.equal(pendingPermissions.has('t1'), true, 'still pending: no recorded decision');

  bridge.decision = { decision: 'allow', decidedBy: { kind: 'human', via: 'bridge_session' } };
  await driver.tryResolvePermission('t1', { role: 'human', body: 'approve' }, log);
  const r = await p;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedInput, { command: 'rm -rf /tmp/x' });
  assert.equal(pendingPermissions.has('t1'), false);
  assert.ok(bridge.consumed.every((c) => c.permId === bridge.registered[0].permId), 'bound to the request id');
});

test('a recorded human decision is found by the poll even when no frame arrives', async () => {
  reset();
  const p = requestPermissionViaBridge('t2', 'Bash', { command: 'ls' }, log);
  setTimeout(() => { bridge.decision = { decision: 'allow', decidedBy: { kind: 'human', via: 'devzone' } }; }, 60);
  const r = await p;
  assert.equal(r.behavior, 'allow');
});

test('an allow without a human decider is refused', async () => {
  reset();
  bridge.decision = { decision: 'allow', decidedBy: { kind: 'agent', via: 'bearer' } };
  const r = await requestPermissionViaBridge('t3', 'Bash', {}, log);
  assert.equal(r.behavior, 'deny');
});

test('a human denial denies', async () => {
  reset();
  bridge.decision = { decision: 'deny', decidedBy: { kind: 'human', via: 'bridge_session' } };
  const r = await requestPermissionViaBridge('t4', 'Write', {}, log);
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /declined/);
});

for (const d of ['expired', 'unknown', 'consumed']) {
  test('bridge answer "' + d + '" denies (single use, expiry)', async () => {
    reset();
    bridge.decision = { decision: d };
    const r = await requestPermissionViaBridge('t5', 'Bash', {}, log);
    assert.equal(r.behavior, 'deny');
  });
}

test('registration failure fails closed and posts no question', async () => {
  reset();
  bridge.register = { ok: false };
  const r = await requestPermissionViaBridge('t6', 'Bash', {}, log);
  assert.equal(r.behavior, 'deny');
  assert.equal(bridge.posts.length, 0);
});

test('no decision within the timeout denies and withdraws the request', async () => {
  reset();
  const r = await requestPermissionViaBridge('t7', 'Bash', {}, log);
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /timed out/);
  assert.equal(bridge.cancelled.length, 1);
});

test('frames on a thread with nothing pending fall through to a normal turn', async () => {
  reset();
  assert.equal(await driver.tryResolvePermission('t8', { role: 'human', body: 'approve' }, log), false);
});
