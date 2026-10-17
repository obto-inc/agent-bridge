'use strict';

// HOME points at a temp dir BEFORE the modules load: the scanner resolves
// ~/.claude/projects at require time. node --test runs each file in its own
// process, so this does not leak into other test files.
const fs = require('fs');
const path = require('path');
const { tmpDir, jsonl, userRec, assistantRec, REMINDER } = require('./helpers');

const home = tmpDir('agent-bridge-home-');
process.env.HOME = home;

const test = require('node:test');
const assert = require('node:assert/strict');

const bridgeHttp = require('../src/bridge-http');
const history = require('../src/history');

const SID = 'fcb87456-aa7f-4cb2-9be6-75ee92214725';
const projectDir = '-Users-me-trunk-OBTO-k8-nodes';
fs.mkdirSync(path.join(home, '.claude', 'projects', projectDir), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'projects', projectDir, SID + '.jsonl'), jsonl([
  userRec(REMINDER + '\nImplement A4 height-aware pagination'),
  assistantRec('Plan: measure each block.'),
  userRec(REMINDER),
  userRec('<command-name>/compact</command-name>\n<local-command-stdout>done</local-command-stdout>'),
  assistantRec('Compacted.'),
]));

const posts = [];
bridgeHttp.postExternalBackfill = async (threadId, sessionId, messages) => {
  posts.push({ threadId, sessionId, messages });
  return { ok: true, data: { inserted: messages.length, deduped: 0, removedPartial: 0 } };
};

// Run one backfill and wait for its terminal log line.
const runBackfill = (args) => new Promise((resolve) => {
  const lines = [];
  const log = (level, msg, data) => {
    lines.push({ level, msg, data });
    if (/^history backfill (complete|skipped|rejected|failed)|no local history/.test(msg)) resolve(lines);
  };
  history.backfillFullHistory(Object.assign({ log }, args));
});

test('cleanForBackfill strips harness wrappers and drops empty turns', () => {
  const out = history.cleanForBackfill([
    { role: 'user', body: REMINDER, ts: 't1' },
    { role: 'user', body: REMINDER + '\nreal question', ts: 't2' },
    { role: 'assistant', body: '  answer  ', ts: 't3' },
    { role: 'assistant', body: '', ts: 't4' },
    null,
  ]);
  assert.deepEqual(out, [
    { role: 'user', body: 'real question', ts: 't2' },
    { role: 'assistant', body: 'answer', ts: 't3' },
  ]);
});

test('reply consent is per thread', () => {
  assert.equal(history.mayShipBodies('ext-a', 'metadata'), false);
  history.recordReplyConsent('ext-a');
  assert.equal(history.mayShipBodies('ext-a', 'metadata'), true);
  assert.equal(history.mayShipBodies('ext-b', 'metadata'), false);
  assert.equal(history.mayShipBodies('ext-b', 'full'), true);
});

test('metadata discovery without a reply ships nothing', async () => {
  const before = posts.length;
  const lines = await runBackfill({
    threadId: 'ext-claude-noreply',
    externalAdoption: { sessionId: SID, source: 'claude', projectDir },
    discovery: 'metadata',
  });
  assert.match(lines[lines.length - 1].msg, /skipped/);
  assert.equal(posts.length, before);
});

test('a missing discovery value is treated as metadata', async () => {
  const before = posts.length;
  const lines = await runBackfill({
    threadId: 'ext-claude-nolevel',
    externalAdoption: { sessionId: SID, source: 'claude', projectDir },
  });
  assert.match(lines[lines.length - 1].msg, /skipped/);
  assert.equal(posts.length, before);
});

test('metadata discovery with a reply on the thread ships clean bodies', async () => {
  history.recordReplyConsent('ext-claude-fcb87456');
  const lines = await runBackfill({
    threadId: 'ext-claude-fcb87456',
    externalAdoption: { sessionId: SID, source: 'claude', projectDir },
    discovery: 'metadata',
  });
  assert.equal(lines[lines.length - 1].msg, 'history backfill complete');
  const sent = posts[posts.length - 1];
  assert.equal(sent.threadId, 'ext-claude-fcb87456');
  assert.deepEqual(sent.messages.map((m) => [m.role, m.body]), [
    ['user', 'Implement A4 height-aware pagination'],
    ['assistant', 'Plan: measure each block.\n\nCompacted.'],
  ]);
  const raw = JSON.stringify(sent.messages);
  assert.ok(!raw.includes('someone@example.com'));
  assert.ok(!raw.includes('system-reminder'));
  assert.ok(!raw.includes('command-name'));
});

test('full discovery ships without a reply', async () => {
  const before = posts.length;
  const lines = await runBackfill({
    threadId: 'ext-claude-full',
    externalAdoption: { sessionId: SID, source: 'claude', projectDir },
    discovery: 'full',
  });
  assert.equal(lines[lines.length - 1].msg, 'history backfill complete');
  assert.equal(posts.length, before + 1);
});
