'use strict';

// Which scanned sessions go into the external sync's sessions[].
//
// Bridge-owned sessions (a binding in state.json) used to be left out entirely,
// so once a session was adopted from DevZone its metadata (cwd/projectName,
// title, lastActivityAt, preview) never reached the bridge again and the
// synopsis "Project:" line and the routing row's resume cwd went stale
// (OT-7 §12.4.2, session fcb87456).
//
// Owned sessions come in two kinds:
//   - adopted: an externally discovered session the user replied to from
//     DevZone. Its binding lives under the platform's `ext-<source>-<prefix>`
//     thread id and still points at the same session. The platform already has
//     its external row and canonical thread, so resending it only refreshes
//     them (BridgeExternal.autoAdoptSessions resolves to the same thread).
//   - bridge-originated: a session the daemon spawned for a bridge thread, or
//     a resume that forked a new session id. Sending these would make the
//     platform auto-adopt them as NEW canonical threads (duplicates of the
//     bridge thread), so they stay out of sessions[].

const ADOPTED_THREAD = /^ext-([a-z]+)-([A-Za-z0-9]+)$/;

const compact = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

const bindingSessions = (b) => {
  if (!b) return {};
  if (b.sessions && typeof b.sessions === 'object') return b.sessions;
  return b.sessionId ? { _flat: b } : {};
};

// Every session id bound to a bridge thread.
const ownedSessionIds = (state) => {
  const ids = new Set();
  const bindings = (state && state.bindings) || {};
  for (const tid of Object.keys(bindings)) {
    const sessions = bindingSessions(bindings[tid]);
    for (const k of Object.keys(sessions)) {
      const s = sessions[k] || {};
      if (s.sessionId) ids.add(String(s.sessionId));
    }
  }
  return ids;
};

// The owned session ids that are the adopted external session itself: thread id
// `ext-<source>-<prefix>` and a session id whose alphanumerics start with that
// prefix (`ext-claude-fcb87456` -> `fcb87456-aa7f-…`, `ext-codex-1129019e` ->
// `11-29-019eae02-…`).
const adoptedSessionIds = (state) => {
  const ids = new Set();
  const bindings = (state && state.bindings) || {};
  for (const tid of Object.keys(bindings)) {
    const m = ADOPTED_THREAD.exec(tid);
    if (!m) continue;
    const prefix = m[2].toLowerCase();
    const sessions = bindingSessions(bindings[tid]);
    for (const k of Object.keys(sessions)) {
      const s = sessions[k] || {};
      if (!s.sessionId) continue;
      if (compact(s.sessionId).toLowerCase().indexOf(prefix) === 0) ids.add(String(s.sessionId));
    }
  }
  return ids;
};

// all = scanner output. Returns the rows to send and how many of them are owned.
const selectSyncSessions = (all, state) => {
  const owned = ownedSessionIds(state);
  const adopted = adoptedSessionIds(state);
  const sessions = [];
  let ownedSent = 0;
  for (const s of all || []) {
    if (!s || !s.sessionId) continue;
    const sid = String(s.sessionId);
    if (!owned.has(sid)) {
      sessions.push(s);
    } else if (adopted.has(sid)) {
      sessions.push(s);
      ownedSent++;
    }
  }
  return { sessions, ownedSent, ownedSkipped: owned.size - adopted.size };
};

module.exports = { ownedSessionIds, adoptedSessionIds, selectSyncSessions };
