'use strict';

// Codex driver — drives an OpenAI Codex session per bridge thread, the Codex
// counterpart of claude-driver.js. Selected when config `agent` === 'codex'.
//
// Why this differs in shape from the Claude driver:
//
//   • No permission relay. Codex has no per-tool callback — only coarse
//     sandbox/approval modes. A Codex session runs unattended inside
//     cfg.codexSandbox (default 'workspace-write'). tryResolvePermission() is
//     a no-op.
//
//   • No bridge MCP tool. Codex cannot auto-approve a *write* MCP tool when
//     run non-interactively (openai/codex issue #15437) — so a Codex session
//     could never call a `bridge_post` tool itself. Instead this driver runs
//     the turn and posts the agent's final response to the bridge ON ITS
//     BEHALF (the "capture" model). Consequence: a Codex turn delivers exactly
//     one bridge message — its final answer — with no mid-task status updates
//     or agent-initiated questions. That is the ceiling of the Codex SDK, and
//     it keeps the integration free of any ~/.codex/config.toml mutation.
//
// SDK-specific calls are isolated in runCodex(), verified against
// @openai/codex-sdk@0.130.0.

const { loadConfig } = require('./config');
const { buildEnvelope } = require('./claude-driver');
const bridgeHttp = require('./bridge-http');
// Phase 5a — Codex has no MCP thread_read; its only shot at prior thread
// context is inline injection into the first prompt.
const { buildHistoryBlock } = require('./history');

// Per-thread promise queue — concurrent replies on one thread are serialized
// so first-touch completes before any resume. Mirrors claude-driver.
const queues = new Map();

const ALLOW_ALL = process.env.BRIDGE_ALLOW_ALL === '1';

// Phase 6.4 — Codex SDK doesn't accept image inputs yet. When the bridge
// payload carries attachmentIds, we prepend an honest note so the agent
// knows images existed (the human will see them in their own bubble on the
// bridge UI). When the SDK gains multimodal support, this can be replaced
// with a real image-in path.
const attachmentDropNote = (payload) => {
  const n = Array.isArray(payload && payload.attachmentIds)
    ? payload.attachmentIds.filter(Boolean).length
    : 0;
  if (!n) return '';
  return '[OBTO bridge note: ' + n + ' image attachment' + (n === 1 ? '' : 's') +
    ' came with this message, but the Codex driver does not support image ' +
    'input yet — proceeding with text only. Ask the human to describe the ' +
    'image in words if you need its content.]\n\n';
};

const buildCodexPrompt = (payload, isFirst, historyBlock) => {
  const head = (historyBlock || '') + attachmentDropNote(payload) + buildEnvelope(payload);
  if (!isFirst) return head;
  return head +
    '\n\n---\n' +
    'You are a Codex session spawned by the OBTO Agent Bridge to handle thread ' +
    '"' + payload.threadId + '". The human who sent the message above is on the ' +
    'OBTO bridge web UI — they do NOT see your terminal, your tool calls, or any ' +
    'intermediate output. They see ONLY your final response message, which is ' +
    'delivered to them verbatim.\n\n' +
    'Therefore: do the requested work, then make your final response a complete, ' +
    'self-contained answer addressed to that human. Markdown is supported. If you ' +
    'need information you do not have, make your final response a single clear ' +
    'question. Do not look for a "post" or "bridge" tool — there is none; simply ' +
    'produce the answer as your reply and it will be delivered.\n\n' +
    'Now handle the message above.';
};

// ── SDK boundary ──────────────────────────────────────────────────────────
// All @openai/codex-sdk-specific calls. Verified against codex-sdk@0.130.0.
const runCodex = async ({ prompt, projectDir, resumeId }) => {
  const { Codex } = await import('@openai/codex-sdk');
  const cfg = loadConfig();
  const codex = new Codex();

  const threadOpts = {
    workingDirectory: projectDir,
    sandboxMode: ALLOW_ALL
      ? 'danger-full-access'
      : (cfg.codexSandbox || 'workspace-write'),
    // 'never' is the documented non-interactive approval mode — the daemon is
    // unattended, so the agent must never block on a prompt. sandboxMode is
    // the actual safety boundary.
    approvalPolicy: 'never',
    // The bridge project dir is not necessarily a git repo — don't hard-fail.
    skipGitRepoCheck: true,
  };

  const thread = resumeId
    ? codex.resumeThread(resumeId, threadOpts)
    : codex.startThread(threadOpts);

  const turn = await thread.run(prompt);

  return {
    // Thread.id is populated once the first turn starts.
    sessionId: thread.id || resumeId || null,
    finalResponse: String((turn && turn.finalResponse) || ''),
  };
};
// ──────────────────────────────────────────────────────────────────────────

const postToBridge = async ({ threadId, body, kind, log }) => {
  try {
    const r = await bridgeHttp.postMessage({
      threadId,
      body,
      kind: kind || 'result',
      author: 'codex-bridge',
      role: 'agent',
    });
    if (!r.ok) {
      log('error', 'codex bridge post failed', { threadId, status: r.status });
    }
    return !!r.ok;
  } catch (e) {
    log('error', 'codex bridge post threw', {
      threadId,
      error: e && e.message ? e.message : String(e),
    });
    return false;
  }
};

const driveTurn = async ({ threadId, projectDir, resumeId, payload, log }) => {
  const isFirst = !resumeId;
  log('info', isFirst ? 'codex first-touch spawn' : 'codex resume', {
    threadId,
    projectDir,
    resumeId: resumeId || undefined,
    sandbox: ALLOW_ALL ? 'danger-full-access' : (loadConfig().codexSandbox || 'workspace-write'),
    messageId: payload.messageId,
  });

  const startedAt = Date.now();
  let sessionId = resumeId || null;
  let finalResponse = '';
  let failure = null;

  // Phase 5a — on first touch of a thread with prior bridge history (provider
  // switch or adopted thread), give Codex that history inline. Resumes don't
  // need it: the engine session already holds its own context.
  let historyBlock = '';
  if (isFirst) {
    historyBlock = await buildHistoryBlock({
      threadId,
      currentMessageId: payload.messageId,
      engineName: 'Codex',
      log,
    });
  }

  try {
    const res = await runCodex({
      prompt: buildCodexPrompt(payload, isFirst, historyBlock),
      projectDir,
      resumeId,
    });
    sessionId = res.sessionId || sessionId;
    finalResponse = res.finalResponse;
  } catch (e) {
    failure = e && e.message ? e.message : String(e);
  }

  // The driver delivers Codex's output — Codex cannot post for itself.
  if (failure) {
    await postToBridge({ threadId, kind: 'error', body: 'Codex run failed: ' + failure, log });
  } else if (finalResponse.trim()) {
    await postToBridge({ threadId, kind: 'result', body: finalResponse, log });
  } else {
    await postToBridge({
      threadId,
      kind: 'error',
      body: 'Codex completed the turn but produced no final response.',
      log,
    });
  }

  log('info', isFirst ? 'codex first-touch done' : 'codex resume done', {
    threadId,
    sessionId,
    ok: !failure && !!finalResponse.trim(),
    assistantTextChars: finalResponse.length,
    durationMs: Date.now() - startedAt,
  });

  // If the run failed before Codex even produced a thread id, there is no
  // session to bind — surface it so the daemon logs a handle failure.
  if (failure && !sessionId) {
    throw new Error('codex run failed before a thread id was assigned: ' + failure);
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
      params.log('error', 'codex drive failed', {
        threadId: params.threadId,
        error: err && err.message ? err.message : String(err),
      });
      throw err;
    });
  queues.set(key, next);
  return next;
};

// Codex has no per-tool permission callback — there is nothing to relay, so
// the daemon's reply path always proceeds straight to drive().
const tryResolvePermission = () => false;

module.exports = { drive, tryResolvePermission };
