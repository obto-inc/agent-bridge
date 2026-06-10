'use strict';

// Phase 2b — what this machine can drive.
//
// `claude` and `opencode` are bundled SDKs (declared in package.json) and
// self-contained: claude uses the Claude Agent SDK; opencode uses
// @opencode-ai/sdk's createOpencode() which spawns its own local HTTP server.
// Neither needs a CLI on PATH — they're always advertised.
//
// `codex` uses @openai/codex-sdk which delegates to the user's `codex` CLI
// for auth/config, so we still probe PATH for it.
//
// Sent to the bridge as `?capabilities=claude,codex,...` on SSE connect; the
// bridge records them in `agent_bridge_daemons` so the UI picker can offer
// only what's actually installable across the account's machines.

const { spawnSync } = require('child_process');

const onPath = (cmd) => {
  try {
    const tool = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(tool, [cmd], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
};

const detect = () => {
  const out = ['claude', 'opencode']; // bundled SDKs; always advertised
  if (onPath('codex')) out.push('codex');
  return out;
};

module.exports = { detect, onPath };
