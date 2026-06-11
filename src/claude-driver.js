'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { encodeProjectDir } = require('./session-scanner');
const bridgeHttp = require('./bridge-http');
const { buildBridgeMcpServer } = require('./bridge-mcp-server');
// Phase 5a — when this engine first touches a thread that already has bridge
// history (provider switch / adopted thread), inject that history into the
// first prompt so the session starts with context instead of amnesia.
const { buildHistoryBlock } = require('./history');

// Per-thread promise queue. Concurrent AMQP messages targeting the same thread
// are serialized so first-touch session creation completes before any resume,
// and consecutive resumes don't race the JSONL writer.
const queues = new Map();

// Freshness guard was for the niche case of a user running
// `claude --resume <daemon-spawned sid>` interactively while the daemon is
// driving the same session. In practice the SDK does post-iteration writes
// to the JSONL that the daemon doesn't see, so the guard was misfiring on
// every resume after first-touch. Default: OFF. Set BRIDGE_LIVE_GUARD=1
// to re-enable.
const FRESHNESS_THRESHOLD_MS =
  parseInt(process.env.BRIDGE_LIVE_THRESHOLD_MS || '60000', 10);
const LIVE_GUARD_DISABLED = process.env.BRIDGE_LIVE_GUARD !== '1';
const ALLOW_ALL = process.env.BRIDGE_ALLOW_ALL === '1';
const RELAY_PERMISSIONS = process.env.BRIDGE_RELAY_PERMISSIONS === '1';
const RELAY_TIMEOUT_MS =
  parseInt(process.env.BRIDGE_RELAY_TIMEOUT_MS || '600000', 10);

const statMtimeMs = (jsonlPath) => {
  if (!jsonlPath) return null;
  try {
    return fs.statSync(jsonlPath).mtimeMs;
  } catch (_) {
    return null;
  }
};

// Decide whether the JSONL was written by something other than this daemon
// since our last drive. If we have a known-mtime baseline, current mtime
// must match it (within fs-precision tolerance) — anything else means an
// external writer (interactive `claude --resume` etc.) is touching the file.
// If we have no baseline (first drive on this binding), fall back to a
// time-based heuristic so we don't barge in on a hot interactive session.
const isStaleVsBaseline = (jsonlPath, baselineMtimeMs) => {
  if (LIVE_GUARD_DISABLED) return false;
  if (!jsonlPath) return false;
  const cur = statMtimeMs(jsonlPath);
  if (cur == null) return false;
  if (baselineMtimeMs == null) {
    return Date.now() - cur < FRESHNESS_THRESHOLD_MS;
  }
  return Math.abs(cur - baselineMtimeMs) > 100;
};

// Tools auto-approved without any human in the loop. The bridge_* tools are
// served by our in-process SDK MCP server registered as "bridge", so their
// fully-qualified names are mcp__bridge__*.
const ALLOWED_TOOLS = new Set([
  'mcp__bridge__bridge_post',
  'mcp__bridge__bridge_thread_read',
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'NotebookRead',
  'TodoWrite',
]);

// ── Permission relay ──────────────────────────────────────────────────────
// Single-pending-per-thread. If Claude requests a tool needing approval, we
// post a bridge question and resolve when a matching reply arrives via the
// daemon's AMQP consumer (which calls tryResolvePermission below).

const pendingPermissions = new Map();

const requestPermissionViaBridge = async (threadId, toolName, input, log) => {
  if (pendingPermissions.has(threadId)) {
    return {
      behavior: 'deny',
      message:
        'Another permission request is already pending on this thread; the daemon ' +
        'does not multiplex permissions per thread. Wait and retry.',
    };
  }

  const permId = 'perm-' + Math.random().toString(36).slice(2, 10);
  let inputJson;
  try {
    inputJson = JSON.stringify(input, null, 2);
  } catch (_) {
    inputJson = '<unserializable>';
  }

  const minutes = Math.max(1, Math.floor(RELAY_TIMEOUT_MS / 60000));
  const body =
    '🔐 Permission request ' + permId +
    '\n\nTool: ' + toolName +
    '\nInput:\n' + inputJson +
    '\n\nReply "approve" to allow, or anything else to deny. Times out in ' +
    minutes + ' minute' + (minutes === 1 ? '' : 's') + '.';

  log('info', 'permission relay: posting question', { threadId, permId, toolName });

  try {
    const r = await bridgeHttp.postMessage({
      threadId,
      author: 'claude-bridge-perm',
      role: 'agent',
      kind: 'question',
      body,
    });
    if (!r.ok) {
      throw new Error('post returned status ' + r.status);
    }
  } catch (err) {
    log('error', 'permission relay: post failed', {
      threadId,
      permId,
      error: err && err.message ? err.message : String(err),
    });
    return {
      behavior: 'deny',
      message:
        'Permission relay failed to post the question to the bridge: ' +
        (err && err.message ? err.message : String(err)),
    };
  }

  return await new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingPermissions.delete(threadId);
      log('warn', 'permission relay: timed out', { threadId, permId, toolName });
      resolve({
        behavior: 'deny',
        message:
          'Permission request timed out — no human reply within ' + minutes +
          ' minute' + (minutes === 1 ? '' : 's') + '.',
      });
    }, RELAY_TIMEOUT_MS);

    pendingPermissions.set(threadId, {
      permId,
      toolName,
      input,
      resolve,
      timeoutHandle,
    });
  });
};

// Called by the AMQP consumer for every reply on a thread. If the thread has
// a pending permission request, resolve it and return true so the consumer
// skips the normal drive() path. Otherwise return false.
const tryResolvePermission = (threadId, body, log) => {
  const pending = pendingPermissions.get(threadId);
  if (!pending) return false;

  pendingPermissions.delete(threadId);
  clearTimeout(pending.timeoutHandle);

  const normalized = String(body || '').trim().toLowerCase();
  const approved = normalized === 'approve' || normalized === 'yes';

  log('info', 'permission relay: resolved by reply', {
    threadId,
    permId: pending.permId,
    toolName: pending.toolName,
    approved,
    replyPreview: String(body || '').slice(0, 80),
  });

  if (approved) {
    pending.resolve({ behavior: 'allow', updatedInput: pending.input });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: 'Human declined: ' + String(body || '').slice(0, 200),
    });
  }
  return true;
};

const buildPermissionOptions = (log, threadId) => {
  if (ALLOW_ALL) {
    log('warn', 'BRIDGE_ALLOW_ALL=1 — bypassing all tool permissions', { threadId });
    return {
      permissionMode: 'bypassPermissions',
      bypassPermissionsModeAcknowledged: true,
    };
  }
  return {
    canUseTool: async (toolName, input) => {
      if (ALLOWED_TOOLS.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }
      if (RELAY_PERMISSIONS) {
        return await requestPermissionViaBridge(threadId, toolName, input, log);
      }
      log('info', 'tool denied by bridge policy', { threadId, toolName });
      return {
        behavior: 'deny',
        message:
          'This is a bridge-spawned session running unattended on the user\'s ' +
          'machine. The tool "' + toolName + '" is not on the auto-approved ' +
          'list and BRIDGE_RELAY_PERMISSIONS is not enabled. To use it, post a ' +
          'message via bridge_post with kind="question" on threadId="' + threadId + '" ' +
          'explaining what you need to do, then end your turn — a human will ' +
          'reply with guidance, and you can re-evaluate when the bridge resumes ' +
          'you on the next message.',
      };
    },
  };
};

// ── Driving sessions ──────────────────────────────────────────────────────

// Security — the envelope header is structured metadata the agent reads to
// know who/what/when. threadId and (less so) author are user-influenced, so a
// value containing ']', '|', or a newline could forge a second envelope or
// inject framing. Strip the delimiter chars + control chars from every header
// field; the body (the actual human message) is left intact — it's meant to
// be free text and the agent treats it as the task, not as protocol.
const sanitizeHeaderField = (v) =>
  String(v == null ? '' : v)
    .replace(/[\x00-\x1F\x7F]/g, ' ') // control chars (incl. newlines) → space
    .replace(/[\[\]|]/g, '')          // envelope delimiters
    .trim()
    .slice(0, 200);

const buildEnvelope = (payload) => {
  const head =
    '[Agent Bridge | thread:' + sanitizeHeaderField(payload.threadId || '?') +
    ' | from:' + sanitizeHeaderField(payload.author || 'unknown') +
    ' | role:' + sanitizeHeaderField(payload.role || 'human') +
    ' | ts:' + sanitizeHeaderField(payload.createdAt || new Date().toISOString()) +
    (payload.messageId ? ' | messageId:' + sanitizeHeaderField(payload.messageId) : '') +
    ']';
  const body = (payload.body || '').toString();
  return head + '\n\n' + body;
};

// Phase 6.4 — image attachments. When payload.attachmentIds is non-empty,
// download each via the bridge HTTP API and assemble a multimodal user
// message (image blocks + text envelope) as an async iterable, which the
// Claude Agent SDK accepts in lieu of a plain prompt string. With no
// attachments, returns the envelope text as-is — zero overhead on the
// hot text-only path.
const buildPromptForSdk = async (payload, envelopeText, log) => {
  const ids = Array.isArray(payload && payload.attachmentIds)
    ? payload.attachmentIds.filter(Boolean)
    : [];
  if (ids.length === 0) return envelopeText;

  const blocks = [];
  for (const id of ids) {
    try {
      const r = await bridgeHttp.getAttachmentBytes(id);
      if (r && r.ok) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: r.mimeType || 'image/png',
            data: r.base64,
          },
        });
      } else {
        if (log) log('warn', 'attachment fetch failed', { id, status: r && r.status });
      }
    } catch (e) {
      if (log) log('warn', 'attachment fetch threw', {
        id,
        error: e && e.message ? e.message : String(e),
      });
    }
  }
  // No images survived the fetch — fall back to text-only so the turn still
  // runs (with degraded context). The agent has the envelope; the user will
  // see their own bubble with images in the bridge UI.
  if (blocks.length === 0) return envelopeText;

  blocks.push({ type: 'text', text: envelopeText });
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content: blocks } };
  })();
};

const buildBootstrapPrompt = (payload) =>
  buildEnvelope(payload) +
  '\n\n---\n' +
  'You are a Claude session spawned by the OBTO Agent Bridge daemon to handle ' +
  'thread "' + payload.threadId + '". The human who sent the message above is ' +
  'NOT watching your terminal output — they are on the OBTO bridge web UI ' +
  '(possibly on their phone). You CANNOT reach them with plain text replies. ' +
  'The ONLY way to communicate back is to call the in-process bridge MCP tools ' +
  'served by the "bridge" server (running locally inside this daemon).\n\n' +
  'TOOLS YOU MUST USE — by their fully-qualified MCP names:\n' +
  '  • mcp__bridge__bridge_post — post a reply on this thread\n' +
  '  • mcp__bridge__bridge_thread_read — read prior messages on this thread\n\n' +
  'Do NOT use mcp__claude_ai_OBTO-APP__bridge_post if it appears in your tool ' +
  'list — that one routes through an unreliable proxy that times out and will ' +
  'silently fail. Always prefer mcp__bridge__*.\n\n' +
  'Workflow rules (apply to this turn AND every future turn on this thread):\n' +
  '  1. Investigate / do the requested work using the tools you have.\n' +
  '  2. Post your final answer via mcp__bridge__bridge_post(threadId="' + payload.threadId + '", ' +
       'body=<your reply text>, kind="result" for a finished answer, ' +
       '"status" for a progress update, "question" if you need clarification, ' +
       '"error" if something failed).\n' +
  '  3. If you need information from the human before you can finish, ' +
       'post a single question via mcp__bridge__bridge_post(kind="question") and ' +
       'end your turn. Do NOT speculate or do unrelated work while waiting.\n' +
  '  4. To see prior messages on this thread (e.g. on resume), call ' +
       'mcp__bridge__bridge_thread_read(threadId="' + payload.threadId + '").\n\n' +
  'IMPORTANT: end every turn with an mcp__bridge__bridge_post call. Plain-text ' +
  'replies in this conversation are invisible to the human and effectively dropped.\n\n' +
  'Now respond to the human message above.';

const consumeQuery = async (q) => {
  let assistantTextChars = 0;
  let stopReason = null;
  let observedSessionId = null;

  for await (const event of q) {
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      observedSessionId = event.session_id;
    }

    if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const c of event.message.content) {
        if (c && c.type === 'text' && typeof c.text === 'string') {
          assistantTextChars += c.text.length;
        }
      }
    }

    if (event.type === 'result') {
      stopReason = event.subtype || event.stop_reason || 'done';
      break;
    }
  }

  return { assistantTextChars, stopReason, observedSessionId };
};

const driveFirstTouch = async ({ threadId, projectDir, payload, log }) => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const bridgeServer = await buildBridgeMcpServer({ log });
  // Phase 5a — prior thread history (empty string for brand-new threads).
  const historyBlock = await buildHistoryBlock({
    threadId,
    currentMessageId: payload.messageId,
    engineName: 'Claude',
    log,
  });
  const prompt = await buildPromptForSdk(
    payload,
    historyBlock + buildBootstrapPrompt(payload),
    log,
  );
  const options = Object.assign(
    {
      cwd: projectDir,
      mcpServers: { bridge: bridgeServer },
    },
    buildPermissionOptions(log, threadId),
  );

  log('info', 'first-touch spawn', {
    threadId,
    projectDir,
    messageId: payload.messageId,
    attachments: (payload.attachmentIds || []).length,
  });

  const startedAt = Date.now();
  const { assistantTextChars, stopReason, observedSessionId } =
    await consumeQuery(sdk.query({ prompt, options }));

  if (!observedSessionId) {
    throw new Error('no session_id observed from query() init event');
  }

  const jsonlPath = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeProjectDir(projectDir),
    observedSessionId + '.jsonl',
  );

  const lastJsonlMtimeMs = statMtimeMs(jsonlPath);

  log('info', 'first-touch done', {
    threadId,
    sessionId: observedSessionId,
    stopReason,
    assistantTextChars,
    durationMs: Date.now() - startedAt,
    lastJsonlMtimeMs,
  });

  return {
    sessionId: observedSessionId,
    projectDir,
    jsonlPath,
    stopReason,
    assistantTextChars,
    lastJsonlMtimeMs,
  };
};

const driveResume = async ({ threadId, sessionId, projectDir, jsonlPath, lastJsonlMtimeMs, payload, log }) => {
  if (isStaleVsBaseline(jsonlPath, lastJsonlMtimeMs)) {
    const cur = statMtimeMs(jsonlPath);
    log('warn', 'JSONL changed since last daemon drive — likely live interactive session, skipping resume', {
      threadId,
      sessionId,
      jsonlPath,
      baselineMtimeMs: lastJsonlMtimeMs,
      currentMtimeMs: cur,
    });
    return { skipped: true, stopReason: 'skipped_live_session' };
  }

  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const bridgeServer = await buildBridgeMcpServer({ log });
  const prompt = await buildPromptForSdk(payload, buildEnvelope(payload), log);
  const options = Object.assign(
    {
      resume: sessionId,
      cwd: projectDir,
      mcpServers: { bridge: bridgeServer },
    },
    buildPermissionOptions(log, threadId),
  );

  log('info', 'resuming session', {
    threadId,
    sessionId,
    messageId: payload.messageId,
    attachments: (payload.attachmentIds || []).length,
  });

  const startedAt = Date.now();
  const { assistantTextChars, stopReason } =
    await consumeQuery(sdk.query({ prompt, options }));

  const newMtime = statMtimeMs(jsonlPath);

  log('info', 'resume done', {
    threadId,
    sessionId,
    stopReason,
    assistantTextChars,
    durationMs: Date.now() - startedAt,
    lastJsonlMtimeMs: newMtime,
  });

  return { stopReason, assistantTextChars, lastJsonlMtimeMs: newMtime };
};

// A turn that errored before producing ANY assistant output never called
// bridge_post — from the human's perspective that is pure dead air. Claude is
// the one engine whose driver doesn't relay output itself, so failures here
// MUST be surfaced explicitly.
const turnProducedNothing = (result) =>
  !!result &&
  !result.skipped &&
  String(result.stopReason || '').indexOf('error') !== -1 &&
  !(result.assistantTextChars > 0);

const postBridgeNotice = async ({ threadId, kind, body, log }) => {
  try {
    const r = await bridgeHttp.postMessage({
      threadId,
      author: 'claude-bridge',
      role: 'agent',
      kind: kind || 'error',
      body,
    });
    if (!r.ok) log('error', 'bridge notice post failed', { threadId, status: r.status });
  } catch (e) {
    log('error', 'bridge notice post threw', {
      threadId,
      error: e && e.message ? e.message : String(e),
    });
  }
};

const drive = (params) => {
  const key = params.threadId;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev
    .then(async () => {
      if (params.binding && params.binding.sessionId) {
        const result = await driveResume({
          threadId: params.threadId,
          sessionId: params.binding.sessionId,
          projectDir: params.binding.projectDir,
          jsonlPath: params.binding.jsonlPath,
          lastJsonlMtimeMs: params.binding.lastJsonlMtimeMs,
          payload: params.payload,
          log: params.log,
        });

        // Resume produced zero output and errored — the original engine
        // session is unusable (moved/deleted JSONL, corrupt state, wrong
        // machine). Fall back to a FRESH session: the Phase 5a history block
        // in driveFirstTouch carries the thread context across, so the user
        // gets a real answer instead of silence. Tell them what happened
        // first — honest context loss beats quiet failure.
        if (turnProducedNothing(result)) {
          params.log('warn', 'resume produced no output — falling back to fresh session with thread history', {
            threadId: params.threadId,
            sessionId: params.binding.sessionId,
            stopReason: result.stopReason,
          });
          await postBridgeNotice({
            threadId: params.threadId,
            kind: 'status',
            body: '⚠️ Could not resume the original local session (`' +
              params.binding.sessionId + '`) — its session file appears to be ' +
              'missing or unusable. Starting a fresh session seeded with this ' +
              'thread\'s history…',
            log: params.log,
          });
          const fresh = await driveFirstTouch({
            threadId: params.threadId,
            projectDir: (params.binding && params.binding.projectDir) || params.projectDir,
            payload: params.payload,
            log: params.log,
          });
          if (turnProducedNothing(fresh)) {
            await postBridgeNotice({
              threadId: params.threadId,
              kind: 'error',
              body: 'The fresh Claude session also failed (' + fresh.stopReason +
                ') before producing any output. Check the daemon log on the ' +
                'machine for the underlying SDK error.',
              log: params.log,
            });
          }
          return fresh;
        }
        return result;
      }

      const result = await driveFirstTouch({
        threadId: params.threadId,
        projectDir: params.projectDir,
        payload: params.payload,
        log: params.log,
      });
      if (turnProducedNothing(result)) {
        await postBridgeNotice({
          threadId: params.threadId,
          kind: 'error',
          body: 'The Claude session failed (' + result.stopReason + ') before ' +
            'producing any output. Check the daemon log on the machine for ' +
            'the underlying SDK error.',
          log: params.log,
        });
      }
      return result;
    })
    .catch(async (err) => {
      params.log('error', 'drive failed', {
        threadId: params.threadId,
        error: err && err.message ? err.message : String(err),
      });
      // Even hard throws must not be silent on the thread.
      await postBridgeNotice({
        threadId: params.threadId,
        kind: 'error',
        body: 'Claude turn failed on the daemon: ' +
          (err && err.message ? err.message : String(err)),
        log: params.log,
      });
      throw err;
    });
  queues.set(key, next);
  return next;
};

module.exports = {
  drive,
  buildEnvelope,
  buildBootstrapPrompt,
  tryResolvePermission,
};
