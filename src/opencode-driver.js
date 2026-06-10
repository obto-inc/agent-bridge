'use strict';

// Opencode driver — drives an opencode session per bridge thread, the
// opencode counterpart of codex-driver.js. Selected when payload.agent ===
// 'opencode'. Same capture-model shape as Codex: opencode runs the turn, this
// driver posts the agent's final response to the bridge on its behalf.
//
// Why this is shaped like the Codex driver (and not Claude):
//
//   • No bridge MCP tool exposed to opencode. Easiest path is the SDK's
//     session.prompt() and concatenating returned text parts as the answer.
//
//   • No fine-grained permission relay. opencode's SDK gives a single
//     prompt-in / parts-out call per turn. tryResolvePermission() is a no-op.
//
// SDK-specific calls are isolated in runOpencode(), verified against
// @opencode-ai/sdk@^1.16 (Node SDK docs as of 2026-05-21).

const { loadConfig } = require('./config');
const { buildEnvelope } = require('./claude-driver');
const bridgeHttp = require('./bridge-http');
// Phase 5a — opencode has no MCP thread_read; prior thread context arrives
// via inline injection into the first prompt, same as the Codex driver.
const { buildHistoryBlock } = require('./history');

// Per-thread promise queue — concurrent replies on one thread are serialized
// so first-touch completes before any resume. Mirrors codex-driver.
const queues = new Map();

// Defaults can be overridden per-machine via env. Anthropic Claude is the
// default because users running opencode usually already have Claude auth.
const DEFAULT_PROVIDER = process.env.BRIDGE_OPENCODE_PROVIDER || 'anthropic';
const DEFAULT_MODEL = process.env.BRIDGE_OPENCODE_MODEL || 'claude-sonnet-4-5';

// Phase 6.4 — opencode's SDK accepts only `parts:[{type:'text',text}]`. When
// the bridge payload carries attachmentIds, we prepend an honest note so the
// agent knows images existed (the human will see them in their own bubble on
// the bridge UI). Upgrade to real image parts when opencode-ai/sdk grows
// support for file/image parts.
const attachmentDropNote = (payload) => {
  const n = Array.isArray(payload && payload.attachmentIds)
    ? payload.attachmentIds.filter(Boolean).length
    : 0;
  if (!n) return '';
  return '[OBTO bridge note: ' + n + ' image attachment' + (n === 1 ? '' : 's') +
    ' came with this message, but the opencode driver does not support image ' +
    'input yet — proceeding with text only. Ask the human to describe the ' +
    'image in words if you need its content.]\n\n';
};

const buildOpencodePrompt = (payload, isFirst, historyBlock) => {
  const head = (historyBlock || '') + attachmentDropNote(payload) + buildEnvelope(payload);
  if (!isFirst) return head;
  return head +
    '\n\n---\n' +
    'You are an opencode session spawned by the OBTO Agent Bridge to handle ' +
    'thread "' + payload.threadId + '". The human who sent the message above ' +
    'is on the OBTO bridge web UI — they do NOT see your terminal, your tool ' +
    'calls, or any intermediate output. They see ONLY your final response, ' +
    'delivered to them verbatim.\n\n' +
    'Therefore: do the requested work, then make your final response a ' +
    'complete, self-contained answer addressed to that human. Markdown is ' +
    'supported. If you need information you do not have, make your final ' +
    'response a single clear question. Now handle the message above.';
};

// Best-effort extraction of the assistant's final text from an opencode
// prompt result. The SDK returns `{ parts: [...] }` or `{ data: { parts } }`
// depending on the call; we tolerate both and concatenate every text part.
const extractFinalResponse = (result) => {
  if (!result) return '';
  const parts = (result && result.parts) ||
    (result && result.data && result.data.parts) ||
    [];
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
    .map((p) => String(p.text || ''))
    .join('\n')
    .trim();
};

// ── SDK boundary ──────────────────────────────────────────────────────────
// All @opencode-ai/sdk calls. The SDK spawns a local opencode HTTP server;
// we tear it down at the end of every turn (cheap, simple, no shared state).
const runOpencode = async ({ prompt, projectDir, resumeId }) => {
  const { createOpencode } = await import('@opencode-ai/sdk');
  const handle = await createOpencode({ directory: projectDir });
  const client = handle.client;
  const closeHandle = handle.close || (handle.server && handle.server.close);

  try {
    let sessionId = resumeId;
    if (!sessionId) {
      const created = await client.session.create({
        body: { title: 'obto-bridge' },
      });
      sessionId = (created && created.id) ||
        (created && created.data && created.data.id) ||
        null;
    }

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: DEFAULT_PROVIDER, modelID: DEFAULT_MODEL },
        parts: [{ type: 'text', text: prompt }],
      },
    });

    return {
      sessionId: sessionId || (result && result.sessionId) || null,
      finalResponse: extractFinalResponse(result),
    };
  } finally {
    try { if (typeof closeHandle === 'function') await closeHandle(); } catch (_) {}
  }
};
// ──────────────────────────────────────────────────────────────────────────

const postToBridge = async ({ threadId, body, kind, log }) => {
  try {
    const r = await bridgeHttp.postMessage({
      threadId,
      body,
      kind: kind || 'result',
      author: 'opencode-bridge',
      role: 'agent',
    });
    if (!r.ok) {
      log('error', 'opencode bridge post failed', { threadId, status: r.status });
    }
    return !!r.ok;
  } catch (e) {
    log('error', 'opencode bridge post threw', {
      threadId,
      error: e && e.message ? e.message : String(e),
    });
    return false;
  }
};

const driveTurn = async ({ threadId, projectDir, resumeId, payload, log }) => {
  const isFirst = !resumeId;
  log('info', isFirst ? 'opencode first-touch spawn' : 'opencode resume', {
    threadId,
    projectDir,
    resumeId: resumeId || undefined,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    messageId: payload.messageId,
  });

  const startedAt = Date.now();
  let sessionId = resumeId || null;
  let finalResponse = '';
  let failure = null;

  // Phase 5a — on first touch of a thread with prior bridge history (provider
  // switch or adopted thread), give opencode that history inline. Resumes
  // don't need it: the engine session already holds its own context.
  let historyBlock = '';
  if (isFirst) {
    historyBlock = await buildHistoryBlock({
      threadId,
      currentMessageId: payload.messageId,
      engineName: 'opencode',
      log,
    });
  }

  try {
    const res = await runOpencode({
      prompt: buildOpencodePrompt(payload, isFirst, historyBlock),
      projectDir,
      resumeId,
    });
    sessionId = res.sessionId || sessionId;
    finalResponse = res.finalResponse;
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
  }

  // Capture model — the driver delivers opencode's output.
  if (failure) {
    await postToBridge({ threadId, kind: 'error', body: 'Opencode run failed: ' + failure, log });
  } else if (finalResponse) {
    await postToBridge({ threadId, kind: 'result', body: finalResponse, log });
  } else {
    await postToBridge({
      threadId,
      kind: 'error',
      body: 'Opencode completed the turn but produced no final response.',
      log,
    });
  }

  log('info', isFirst ? 'opencode first-touch done' : 'opencode resume done', {
    threadId,
    sessionId,
    ok: !failure && !!finalResponse,
    assistantTextChars: finalResponse.length,
    durationMs: Date.now() - startedAt,
  });

  if (failure && !sessionId) {
    throw new Error('opencode run failed before a session id was assigned: ' + failure);
  }

  // jsonlPath/lastJsonlMtimeMs are Claude-specific — null keeps the binding
  // shape consistent for daemon.js / state.js.
  return {
    sessionId,
    projectDir,
    jsonlPath: null,
    lastJsonlMtimeMs: null,
    stopReason: failure ? 'error' : 'done',
    assistantTextChars: finalResponse.length,
  };
};

const drive = (params) => {
  const key = params.threadId;
  const prev = queues.get(key) || Promise.resolve();
  const next = prev
    .then(() => {
      const binding = params.binding;
      const resuming = binding && binding.sessionId;
      return driveTurn({
        threadId: params.threadId,
        projectDir: resuming ? binding.projectDir : params.projectDir,
        resumeId: resuming ? binding.sessionId : null,
        payload: params.payload,
        log: params.log,
      });
    })
    .catch((err) => {
      params.log('error', 'opencode drive failed', {
        threadId: params.threadId,
        error: err && err.message ? err.message : String(err),
      });
      throw err;
    });
  queues.set(key, next);
  return next;
};

// Opencode has no per-tool permission callback exposed by the SDK — there is
// nothing to relay, same shape as the Codex driver.
const tryResolvePermission = () => false;

module.exports = { drive, tryResolvePermission };
