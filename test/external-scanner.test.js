'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scanner = require('../src/external-scanner');
const { tmpDir, jsonl, userRec, assistantRec, REMINDER } = require('./helpers');

test('encodeClaudeProjectDir replaces every non-alphanumeric with "-"', () => {
  assert.equal(
    scanner.encodeClaudeProjectDir('/Users/me/trunk/OBTO/k8/nodes'),
    '-Users-me-trunk-OBTO-k8-nodes',
  );
  assert.equal(scanner.encodeClaudeProjectDir('/Users/me/a.b_c d'), '-Users-me-a-b-c-d');
});

test('pickClaudeCwd prefers the head cwd when it matches the project dir', () => {
  const dir = '-Users-me-trunk-OBTO-k8-nodes';
  const head = '/Users/me/trunk/OBTO/k8/nodes';
  const tail = '/private/tmp/claude-501/x/scratchpad';
  assert.equal(scanner.pickClaudeCwd(dir, head, tail), head);
});

test('pickClaudeCwd falls back to the tail cwd, then the head, then the decoded name', () => {
  const dir = '-Users-me-proj';
  assert.equal(scanner.pickClaudeCwd(dir, '/Users/me/other', '/Users/me/proj/sub'), '/Users/me/proj/sub');
  assert.equal(scanner.pickClaudeCwd(dir, '/Users/me/other', ''), '/Users/me/other');
  assert.equal(scanner.pickClaudeCwd(dir, '', ''), '/Users/me/proj');
});

test('pickClaudeCwd prefers the head cwd over a scratchpad or missing tail cwd', () => {
  // Chat 20bf16f2: filed under a sleepy-swanson worktree dir, started in a
  // reverent-swanson worktree, ended in a deleted scratchpad.
  const dir = '-Users-me-trunk-OBTO-k8-nodes--claude-worktrees-sleepy-swanson-b44e5b';
  const head = '/Users/me/trunk/OBTO/k8/nodes/.claude/worktrees/reverent-swanson-b0368a';
  const scratch = '/private/tmp/claude-501/' + dir + '/20bf16f2/scratchpad';
  assert.equal(scanner.pickClaudeCwd(dir, head, scratch), head);
  assert.equal(scanner.pickClaudeCwd(dir, head, '/tmp/claude-501/x/scratchpad'), head);
  // A missing tail loses to a head that exists; a live tail still wins.
  const liveHead = tmpDir('agent-bridge-head-');
  const liveTail = tmpDir('agent-bridge-tail-');
  assert.equal(scanner.pickClaudeCwd(dir, liveHead, '/nonexistent/tail'), liveHead);
  assert.equal(scanner.pickClaudeCwd(dir, liveHead, liveTail), liveTail);
});

test('pickClaudeCwd keeps the scratchpad for a chat started in one', () => {
  const scratch = '/private/tmp/claude-501/-Users-me-proj/abc/scratchpad';
  const dir = scanner.encodeClaudeProjectDir(scratch);
  assert.equal(scanner.pickClaudeCwd(dir, scratch, scratch), scratch);
  assert.equal(scanner.pickClaudeCwd(dir, scratch, '/Users/me/elsewhere'), scratch);
});

test('walkClaudeProjectsRoot reports the head cwd when the dir name matches neither cwd', () => {
  const root = tmpDir();
  const dirName = '-Users-me-trunk-OBTO-k8-nodes--claude-worktrees-sleepy-swanson-b44e5b';
  const head = '/Users/me/trunk/OBTO/k8/nodes/.claude/worktrees/reverent-swanson-b0368a';
  const sid = '20bf16f2-2671-4b10-ad98-4817d704991c';
  const scratch = '/private/tmp/claude-501/' + dirName + '/' + sid + '/scratchpad';
  fs.mkdirSync(path.join(root, dirName));
  fs.writeFileSync(path.join(root, dirName, sid + '.jsonl'), jsonl([
    userRec('start here', { cwd: head }),
    assistantRec('ok', { cwd: head }),
    userRec('continue', { cwd: scratch }),
    assistantRec('done', { cwd: scratch }),
  ]));
  const rows = scanner.walkClaudeProjectsRoot(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectName, head);
});

test('readHeadCwd finds the first cwd past a large opening record', () => {
  const root = tmpDir();
  const file = path.join(root, 's.jsonl');
  fs.writeFileSync(file, jsonl([
    { type: 'queue-operation', content: 'x'.repeat(200000) },
    userRec('hello', { cwd: '/Users/me/first' }),
    userRec('later', { cwd: '/Users/me/second' }),
  ]));
  assert.equal(scanner.readHeadCwd(file), '/Users/me/first');
  assert.equal(scanner.readHeadCwd(path.join(root, 'missing.jsonl')), '');
});

test('walkClaudeProjectsRoot reports the start cwd, not a later scratchpad cwd', () => {
  const root = tmpDir();
  const realCwd = '/Users/me/trunk/OBTO/k8/nodes';
  const dirName = scanner.encodeClaudeProjectDir(realCwd);
  fs.mkdirSync(path.join(root, dirName));
  const sid = 'fcb87456-aa7f-4cb2-9be6-75ee92214725';
  fs.writeFileSync(path.join(root, dirName, sid + '.jsonl'), jsonl([
    userRec('Implement A4 height-aware pagination', { cwd: realCwd }),
    assistantRec('On it.', { cwd: realCwd }),
    userRec('continue', { cwd: '/private/tmp/claude-501/' + dirName + '/' + sid + '/scratchpad' }),
    assistantRec('Done.', { cwd: '/private/tmp/claude-501/' + dirName + '/' + sid + '/scratchpad' }),
  ]));
  const [rec] = scanner.walkClaudeProjectsRoot(root);
  assert.equal(rec.sessionId, sid);
  assert.equal(rec.projectDir, dirName);
  assert.equal(rec.projectName, realCwd);
});

test('walkClaudeProjectsRoot keeps the tail cwd when the head does not match the dir', () => {
  const root = tmpDir();
  const dirName = '-Users-me-proj';
  fs.mkdirSync(path.join(root, dirName));
  fs.writeFileSync(path.join(root, dirName, 'abc.jsonl'), jsonl([
    userRec('hi', { cwd: '/Users/me/elsewhere' }),
    userRec('again', { cwd: '/Users/me/proj/sub' }),
  ]));
  const [rec] = scanner.walkClaudeProjectsRoot(root);
  assert.equal(rec.projectName, '/Users/me/proj/sub');
});

test('stripHarnessWrappers removes harness blocks and keeps the real text', () => {
  const text = REMINDER + '\nWhat is 2+2?\n<command-name>/clear</command-name>\n' +
    '<local-command-stdout>cleared</local-command-stdout>';
  assert.equal(scanner.stripHarnessWrappers(text), 'What is 2+2?');
  assert.equal(scanner.stripHarnessWrappers(REMINDER), '');
});

test('stripHarnessWrappers drops an unclosed block to the end of the text', () => {
  assert.equal(scanner.stripHarnessWrappers('real\n<system-reminder>\nuser@example.com'), 'real');
});

test('stripHarnessWrappers keeps prose that only mentions a tag', () => {
  const t = 'Strip every `<system-reminder>` block before sending.';
  assert.equal(scanner.stripHarnessWrappers(t), t);
});

test('extractRecentMessages strips reminders and drops reminder-only turns', () => {
  const text = jsonl([
    userRec(REMINDER),
    assistantRec('ok'),
    userRec([{ type: 'text', text: REMINDER }, { type: 'text', text: 'reply with exactly: pong' }]),
    assistantRec('pong'),
  ]);
  const msgs = scanner.extractRecentMessages(text, 10);
  assert.deepEqual(msgs.map((m) => [m.role, m.body]), [
    ['assistant', 'ok'],
    ['user', 'reply with exactly: pong'],
    ['assistant', 'pong'],
  ]);
  assert.ok(!JSON.stringify(msgs).includes('someone@example.com'));
});

test('extractRecentMessages never strips assistant text', () => {
  const body = 'Here is the tag:\n<system-reminder>\nexample\n</system-reminder>';
  const msgs = scanner.extractRecentMessages(jsonl([userRec('show me'), assistantRec(body)]), 10);
  assert.equal(msgs[1].body, body);
});

test('extractLastMessage preview skips a reminder-only user record', () => {
  const tail = jsonl([assistantRec('the answer'), userRec(REMINDER)]);
  const last = scanner.extractLastMessage(tail);
  assert.deepEqual(last, { author: 'assistant', preview: 'the answer' });
});
