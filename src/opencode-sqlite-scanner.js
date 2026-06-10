'use strict';

// Phase 6.5 — surface OpenCode desktop/CLI conversations to the bridge.
//
// OpenCode stores sessions in SQLite at ~/.local/share/opencode/opencode.db
// (shared between the CLI and the Electron desktop app). Schema (relevant
// subset, captured 2026-06-07):
//
//   session(id, project_id, parent_id, directory, title, time_created,
//           time_updated, agent, model, ...)
//   message(id, session_id, time_created, data JSON)   -- data.role: user|assistant|...
//   part(id, message_id, session_id, time_created, data JSON)   -- data.type: text|reasoning|step-start|...
//   project(id, worktree, name, ...)
//
// We read via the `sqlite3` CLI subprocess (ships on macOS, standard on
// Linux) rather than adding a native dependency (better-sqlite3) to the
// daemon's install footprint. Opens in `-readonly` mode so live writes from
// the desktop app are safe — SQLite WAL allows concurrent reads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const OPENCODE_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// Match the limits the Claude/Codex scanners use so the bridge UI's
// preview/title rendering looks consistent across sources.
const SESSION_LIMIT = 500;
const RECENT_TURN_COUNT = 10;
const RECENT_MESSAGE_BODY_MAX = 4000;
const PREVIEW_MAX_CHARS = 240;
const QUERY_TIMEOUT_MS = 8000;

let sqliteAvailableCached = null;
const sqliteAvailable = () => {
  if (sqliteAvailableCached !== null) return sqliteAvailableCached;
  try {
    const r = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
    sqliteAvailableCached = r.status === 0;
  } catch (_) {
    sqliteAvailableCached = false;
  }
  return sqliteAvailableCached;
};

const dbExists = () => {
  try { return fs.existsSync(OPENCODE_DB); } catch (_) { return false; }
};

// Run a single SQL query against the OpenCode DB and parse `-json` output.
// Returns [] on any failure (missing CLI, locked DB beyond timeout, bad SQL).
// The daemon's external scan is fire-and-forget and runs every 30s, so we
// MUST NOT throw out — at worst we miss this tick.
const queryJson = (sql) => {
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', OPENCODE_DB, sql], {
      encoding: 'utf8',
      timeout: QUERY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!out || !out.trim()) return [];
    return JSON.parse(out);
  } catch (_) {
    return [];
  }
};

// Take a string and slice/trim to PREVIEW_MAX_CHARS for the sidebar preview.
const previewOf = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > PREVIEW_MAX_CHARS ? t.slice(0, PREVIEW_MAX_CHARS) : t;
};

// Trim a recentMessages body to the same RECENT_MESSAGE_BODY_MAX cap as the
// other scanners so the bridge's per-row payload stays bounded.
const bodyOf = (s) => {
  const t = String(s || '');
  return t.length > RECENT_MESSAGE_BODY_MAX ? t.slice(0, RECENT_MESSAGE_BODY_MAX) : t;
};

// Pull the last N text-bearing turns for one session. Skip control rows
// (step-start, reasoning, tool-use) so the preview matches what the human
// actually said and what the assistant actually replied.
const recentMessagesFor = (sessionId) => {
  const safeId = String(sessionId).replace(/'/g, "''");
  // Last N text parts in order. We take 2*N from the tail then sort because
  // SQLite's LIMIT is fastest with DESC + ascending re-sort in JS.
  const rows = queryJson(
    "SELECT p.time_created AS ts, " +
    "json_extract(m.data, '$.role') AS role, " +
    "json_extract(p.data, '$.text') AS text " +
    "FROM part p JOIN message m ON p.message_id = m.id " +
    "WHERE p.session_id = '" + safeId + "' " +
    "AND json_extract(p.data, '$.type') = 'text' " +
    "ORDER BY p.time_created DESC LIMIT " + (RECENT_TURN_COUNT * 2),
  );
  rows.reverse();
  // Coalesce consecutive same-role rows (assistant turn can be split across
  // parts) and tail to N.
  const coalesced = [];
  for (const r of rows) {
    if (!r || !r.text) continue;
    const role = r.role === 'user' ? 'user' : 'assistant';
    const last = coalesced[coalesced.length - 1];
    if (last && last.role === role) {
      last.text += '\n\n' + r.text;
      last.ts = r.ts;
    } else {
      coalesced.push({ role, text: r.text, ts: r.ts });
    }
  }
  const sliced = coalesced.slice(-RECENT_TURN_COUNT);
  return sliced.map((m) => ({ role: m.role, body: bodyOf(m.text), ts: m.ts }));
};

const lastMessageFor = (sessionId) => {
  const safeId = String(sessionId).replace(/'/g, "''");
  const rows = queryJson(
    "SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.text') AS text " +
    "FROM part p JOIN message m ON p.message_id = m.id " +
    "WHERE p.session_id = '" + safeId + "' " +
    "AND json_extract(p.data, '$.type') = 'text' " +
    "ORDER BY p.time_created DESC LIMIT 1",
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    author: r.role === 'user' ? 'user' : 'assistant',
    preview: previewOf(r.text),
  };
};

// Public API. Returns the same shape that postExternalSync expects (same as
// claude/codex rows). Best-effort: returns [] if SQLite/DB unavailable.
const scanAll = () => {
  if (!dbExists() || !sqliteAvailable()) return [];

  // Top-level sessions only — skip sub-sessions (parent_id non-null), they
  // belong to a parent and showing them as standalone rows would clutter
  // the sidebar with duplicate-looking conversations.
  const sessions = queryJson(
    "SELECT s.id AS sessionId, s.title, s.directory, " +
    "s.time_created AS createdMs, s.time_updated AS updatedMs, " +
    "s.agent, s.model, " +
    "p.name AS projectName, p.worktree AS projectWorktree " +
    "FROM session s LEFT JOIN project p ON s.project_id = p.id " +
    "WHERE (s.parent_id IS NULL OR s.parent_id = '') " +
    "ORDER BY s.time_updated DESC LIMIT " + SESSION_LIMIT,
  );

  const out = [];
  for (const s of sessions) {
    if (!s || !s.sessionId) continue;
    const dir = s.directory || s.projectWorktree || '';
    const recentMessages = recentMessagesFor(s.sessionId);
    const lastMsg = lastMessageFor(s.sessionId);
    out.push({
      source: 'opencode',
      sessionId: String(s.sessionId),
      // The bridge's adoption path uses projectDir for resume cwd. OpenCode
      // stores the absolute path in `directory` (or project.worktree as
      // backup); pass it through as both projectDir and projectName so the
      // daemon's "looksAbsolute" guard in daemon.js handleEvent accepts it.
      projectDir: dir,
      projectName: dir,
      title: String(s.title || '').trim() || null,
      recentMessages: recentMessages,
      lastActivityAt: typeof s.updatedMs === 'number' ? s.updatedMs : Number(s.updatedMs) || 0,
      lastMessagePreview: lastMsg ? lastMsg.preview : '',
      lastMessageAuthor: lastMsg ? lastMsg.author : null,
    });
  }
  return out;
};

// Phase 6.6 — full-history read for adoption backfill. Same shape as
// recentMessagesFor but unbounded by RECENT_TURN_COUNT (capped at maxTurns,
// keeping the newest). Returns [] when SQLite/DB unavailable.
const fullMessagesFor = (sessionId, maxTurns = 1000) => {
  if (!dbExists() || !sqliteAvailable()) return [];
  const safeId = String(sessionId).replace(/'/g, "''");
  const rows = queryJson(
    "SELECT p.time_created AS ts, " +
    "json_extract(m.data, '$.role') AS role, " +
    "json_extract(p.data, '$.text') AS text " +
    "FROM part p JOIN message m ON p.message_id = m.id " +
    "WHERE p.session_id = '" + safeId + "' " +
    "AND json_extract(p.data, '$.type') = 'text' " +
    "ORDER BY p.time_created ASC LIMIT " + (Math.max(1, maxTurns) * 4),
  );
  const coalesced = [];
  for (const r of rows) {
    if (!r || !r.text) continue;
    const role = r.role === 'user' ? 'user' : 'assistant';
    const last = coalesced[coalesced.length - 1];
    if (last && last.role === role) {
      last.text += '\n\n' + r.text;
      last.ts = r.ts;
    } else {
      coalesced.push({ role, text: r.text, ts: r.ts });
    }
  }
  const sliced = coalesced.slice(-Math.max(1, maxTurns));
  return sliced.map((m) => ({ role: m.role, body: bodyOf(m.text), ts: m.ts }));
};

module.exports = { scanAll, fullMessagesFor, OPENCODE_DB };
