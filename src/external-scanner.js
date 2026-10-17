'use strict';

// Phase 6.1 — External Thread Discovery (scanner half).
//
// Scans the local filesystem for AI coding sessions started OUTSIDE the bridge
// and returns a flat list of session records the daemon can POST to
// /api/bridge/external/sync. The bridge UI then renders them alongside
// bridge-owned threads — single pane of glass over all the user's AI work.
//
// Sources scanned:
//   - Claude Code (CLI + VSCode Claude extension): both write JSONL session
//     files at ~/.claude/projects/<encoded-projectdir>/<sessionId>.jsonl
//   - Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl
//   - opencode is NOT scanned — its SDK is server-bound, no shared JSONL store
//   - Web tools (claude.ai chat, ChatGPT) are out of reach by design
//
// Privacy: we extract metadata + the LAST message preview only (1–2 lines,
// capped at 200 chars). Full transcripts NEVER leave the user's machine.
// The daemon POSTs the extracted records; the bridge stores them in the
// agent_bridge_external_sessions Mongo collection.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
// Claude Desktop app's local-agent mode stores session JSONLs under
// ~/Library/Application Support/Claude/local-agent-mode-sessions/<uuid>/<uuid>/local_<uuid>/.claude/projects/<encoded>/<sid>.jsonl
// The file format is identical to Claude Code CLI's — same queue-operation
// preamble, same user/assistant message shape. Just a different root.
// Phase 6.2.5 — beta.19: surface these so the bridge sees every Claude
// session on disk, not just the CLI/extension subset.
const CLAUDE_DESKTOP_BASE = path.join(
  os.homedir(),
  'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions',
);

const PREVIEW_MAX_CHARS = 200;
const TITLE_MAX_CHARS = 80;
const TAIL_READ_BYTES = 16384;       // fixed-budget tail (cheap; used for ai-title + lastMessage)
const TAIL_STREAM_MAX_BYTES = 524288;// streaming tail cap — 512KB max read for recents (Phase 6.2.4)
const TAIL_STREAM_CHUNK = 65536;     // 64KB chunk size for the backward stream
const TAIL_STREAM_MIN_MESSAGES = 10; // stop reading once we have this many text-bearing lines
const TITLE_MAX_LINES = 40;    // scan up to this many lines for a real first message
const TITLE_MAX_BYTES = 65536; // hard ceiling per file even if MAX_LINES never reached

// beta.31 — per-file memo. A full parse of ~2100 local sessions took 48 s on
// the Mac (2026-10-17) and ran every tick, although only a handful of files
// change between ticks. A file whose (mtime, size) is unchanged returns its
// previous record; only new or touched files are re-read. Entries for files
// that disappeared are dropped at the end of each scanAll.
const fileMemo = new Map(); // filePath -> { mtimeMs, size, record }
let seenThisScan = null;
const memoGet = (filePath, stat) => {
  if (seenThisScan) seenThisScan.add(filePath);
  const m = fileMemo.get(filePath);
  if (m && m.mtimeMs === stat.mtimeMs && m.size === stat.size) return m.record;
  return null;
};
const memoPut = (filePath, stat, record) => {
  fileMemo.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, record });
  return record;
};

// Read the tail of a (potentially large) JSONL file without slurping the
// whole thing into memory. Returns a string (UTF-8) or '' on any failure.
const readTail = (filePath, maxBytes = TAIL_READ_BYTES) => {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
};

// Phase 6.2.4 — streaming tail. For sessions where individual JSONL records
// exceed the fixed 16KB budget (long assistant messages with lots of inline
// code), the fixed tail returns 0 parseable lines. This reads backward in
// 64KB chunks until we either have ≥TAIL_STREAM_MIN_MESSAGES text-bearing
// user/assistant lines OR hit TAIL_STREAM_MAX_BYTES (512KB) — whichever
// comes first. The first partial line at the buffer boundary is dropped
// because it won't JSON.parse cleanly; that's fine, the next chunk will
// pick it up complete.
// Current Codex rollout records wrap each turn as
//   {type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
// The message extractors below were written for Claude's {message:{role,content}}
// and older flat {role,content} codex shapes, so they extracted 0 messages from
// these rollouts (the agent still resumes — the SDK reads the rollout natively —
// but the bridge UI showed no history). Flatten a message item to the
// {role, content} shape the extractors already understand; non-message items
// (reasoning, function_call, session_meta, turn_context) pass through unchanged
// and harmlessly fail the role check.
const unwrapCodexItem = (obj) => {
  if (obj && obj.type === 'response_item' && obj.payload && obj.payload.type === 'message') {
    return { role: obj.payload.role, content: obj.payload.content, timestamp: obj.timestamp };
  }
  return obj;
};

const readTailUntilMessages = (filePath) => {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return '';
    fd = fs.openSync(filePath, 'r');
    let buffer = '';
    let pos = stat.size;
    while (pos > 0 && buffer.length < TAIL_STREAM_MAX_BYTES) {
      const readSize = Math.min(TAIL_STREAM_CHUNK, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buffer = chunk.toString('utf8') + buffer;
      // Cheap completeness check: count parseable user/assistant lines with text.
      const lines = buffer.split(/\r?\n/);
      let count = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        obj = unwrapCodexItem(obj);
        const role = (obj && (obj.role || (obj.message && obj.message.role))) || null;
        if (role !== 'user' && role !== 'assistant') continue;
        const raw = (obj.message && obj.message.content) || obj.content;
        if (!raw) continue;
        if (typeof raw === 'string') {
          if (raw.trim()) count++;
        } else if (Array.isArray(raw)) {
          for (const p of raw) {
            if (p && (p.type === 'text' || typeof p.text === 'string') && String(p.text || '').trim()) {
              count++; break;
            }
          }
        }
      }
      if (count >= TAIL_STREAM_MIN_MESSAGES) break;
    }
    return buffer;
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
};

// Pull the last N user/assistant *logical turns* from the tail, oldest-first.
// Phase 6.2.3 — beta.17 fix: Claude Code streams a single assistant reply as
// MULTIPLE JSONL lines (text → tool_use → tool_result → text → …), each its
// own JSONL record. The earlier extractor took one line per turn and
// fragmented responses into single-shard previews. Now we walk forward,
// parse every text-bearing user/assistant line, and **coalesce consecutive
// same-role lines into one logical turn** before slicing the last N. Result:
// a real conversation, not a single mid-sentence excerpt.
const RECENT_MESSAGE_BODY_MAX = 3000;
const RECENT_TURN_COUNT = 10;

const extractRecentMessages = (jsonlTail, n = RECENT_TURN_COUNT) => {
  if (!jsonlTail) return [];
  const lines = jsonlTail.split(/\r?\n/);
  const parsed = [];
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    obj = unwrapCodexItem(obj);
    let role = null, raw = null;
    if (obj && obj.message && (obj.message.role || obj.type)) {
      role = obj.message.role || (obj.type === 'user' ? 'user' : 'assistant');
      raw = obj.message.content;
    } else if (obj && obj.role && (obj.content || obj.text)) {
      role = obj.role;
      raw = obj.content != null ? obj.content : obj.text;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    if (raw == null) continue;
    let text = '';
    if (typeof raw === 'string') text = raw;
    else if (Array.isArray(raw)) {
      text = raw
        .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
        .map((p) => String(p.text || ''))
        .join('\n');
    }
    // Phase 6.2.6 — keep newlines so the bridge UI can render markdown
    // (tables, lists, code blocks, paragraphs). Collapsing every \s+ to a
    // single space was stripping all the formatting before storage. We
    // still collapse runs of horizontal whitespace and excessive blank
    // lines, but real line breaks survive.
    text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue; // skip pure tool_use / tool_result lines (no text body)
    parsed.push({ role, text, ts: obj.timestamp || null });
  }

  // Coalesce consecutive same-role lines (one logical turn split across JSONL
  // records). This is the actual fix — without it, assistant turns with mid-
  // reply tool calls fragment into the first text shard only. Joining with
  // \n\n preserves paragraph boundaries between coalesced chunks so markdown
  // renders correctly.
  const coalesced = [];
  for (const p of parsed) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.role === p.role) {
      last.text = (last.text + '\n\n' + p.text).replace(/\n{3,}/g, '\n\n').trim();
      last.ts = p.ts || last.ts;
    } else {
      coalesced.push({ role: p.role, text: p.text, ts: p.ts });
    }
  }

  // Filter user turns that are pure platform-injection noise. Assistant turns
  // are never filtered — they're always real Claude/Codex output.
  const filtered = coalesced.filter((m) => {
    if (m.role !== 'user') return true;
    return !isInjectionMessage(m.text);
  });

  const sliced = filtered.slice(-n);
  return sliced.map((m) => ({
    role: m.role,
    body: m.text.length > RECENT_MESSAGE_BODY_MAX ? m.text.slice(0, RECENT_MESSAGE_BODY_MAX) : m.text,
    ts: m.ts,
  }));
};

// Claude Code writes an LLM-generated title as a `type: "ai-title"` JSONL
// record near the end of each session file (this is the same title VSCode's
// session list shows — "Analyze MongoDB MCP server architecture" style).
// If we find one, it beats anything we could extract from the user's first
// raw prompt. Scan the tail backwards to hit it fast.
const extractAiTitleFromTail = (jsonlTail) => {
  if (!jsonlTail) return '';
  const lines = jsonlTail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap pre-filter so we only JSON.parse candidate lines.
    if (line.indexOf('ai-title') === -1 && line.indexOf('aiTitle') === -1) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        const t = obj.aiTitle.trim();
        if (t) return t.length > TITLE_MAX_CHARS ? t.slice(0, TITLE_MAX_CHARS) : t;
      }
    } catch (_) { /* not a JSON line — keep walking */ }
  }
  return '';
};


// "user" messages BEFORE the human's first real prompt — system reminders,
// IDE state, untrusted-metadata wrappers, command blocks, etc. These are
// noise from a label perspective. Filter them so the first PLAIN user
// prompt is what we use as the thread title.
const isInjectionMessage = (text) => {
  const s = String(text || '').trim();
  if (!s) return true;
  if (/^<[a-zA-Z!]/.test(s)) return true;                         // <system-reminder>, <ide_opened_file>, etc.
  if (/^Sender \(untrusted metadata\)/i.test(s)) return true;
  if (/^Conversation info \(untrusted metadata\)/i.test(s)) return true;
  if (/^untrusted metadata/i.test(s)) return true;
  if (/^Caveat:/i.test(s)) return true;
  if (/^Claude was launched/i.test(s)) return true;
  if (/^```json/i.test(s)) return true;
  if (/^`<command-name>/.test(s)) return true;
  if (/^This session is being continued/i.test(s)) return true;   // /resume preamble
  return false;
};

// Walk a JSONL file line-by-line until we find a plain user message (skipping
// metadata injections) or we've checked TITLE_MAX_LINES / TITLE_MAX_BYTES.
// Streaming so big files don't get fully slurped. Returns a clean ≤80-char
// title or '' if nothing meaningful was found in the bound.
const extractTitleFromFile = (filePath) => {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const CHUNK = 16 * 1024;
    const buf = Buffer.alloc(CHUNK);
    let carry = '';
    let bytesRead = 0;
    let linesChecked = 0;
    while (bytesRead < TITLE_MAX_BYTES && linesChecked < TITLE_MAX_LINES) {
      const n = fs.readSync(fd, buf, 0, CHUNK, bytesRead);
      if (n === 0) break;
      bytesRead += n;
      carry += buf.toString('utf8', 0, n);
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || '';
      for (const line of lines) {
        if (linesChecked >= TITLE_MAX_LINES) break;
        if (!line.trim()) continue;
        linesChecked++;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        obj = unwrapCodexItem(obj);
        let role = null, raw = null;
        if (obj && obj.message && (obj.message.role || obj.type)) {
          role = obj.message.role || (obj.type === 'user' ? 'user' : 'assistant');
          raw = obj.message.content;
        } else if (obj && obj.role && (obj.content || obj.text)) {
          role = obj.role;
          raw = obj.content != null ? obj.content : obj.text;
        }
        if (role !== 'user' || raw == null) continue;
        let text = '';
        if (typeof raw === 'string') text = raw;
        else if (Array.isArray(raw)) {
          text = raw
            .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
            .map((p) => String(p.text || ''))
            .join('\n');
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (isInjectionMessage(text)) continue;
        return text.length > TITLE_MAX_CHARS ? text.slice(0, TITLE_MAX_CHARS) : text;
      }
    }
    return '';
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
};

// Walk a JSONL tail backwards, parse each non-empty line as JSON, return the
// first one we can extract a message from. Tolerant of multiple shapes —
// Claude and Codex write slightly different envelopes and the formats have
// drifted across SDK versions.
const extractLastMessage = (jsonlTail) => {
  if (!jsonlTail) return null;
  const lines = jsonlTail.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch (_) {
      continue;
    }
    obj = unwrapCodexItem(obj);

    // ── Claude Code session JSONL shapes ─────────────────────────────────
    // Common:
    //   { type: 'user',      message: { role: 'user',      content: '...' } }
    //   { type: 'assistant', message: { role: 'assistant', content: [{type:'text', text:'...'}, ...] } }
    if (obj && obj.message && (obj.message.role || obj.type)) {
      const role = obj.message.role || (obj.type === 'user' ? 'user' : 'assistant');
      let raw = obj.message.content;
      let text = '';
      if (typeof raw === 'string') text = raw;
      else if (Array.isArray(raw)) {
        text = raw
          .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
          .map((p) => String(p.text || ''))
          .join('\n');
      }
      text = text.trim();
      if (text) return { author: role === 'user' ? 'user' : 'assistant', preview: text.slice(0, PREVIEW_MAX_CHARS) };
    }

    // ── Codex SDK rollout shapes ────────────────────────────────────────
    //   { record_type: 'message', role: 'assistant', content: [{type:'text', text:'...'}] }
    //   { type: 'message', role: 'user', content: '...' }
    //   { event: 'output_text', text: '...', role: 'assistant' }
    if (obj && (obj.role || obj.event) && (obj.content || obj.text)) {
      const role = obj.role || (obj.event === 'input_text' ? 'user' : 'assistant');
      let raw = obj.content != null ? obj.content : obj.text;
      let text = '';
      if (typeof raw === 'string') text = raw;
      else if (Array.isArray(raw)) {
        text = raw
          .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
          .map((p) => String(p.text || ''))
          .join('\n');
      }
      text = text.trim();
      if (text) return { author: role === 'user' ? 'user' : 'assistant', preview: text.slice(0, PREVIEW_MAX_CHARS) };
    }
  }
  return null;
};

// Decode Claude's project-dir filename encoding back to a path-like string.
// Claude turns `/Users/divyansh/foo` → `-Users-divyansh-foo`. We can't
// perfectly reverse it (project names with literal `-` are ambiguous), but
// for display purposes leading-dash → leading-slash + dashes → slashes is
// usually close enough. The BridgeExternal stores both the raw encoded
// projectDir AND a decoded label; the view route picks the friendlier one.
const decodeClaudeProjectDir = (encoded) => {
  if (!encoded) return '';
  if (encoded.startsWith('-')) {
    return '/' + encoded.slice(1).replace(/-/g, '/');
  }
  return encoded.replace(/-/g, '/');
};

// Discover all Claude Desktop "local-agent-mode" project roots.
// Structure is 3 levels deep before we hit `.claude/projects/`:
//   <BASE>/<accountUuid>/<workspaceUuid>/local_<sessionUuid>/.claude/projects/
// We collect every leaf `.claude/projects` dir, then walk each like we walk
// the CLI's ~/.claude/projects.
const findClaudeDesktopProjectRoots = () => {
  const out = [];
  let l1;
  try { l1 = fs.readdirSync(CLAUDE_DESKTOP_BASE); } catch (_) { return out; }
  for (const a of l1) {
    const aPath = path.join(CLAUDE_DESKTOP_BASE, a);
    let aStat; try { aStat = fs.statSync(aPath); } catch (_) { continue; }
    if (!aStat.isDirectory()) continue;
    let l2; try { l2 = fs.readdirSync(aPath); } catch (_) { continue; }
    for (const b of l2) {
      const bPath = path.join(aPath, b);
      let bStat; try { bStat = fs.statSync(bPath); } catch (_) { continue; }
      if (!bStat.isDirectory()) continue;
      let l3; try { l3 = fs.readdirSync(bPath); } catch (_) { continue; }
      for (const c of l3) {
        if (!c.startsWith('local_')) continue;
        const projects = path.join(bPath, c, '.claude', 'projects');
        try { if (fs.statSync(projects).isDirectory()) out.push(projects); } catch (_) {}
      }
    }
  }
  return out;
};

// Walk a single Claude projects root (works for both ~/.claude/projects and
// each of the Desktop app's local-agent-mode project roots — file format is
// identical, only the path differs).
const walkClaudeProjectsRoot = (root) => {
  const out = [];
  let topEntries;
  try { topEntries = fs.readdirSync(root); } catch (_) { return out; }

  for (const entry of topEntries) {
    const projectPath = path.join(root, entry);
    let projectStat;
    try { projectStat = fs.statSync(projectPath); } catch (_) { continue; }
    if (!projectStat.isDirectory()) continue;

    let sessionFiles;
    try { sessionFiles = fs.readdirSync(projectPath); } catch (_) { continue; }

    for (const file of sessionFiles) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.slice(0, -'.jsonl'.length);
      const filePath = path.join(projectPath, file);
      let stat;
      try { stat = fs.statSync(filePath); } catch (_) { continue; }
      const cached = memoGet(filePath, stat);
      if (cached) { out.push(cached); continue; }
      const tail = readTail(filePath);
      const lastMsg = extractLastMessage(tail);
      let title = extractAiTitleFromTail(tail);
      if (!title) title = extractTitleFromFile(filePath);
      const recentMessages = extractRecentMessages(readTailUntilMessages(filePath));
      // Authoritative cwd: Claude records the real working directory in every
      // session record, so read it from content. Decoding the encoded dir name
      // is LOSSY for any path with dashes (".../obto-inc-agent-bridge" decodes
      // to ".../obto/inc/agent/bridge" — a nonexistent dir, making a resumed
      // session run in the wrong place). Fall back to the decoded name only
      // when no cwd is present in the tail.
      let realCwd = '';
      let cwdM = tail.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!cwdM) {
        // Tail had no cwd (e.g. trailing tool output) — check the head, where
        // the first turn's envelope records it.
        try {
          const fdh = fs.openSync(filePath, 'r');
          const hb = Buffer.alloc(Math.min(8192, stat.size));
          fs.readSync(fdh, hb, 0, hb.length, 0);
          fs.closeSync(fdh);
          cwdM = hb.toString('utf8').match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        } catch (_) {}
      }
      if (cwdM) { try { realCwd = JSON.parse('"' + cwdM[1] + '"'); } catch (_) { realCwd = cwdM[1]; } }
      out.push(memoPut(filePath, stat, {
        source: 'claude',
        sessionId,
        projectDir: entry,
        projectName: realCwd || decodeClaudeProjectDir(entry),
        title: title,
        recentMessages: recentMessages,
        lastActivityAt: stat.mtimeMs,
        lastMessagePreview: lastMsg ? lastMsg.preview : '',
        lastMessageAuthor: lastMsg ? lastMsg.author : null,
      }));
    }
  }
  return out;
};

// Scan all Claude session storage on this machine — CLI + VSCode extension
// (~/.claude/projects) AND every Claude Desktop local-agent-mode subdir
// (~/Library/Application Support/Claude/local-agent-mode-sessions/.../).
const scanClaude = () => {
  const roots = [CLAUDE_DIR].concat(findClaudeDesktopProjectRoots());
  const out = [];
  for (const root of roots) {
    out.push(...walkClaudeProjectsRoot(root));
  }
  return out;
};

// Scan ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl
// The first JSONL line for a Codex rollout is a session-meta record that
// contains the working directory; we read it once for projectDir.
const scanCodex = () => {
  const out = [];
  let years;
  try { years = fs.readdirSync(CODEX_DIR); } catch (_) { return out; }

  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yPath = path.join(CODEX_DIR, y);
    let months;
    try { months = fs.readdirSync(yPath); } catch (_) { continue; }
    for (const m of months) {
      if (!/^\d{2}$/.test(m)) continue;
      const mPath = path.join(yPath, m);
      let days;
      try { days = fs.readdirSync(mPath); } catch (_) { continue; }
      for (const d of days) {
        if (!/^\d{2}$/.test(d)) continue;
        const dPath = path.join(mPath, d);
        let files;
        try { files = fs.readdirSync(dPath); } catch (_) { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          // Codex rollout filenames embed an ISO timestamp whose TIME part uses
          // dashes (rollout-2026-05-22T07-54-05-<uuid>.jsonl). A greedy
          // "trailing hex+dash" match grabbed the leftover time digits too
          // (e.g. "54-05-<uuid>"), producing a session id the SDK can't resume.
          // The id is the trailing UUID — match exactly that 8-4-4-4-12 shape.
          const sidMatch = f.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
          if (!sidMatch) continue;
          const sessionId = sidMatch[1];
          const filePath = path.join(dPath, f);
          let stat;
          try { stat = fs.statSync(filePath); } catch (_) { continue; }
          const cached = memoGet(filePath, stat);
          if (cached) { out.push(cached); continue; }

          // Pull the session-meta's working directory. The first JSONL line is
          // the session_meta record, but recent Codex builds embed the FULL
          // system prompt in payload.base_instructions.text — the line runs to
          // tens of KB, so a small head read truncates it mid-JSON and
          // JSON.parse throws (losing cwd entirely). `cwd` sits near the front
          // (right after id), so we read a generous head and, when the parse
          // fails on the truncated line, pull cwd out directly.
          let projectDir = '';
          let fd = null;
          try {
            fd = fs.openSync(filePath, 'r');
            const headBuf = Buffer.alloc(Math.min(16384, stat.size));
            fs.readSync(fd, headBuf, 0, headBuf.length, 0);
            const headStr = headBuf.toString('utf8');
            const firstLine = headStr.split(/\r?\n/)[0] || '';
            try {
              const meta = JSON.parse(firstLine);
              projectDir = String(
                meta?.payload?.cwd ||
                meta?.cwd ||
                meta?.workingDirectory ||
                meta?.working_directory ||
                meta?.session_meta?.cwd ||
                ''
              );
            } catch (_) { /* huge/truncated meta line — fall through to regex */ }
            if (!projectDir) {
              const cwdMatch = headStr.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
              if (cwdMatch) {
                try { projectDir = JSON.parse('"' + cwdMatch[1] + '"'); }
                catch (_) { projectDir = cwdMatch[1]; }
              }
            }
          } catch (_) {} finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
          }

          const tail = readTail(filePath);
          const lastMsg = extractLastMessage(tail);
          const title = extractTitleFromFile(filePath);
          // Recent messages get the streaming tail (handles huge per-message
      // assistant turns that overflow the 16KB fixed budget).
      const recentMessages = extractRecentMessages(readTailUntilMessages(filePath));
          out.push(memoPut(filePath, stat, {
            source: 'codex',
            sessionId,
            // No date fallback: "2026/05/22" is not a real cwd and only tricks
            // the daemon's adoption guard into thinking it has a path. null =
            // "cwd unknown", which the daemon handles honestly (first-touch with
            // injected history instead of a misrouted resume).
            projectDir: projectDir || null,
            projectName: projectDir || null,
            title: title,
            recentMessages: recentMessages,
            lastActivityAt: stat.mtimeMs,
            lastMessagePreview: lastMsg ? lastMsg.preview : '',
            lastMessageAuthor: lastMsg ? lastMsg.author : null,
          }));
        }
      }
    }
  }
  return out;
};

// Public entry: returns a flat list of every external session found.
// Synchronous: the daemon runs it inside a worker thread (scan-host.js), so
// even the cold first scan never blocks the SSE reader. Unchanged files come
// from fileMemo, so warm scans cost one readdir + stat per file.
const scanAll = () => {
  seenThisScan = new Set();
  try {
    const claude = scanClaude();
    const codex = scanCodex();
    for (const k of fileMemo.keys()) {
      if (!seenThisScan.has(k)) fileMemo.delete(k);
    }
    return claude.concat(codex);
  } finally {
    seenThisScan = null;
  }
};

// ── Phase 6.6 — full-history reads for adoption backfill ──────────────────
// Unlike the 30s discovery scan (tail-bounded by design), the one-time
// backfill on adoption wants the WHOLE session. Same parsing pipeline as
// extractRecentMessages — coalescing, injection filtering, markdown-safe
// whitespace — just fed the entire file instead of a 512KB tail.

const FULL_READ_MAX_BYTES = 50 * 1024 * 1024; // refuse to slurp >50MB

// Locate the JSONL file for a (source, sessionId). Walks the same roots the
// discovery scan walks. Returns the absolute path or null.
const findSessionFile = (source, sessionId) => {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;

  if (source === 'codex') {
    let years;
    try { years = fs.readdirSync(CODEX_DIR); } catch (_) { return null; }
    for (const y of years) {
      if (!/^\d{4}$/.test(y)) continue;
      let months; try { months = fs.readdirSync(path.join(CODEX_DIR, y)); } catch (_) { continue; }
      for (const m of months) {
        if (!/^\d{2}$/.test(m)) continue;
        let days; try { days = fs.readdirSync(path.join(CODEX_DIR, y, m)); } catch (_) { continue; }
        for (const d of days) {
          if (!/^\d{2}$/.test(d)) continue;
          const dPath = path.join(CODEX_DIR, y, m, d);
          let files; try { files = fs.readdirSync(dPath); } catch (_) { continue; }
          for (const f of files) {
            if (f.startsWith('rollout-') && f.endsWith('-' + sid + '.jsonl')) {
              return path.join(dPath, f);
            }
          }
        }
      }
    }
    return null;
  }

  // claude — CLI/extension root + every Desktop local-agent root.
  const roots = [CLAUDE_DIR].concat(findClaudeDesktopProjectRoots());
  for (const root of roots) {
    let projects;
    try { projects = fs.readdirSync(root); } catch (_) { continue; }
    for (const p of projects) {
      const candidate = path.join(root, p, sid + '.jsonl');
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    }
  }
  return null;
};

// Read and parse the ENTIRE session file into normalized turns, oldest-first:
// [{role, body, ts}]. Caps at maxTurns (keeping the newest). Returns [] on
// any failure or when the file exceeds the slurp cap.
const extractAllMessages = (filePath, maxTurns = 1000) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > FULL_READ_MAX_BYTES) return [];
    const text = fs.readFileSync(filePath, 'utf8');
    return extractRecentMessages(text, maxTurns);
  } catch (_) {
    return [];
  }
};

module.exports = {
  scanAll,
  scanClaude,
  scanCodex,
  extractLastMessage,
  decodeClaudeProjectDir,
  findSessionFile,
  extractAllMessages,
};
