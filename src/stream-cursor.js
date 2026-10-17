'use strict';

// beta.32 — reconnect catch-up. The bridge's per-connection AMQP queue is
// exclusive + autoDelete, so a reply published while the SSE stream was down
// (~16 drops/day, ~1.5 s each) used to be lost. Now the daemon remembers the
// last SSE id it saw (the bridge messageId) and sends it as Last-Event-ID on
// every (re)connect; the bridge replays human replies newer than it. Replay
// and live delivery can overlap, so every reply id is also deduped here.
//
// Persisted to ~/.agent-bridge-daemon/stream-cursor.json so a daemon RESTART
// (launchd kickstart, crash, upgrade) catches up too — not just a reconnect
// inside one process. The file holds ids only, never message bodies.

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./state');

const CURSOR_PATH = path.join(STATE_DIR, 'stream-cursor.json');
const RECENT_MAX = 200;
const ID_RE = /^[0-9a-f]{24}$/i;

const load = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8'));
    return {
      lastEventId: raw && ID_RE.test(String(raw.lastEventId || '')) ? String(raw.lastEventId) : null,
      recent: Array.isArray(raw && raw.recent) ? raw.recent.filter((x) => ID_RE.test(String(x))).slice(-RECENT_MAX) : [],
    };
  } catch (_) {
    return { lastEventId: null, recent: [] };
  }
};

const save = (cur) => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = CURSOR_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      lastEventId: cur.lastEventId,
      recent: cur.recent,
      updatedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    fs.renameSync(tmp, CURSOR_PATH);
  } catch (_) { /* a lost cursor write only widens the next replay; dedupe still holds in memory */ }
};

const createCursor = () => {
  const cur = load();
  const seen = new Set(cur.recent);

  return {
    lastEventId: () => cur.lastEventId,

    // Record a reply id. Returns false when it was already seen (a replay that
    // overlapped live delivery, or a replay of something handled before a
    // restart) — the caller drops the event. Ids that are not ObjectIds pass
    // through untracked.
    accept: (id) => {
      const s = String(id || '');
      if (!ID_RE.test(s)) return true;
      if (seen.has(s)) return false;
      seen.add(s);
      cur.recent.push(s);
      if (cur.recent.length > RECENT_MAX) {
        const drop = cur.recent.splice(0, cur.recent.length - RECENT_MAX);
        drop.forEach((x) => seen.delete(x));
      }
      // ObjectIds sort by creation second; only move the cursor forward.
      if (!cur.lastEventId || s > cur.lastEventId) cur.lastEventId = s;
      save(cur);
      return true;
    },
  };
};

module.exports = { createCursor, CURSOR_PATH };
