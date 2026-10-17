'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveResumeCwd } = require('../src/resume-cwd');
const { explainSpawnError } = require('../src/claude-driver')._internal;
const { tmpDir, jsonl, userRec } = require('./helpers');

const SID = 'fcb87456-aa7f-4cb2-9be6-75ee92214725';

const setup = (headCwd, tailCwd) => {
  const root = tmpDir();
  const projectDir = '-proj';
  fs.mkdirSync(path.join(root, projectDir));
  fs.writeFileSync(path.join(root, projectDir, SID + '.jsonl'), jsonl([
    userRec('start', { cwd: headCwd }),
    userRec('later', { cwd: tailCwd }),
  ]));
  return { root, projectDir };
};

test('resolveResumeCwd returns the head cwd when it exists', () => {
  const realCwd = tmpDir('agent-bridge-cwd-');
  const { root, projectDir } = setup(realCwd, '/private/tmp/gone/scratchpad');
  assert.equal(
    resolveResumeCwd({ source: 'claude', projectDir, sessionId: SID, claudeProjectsRoot: root }),
    realCwd,
  );
});

test('resolveResumeCwd returns "" when the head cwd is gone too', () => {
  const { root, projectDir } = setup('/nonexistent/start', '/nonexistent/end');
  assert.equal(
    resolveResumeCwd({ source: 'claude', projectDir, sessionId: SID, claudeProjectsRoot: root }),
    '',
  );
});

test('resolveResumeCwd rejects path-like ids and non-claude sources', () => {
  const realCwd = tmpDir('agent-bridge-cwd-');
  const { root, projectDir } = setup(realCwd, realCwd);
  assert.equal(resolveResumeCwd({ source: 'claude', projectDir: '../' + projectDir, sessionId: SID, claudeProjectsRoot: root }), '');
  assert.equal(resolveResumeCwd({ source: 'claude', projectDir, sessionId: '../' + SID, claudeProjectsRoot: root }), '');
  assert.equal(resolveResumeCwd({ source: 'codex', projectDir, sessionId: SID, claudeProjectsRoot: root }), '');
});

test('explainSpawnError names a missing cwd instead of the binary', () => {
  const sdkErr = new Error('Claude Code native binary not found at /Users/me/.local/bin/claude. Please ensure …');
  const e = explainSpawnError(sdkErr, '/private/tmp/deleted/scratchpad');
  assert.equal(e.message, 'working directory missing: /private/tmp/deleted/scratchpad');
  assert.equal(e.cause, sdkErr);
});

test('explainSpawnError leaves other errors and existing cwds alone', () => {
  const sdkErr = new Error('Claude Code native binary not found at /x');
  assert.equal(explainSpawnError(sdkErr, tmpDir()), sdkErr);
  const other = new Error('rate limited');
  assert.equal(explainSpawnError(other, '/nonexistent'), other);
});
