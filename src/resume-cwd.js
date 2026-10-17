'use strict';

// beta.33 — find a working directory an adopted external session can resume
// in when the cwd on the adoption record no longer exists.
//
// The adoption record's cwd comes from the discovery scanner. Daemons before
// beta.33 took it from the session TAIL, i.e. wherever the session last ran
// a command, which is often a scratchpad under /private/tmp that was deleted
// later (witnessed 2026-10-17, chat fcb87456). The session file's HEAD
// records where the session was started; that directory usually still
// exists.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { findSessionFile, readHeadCwd } = require('./external-scanner');

const dirExists = (p) => {
  try { return !!p && fs.statSync(p).isDirectory(); } catch (_) { return false; }
};

// Returns an existing absolute directory, or '' when none can be found.
// Claude sessions only: Codex and opencode records carry their cwd in the
// session meta, which the scanner already reads from the head.
const resolveResumeCwd = ({ source, projectDir, sessionId, claudeProjectsRoot }) => {
  if (source && source !== 'claude') return '';
  const sid = String(sessionId || '').trim();
  if (!sid || sid !== path.basename(sid)) return '';
  const root = claudeProjectsRoot || path.join(os.homedir(), '.claude', 'projects');
  const candidates = [];
  const dir = String(projectDir || '').trim();
  if (dir && dir === path.basename(dir) && dir !== '..' && dir !== '.') {
    candidates.push(path.join(root, dir, sid + '.jsonl'));
  }
  if (!claudeProjectsRoot) {
    const found = findSessionFile('claude', sid);
    if (found) candidates.push(found);
  }
  for (const file of candidates) {
    const cwd = readHeadCwd(file);
    if (cwd && path.isAbsolute(cwd) && dirExists(cwd)) return cwd;
  }
  return '';
};

module.exports = { resolveResumeCwd };
