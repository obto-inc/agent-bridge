'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Claude Code stores session JSONLs at:
//   ~/.claude/projects/<encodedAbsProjectDir>/<sessionId>.jsonl
// where the encoded dir is the absolute cwd with path separators flattened
// to `-`:
//   macOS/Linux  /Users/x/proj      -> -Users-x-proj
//   Windows      C:\Users\x\proj    -> C--Users-x-proj   (drive colon + `\`)
// NOTE: confirm against Claude Code's own Windows encoding before treating
// this as load-bearing. The daemon only uses it for the (default-off)
// freshness guard and `obto-bridge status` — resume goes through the SDK by
// sessionId, not this path — so a Windows mismatch is non-fatal.
const encodeProjectDir = (absDir) => String(absDir).replace(/[/\\:]/g, '-');

const projectHashDir = (absDir) =>
  path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(absDir));

// Returns { sessionId, jsonlPath, mtimeMs } for the most-recently-modified
// session JSONL in the project, or null if the project dir doesn't exist
// or has no sessions.
const scanLatestSession = (absProjectDir) => {
  const dir = projectHashDir(absProjectDir);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }

  let best = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { sessionId, jsonlPath: full, mtimeMs: st.mtimeMs };
    }
  }
  return best;
};

module.exports = { encodeProjectDir, projectHashDir, scanLatestSession };
