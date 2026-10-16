#!/usr/bin/env node
'use strict';

const subcommands = {
  init:                '../cli/init',
  start:               '../cli/start',
  status:              '../cli/status',
  whoami:              '../cli/whoami',
  logout:              '../cli/logout',
  'rotate-token':      '../cli/rotate-token',
  'install-service':   '../cli/install-service',
  'uninstall-service': '../cli/uninstall-service',
};

const usage = () => {
  console.error('Usage: obto-bridge <command>');
  console.error('');
  console.error('Commands:');
  console.error('  init --link <LNK-…>   Link this machine to your OBTO login (code from app.obto.co →');
  console.error('                        account home → Agent Bridge). Writes ~/.obto-bridge/config.json.');
  console.error('  init                  Bridge-only account (email) or paste a token via --token/--account.');
  console.error('  install-service       Run the daemon in the background, start at login (launchd / systemd).');
  console.error('  uninstall-service     Stop the background daemon and remove the unit.');
  console.error('  start                 Run the daemon (foreground).');
  console.error('  status                Daemon health (connected / reconnecting / stopped) + bindings. --json');
  console.error('  whoami         Verify config and show your account info from the server.');
  console.error('  rotate-token   Rotate your API token; old token is invalidated, config is updated.');
  console.error('  logout         Wipe local credentials at ~/.obto-bridge/config.json.');
  console.error('');
  console.error('Flags:');
  console.error('  --version, -v          Print the installed package version.');
  console.error('  --help, -h             Show this help.');
  console.error('  --username <name>      (init only) Override the username derived from email.');
  console.error('  --password <pwd>       (init only) Set your password instead of auto-generating one.');
  console.error('  --token <obto_…>       (init only) Skip self-serve register, use this token.');
  console.error('  --account <acc_…>      (init only) Pair with --token for paste-in mode.');
  console.error('  --agent-id <name>      (init only) Machine name shown in the UI (default: hostname).');
  console.error('  --project-dir <path>   (init only) Directory the daemon drives agents in (default: cwd).');
  console.error('  --discovery <level>    (init only) metadata (default) | full — what the session scanner sends.');
};

const cmd = process.argv[2];

if (cmd === '--version' || cmd === '-v') {
  const pkg = require('../package.json');
  console.log(pkg.version);
  process.exit(0);
}

const target = subcommands[cmd];

if (!target) {
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
    usage();
    process.exit(cmd === undefined ? 2 : 0);
  }
  console.error('obto-bridge: unknown command: ' + cmd);
  console.error('');
  usage();
  process.exit(2);
}

require(target);
