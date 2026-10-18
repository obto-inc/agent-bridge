'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ownedSessionIds, adoptedSessionIds, selectSyncSessions } = require('../src/sync-select');

const ADOPTED = 'fcb87456-aa7f-4cb2-9be6-75ee92214725';
const ADOPTED_CODEX = '11-29-019eae02-f509-7620-b92f-f025e59e8fba';
const FORKED = '097c4488-16ea-46ff-b74a-c6ed89cd72b7'; // resume under ext-claude-664ec599 got a new id
const SPAWNED = '9d959ac1-e04d-415a-94c0-655d1895ed8e'; // daemon-spawned for a bridge thread
const FREE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // never bound

const state = {
  bindings: {
    'ext-claude-fcb87456': { sessions: { claude: { sessionId: ADOPTED, projectDir: '/private/tmp/x/scratchpad' } } },
    'ext-codex-1129019e': { sessions: { codex: { sessionId: ADOPTED_CODEX } } },
    'ext-claude-664ec599': { sessions: { claude: { sessionId: FORKED } } },
    'OBTO MCP Design': { sessions: { claude: { sessionId: SPAWNED } } },
  },
};

const row = (sessionId, extra) => Object.assign({
  sessionId,
  source: 'claude',
  projectDir: '-Users-divyanshverma-WebstormProjects-trunk-OBTO-k8-nodes',
  projectName: '/Users/divyanshverma/WebstormProjects/trunk/OBTO/k8/nodes',
  title: 'A4 height-aware pagination',
  lastActivityAt: '2026-10-17T23:40:00.000Z',
  lastMessagePreview: 'pong',
}, extra || {});

test('ownedSessionIds covers every binding', () => {
  assert.deepEqual([...ownedSessionIds(state)].sort(), [ADOPTED, ADOPTED_CODEX, FORKED, SPAWNED].sort());
});

test('adoptedSessionIds keeps only the session the ext- thread was adopted from', () => {
  assert.deepEqual([...adoptedSessionIds(state)].sort(), [ADOPTED, ADOPTED_CODEX].sort());
});

test('an adopted (bridge-owned) session sends its metadata in sessions[]', () => {
  const all = [row(ADOPTED), row(FREE, { projectName: '/tmp/free' })];
  const { sessions, ownedSent } = selectSyncSessions(all, state);
  const sent = sessions.find((s) => s.sessionId === ADOPTED);
  assert.ok(sent, 'adopted session missing from the sync payload');
  assert.equal(sent.projectName, '/Users/divyanshverma/WebstormProjects/trunk/OBTO/k8/nodes');
  assert.equal(sent.title, 'A4 height-aware pagination');
  assert.equal(sent.lastActivityAt, '2026-10-17T23:40:00.000Z');
  assert.equal(sent.lastMessagePreview, 'pong');
  assert.equal(ownedSent, 1);
  assert.ok(sessions.some((s) => s.sessionId === FREE));
});

test('bridge-originated and forked owned sessions stay out (no duplicate canonical threads)', () => {
  const all = [row(SPAWNED), row(FORKED), row(ADOPTED_CODEX, { source: 'codex' })];
  const { sessions, ownedSent } = selectSyncSessions(all, state);
  assert.deepEqual(sessions.map((s) => s.sessionId), [ADOPTED_CODEX]);
  assert.equal(ownedSent, 1);
});

test('no bindings: everything scanned is sent', () => {
  const all = [row(ADOPTED), row(FREE), null, { title: 'no id' }];
  const { sessions, ownedSent } = selectSyncSessions(all, { bindings: {} });
  assert.deepEqual(sessions.map((s) => s.sessionId), [ADOPTED, FREE]);
  assert.equal(ownedSent, 0);
});

test('v1 flat bindings are still read', () => {
  const flat = { bindings: { 'ext-claude-fcb87456': { sessionId: ADOPTED }, legacy: { sessionId: SPAWNED } } };
  const { sessions } = selectSyncSessions([row(ADOPTED), row(SPAWNED)], flat);
  assert.deepEqual(sessions.map((s) => s.sessionId), [ADOPTED]);
});
