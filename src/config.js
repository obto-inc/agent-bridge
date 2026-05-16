'use strict';

// Loads daemon config from `~/.obto-bridge/config.json`, with env overrides.
// Env always wins so users can run the daemon non-interactively in CI / launchd
// without touching the config file.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.obto-bridge');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const loadConfig = () => {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    // File missing/invalid — fall back to env-only.
  }

  const cfg = {
    baseUrl: process.env.BRIDGE_BASE_URL || file.baseUrl || 'https://agent-bridge.obto.co',
    originHost: process.env.BRIDGE_ORIGIN_HOST || file.originHost || 'agent-bridge.obto.co',
    accountId: process.env.BRIDGE_ACCOUNT_ID || file.accountId || '',
    apiToken: process.env.BRIDGE_API_TOKEN || file.apiToken || '',
    agentId: process.env.AGENT_ID || file.agentId || 'unnamed-agent',
    projectDir: path.resolve(
      process.env.BRIDGE_PROJECT_DIR || file.projectDir || process.cwd(),
    ),
    // Which coding agent the daemon drives: 'claude' (Claude Agent SDK) or
    // 'codex' (Codex SDK). Claude is the default and the more capable driver
    // (per-tool permission relay); Codex runs unattended in a fixed sandbox.
    agent: String(process.env.BRIDGE_AGENT || file.agent || 'claude')
      .trim()
      .toLowerCase(),
    // Codex-only: filesystem sandbox for unattended Codex sessions, since
    // Codex has no per-tool human relay. read-only | workspace-write |
    // danger-full-access. BRIDGE_ALLOW_ALL=1 forces danger-full-access.
    codexSandbox:
      process.env.BRIDGE_CODEX_SANDBOX || file.codexSandbox || 'workspace-write',
    // Optional / advanced
    relayPermissions: (process.env.BRIDGE_RELAY_PERMISSIONS === '1') || !!file.relayPermissions,
    allowAll: (process.env.BRIDGE_ALLOW_ALL === '1') || !!file.allowAll,
    relayTimeoutMs:
      parseInt(process.env.BRIDGE_RELAY_TIMEOUT_MS, 10) ||
      file.relayTimeoutMs ||
      600000,
    liveGuardDisabled: (process.env.BRIDGE_LIVE_GUARD_DISABLED === '1') || !!file.liveGuardDisabled,
    liveThresholdMs:
      parseInt(process.env.BRIDGE_LIVE_THRESHOLD_MS, 10) ||
      file.liveThresholdMs ||
      60000,
  };

  if (!cfg.apiToken) {
    throw new Error(
      'No apiToken configured. Set BRIDGE_API_TOKEN env or write to ' + CONFIG_PATH,
    );
  }

  return cfg;
};

module.exports = { loadConfig, CONFIG_DIR, CONFIG_PATH };
