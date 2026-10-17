# @obtoai/agent-bridge

A local daemon that lets coding agents — [Claude Code](https://claude.ai/code), [OpenAI Codex](https://developers.openai.com/codex), or [opencode](https://opencode.ai) — running on your machine be driven from the [OBTO Agent Bridge](https://obto.co) web UI, even when you're away from the keyboard.

You post a message on a thread from your phone or laptop. The daemon (running on your machine, no port forwarding required) receives it over a long-lived HTTPS stream, spawns or resumes a session for the agent that thread is bound to, and the response posts back to the bridge thread within seconds.

**Have an OBTO login? Three commands and every local Claude Code / Codex / opencode session shows up in your OBTO DevZone:**

```bash
npm install -g @obtoai/agent-bridge
obto-bridge init              # opens the browser: sign in to OBTO, approve this machine
obto-bridge install-service   # daemon runs in the background, starts at login
```

No OBTO login yet? `obto-bridge init --register` creates a bridge-only account inline — see [Setup](#setup).

## Status

**Public beta.** Self-serve. `obto-bridge init` creates an account inline — no waiting on an invite, no support email loop.

## Pricing

**$10/month, flat per account** — with a **14-day free trial** (card required at subscribe; cancel anytime during the trial at no charge). The subscription covers the relay service: the web UI, the secure message relay, and durable thread storage across all your machines.

**Model usage is never included or marked up** — your agents run on your machine under your own Anthropic/OpenAI/provider credentials, billed directly to you. The bridge doesn't proxy model traffic.

Invite accounts provisioned before billing activation keep full access with no subscription. Manage your subscription at `https://agent-bridge.obto.co/api/bridge/billing`.

## What you'll need

- macOS, Linux, or Windows, **Node.js 18.17+**
- At least one coding agent installed on the machine (the daemon drives whichever ones it finds, with your own auth):
  - **Claude** — Claude Code / the Claude Agent SDK, billed to your Anthropic account.
  - **Codex** — the `codex` CLI (`npm i -g @openai/codex`), signed in to your OpenAI/ChatGPT account.
  - **opencode** — `npm i -g opencode-ai` (the `opencode` CLI; the daemon bundles the `@opencode-ai/sdk`). Auth is your own provider key (Anthropic by default; override with env vars below).

## Install

```bash
npm install -g @obtoai/agent-bridge
```

Or run without installing:

```bash
npx @obtoai/agent-bridge <command>
```

## Setup

### Linked to your OBTO login (recommended)

**Browser sign-in (default).** On the machine:

```bash
npx @obtoai/agent-bridge@latest init        # same as: obto-bridge login
```

It prints a link and a code like `ABCD-EFGH` and opens your browser at `https://app.obto.co/api/bridge/device?user_code=ABCD-EFGH`. Sign in to OBTO there, check that the page shows the same code and machine name, and click **Approve**. The terminal finishes on its own and saves `{accountId, apiToken, tenant}` to `~/.obto-bridge/config.json` (mode 0600), exactly as `--link` does. Approving also turns on Agent Bridge for your login if it was off. The code expires after 10 minutes; **Deny** discards the request. Your OBTO login token never leaves the browser — the machine only receives its own bridge token.

On an SSH session, or with `--no-browser`, nothing is opened: open the printed link on any device where you are signed in to OBTO. Approve only a code you just saw in your own terminal — anyone who gets you to approve their code gets a bridge token for your login.

Same optional flags as below (`--agent-id`, `--project-dir`, `--discovery`). Like `--link`, signing in rotates the account token: other machines on the same account are signed out until they sign in again.

**One-time link code (alternative).**

1. Sign in at `https://app.obto.co`, open your account home and click **Enable Bridge** (or **Add another machine** if the module is already on). You get a one-time code `LNK-XXXX-XXXX-XXXX-XXXX` — single use, expires in ~15 minutes.
2. On the machine:

```bash
npx @obtoai/agent-bridge@latest init --link LNK-XXXX-XXXX-XXXX-XXXX
```

That `POST`s the code to `https://app.obto.co/api/bridge/link/exchange` and saves the returned `{accountId, apiToken, tenant}` to `~/.obto-bridge/config.json` (mode 0600). No email, no password, no prompts. It prints `✓ linked to <tenant> as <your OBTO user>`. Optional flags: `--agent-id <machine name>` (default: hostname), `--project-dir <path>` (default: current directory), `--discovery metadata|full` (see [Data handling](#data-handling)).

A code that was already used, or expired, answers `HTTP 404 link_code_invalid` — issue a new one from account home → **Add another machine**. Re-linking an account that already has a token **rotates** the token: other machines on the same account are signed out until they re-link with their own code.

3. Run it as a service (macOS launchd / Linux systemd `--user`):

```bash
npm install -g @obtoai/agent-bridge     # the service needs a permanent install, not the npx cache
obto-bridge install-service
obto-bridge status                      # → Daemon: connected
```

Within a minute your account home card shows the machine online and every local session appears as a thread in DevZone (titles, paths, timestamps and a short preview by default — see [Data handling](#data-handling)).

### Bridge-only account (no OBTO login)

```bash
obto-bridge init --register
```

`init --register` asks for one thing — your email. Username is derived from the email's local part (`divyansh.verma@gmail.com` → `divyansh-verma`); password is auto-generated as a strong 12-char string and **shown once** in stdout for you to save. It then creates the account inline via `POST /api/bridge/register`, saves the returned API token to `~/.obto-bridge/config.json` (mode 0600), and asks for an agent name (so multiple machines on the same account don't collide), the project directory the daemon should work in, a *fallback* agent (`claude` / `codex` / `opencode` — used only for legacy events without an explicit agent), and whether to relay tool-permission requests via the bridge. Sign in at `https://agent-bridge.obto.co/api/view` as `@username` with the generated password to start a thread.

Overrides:

- `obto-bridge init --register --username <name>` — pick your own username instead of the derived one.
- `obto-bridge init --register --password <pwd>` — set your own password instead of auto-generating.
- `obto-bridge init --token obto_xxxxxxxx --account acc_xxxxxxxx` — skip registration entirely (paste-in for existing users or scripted/headless setups).
- `obto-bridge init --agent-id <name> --project-dir <path> --discovery metadata|full` — answer those prompts from the command line.

The API token is shown to you exactly once at registration time. **Save it.** If you lose it, rotate it from your account settings — it is not stored in readable form server-side. Safe to commit your `accountId`; **never commit the `apiToken`**. (Server URL is a built-in default; advanced / self-hosted users can override with the `BRIDGE_BASE_URL` env var.)

### Agents (claude / codex / opencode)

v1.1 makes the daemon **agent-agnostic per event**: at startup it detects which of `claude`, `codex`, and `opencode` are installed on the machine, advertises that to the bridge, and routes each incoming reply to the right driver based on what the thread is bound to in the UI. You can switch a thread's agent live from the thread header; each engine keeps its own session for that thread, so flipping claude→codex→claude resumes each side's context.

How the three differ in how they report back:

- **claude** — the fullest integration. Posts status updates, mid-task questions, and final results as it works (via an in-process MCP tool), and supports the human-in-the-loop tool-permission relay.
- **codex** — runs the turn and delivers one final answer per turn. No mid-task updates and no per-tool relay (the Codex SDK exposes neither). Runs unattended inside a sandbox (`workspace-write` by default, override with `BRIDGE_CODEX_SANDBOX`).
- **opencode** — same capture-model shape as codex: one final answer per turn, no mid-task chatter. Defaults to provider `anthropic` and model `claude-sonnet-4-5`; override with `BRIDGE_OPENCODE_PROVIDER` and `BRIDGE_OPENCODE_MODEL`.

Picking a model is done in the bridge UI's **+ New thread** dialog and the thread-header switcher — not in the daemon config.

### Multi-daemon (running across more than one machine)

You can run the same account's daemon on more than one machine (e.g. a Mac and a Windows box). Each daemon advertises its `agentId` (machine name) + capabilities on connect; threads are atomically **first-touch claimed** by whichever daemon gets the event first, and every other daemon skips the event cleanly. No duplicate replies, no special configuration — just install + start the daemon on each machine.

## Run

### As a service (recommended)

```bash
obto-bridge install-service
```

- **macOS:** writes `~/Library/LaunchAgents/com.obto.agent-bridge.plist` and loads it (`RunAtLoad`, `KeepAlive` on crash only, 30 s throttle). The PATH baked into the plist is your current shell PATH plus the directory of the `node` that ran the command, so nvm installs and `claude`/`codex`/`opencode` resolve.
- **Linux:** writes `~/.config/systemd/user/obto-bridge.service` (`Restart=on-failure`, `RestartSec=30`) and runs `systemctl --user enable --now`. For a box you are not logged in to, also run `loginctl enable-linger $USER`.
- Logs go to `~/.obto-bridge/daemon.log` (a log over 10 MB is rotated to `daemon.log.1` once at install time).
- Re-run `install-service` after `init` / `init --link` to pick up a new token; `obto-bridge uninstall-service` removes the unit (config and logs stay).

**Reconnects and failures.** The SSE stream reconnects with capped exponential backoff (1 s → 60 s, jittered). While the bridge is unreachable the log prints one `cannot reach the bridge for N min` line per minute, with the real network error (`ENOTFOUND`, `ECONNREFUSED`, …) instead of a bare `fetch failed`, and `obto-bridge status` shows `reconnecting`. A **401** (token revoked by *Disable Bridge*, a rotation, or another machine re-linking), **402** (no plan) or **403** (suspended) is final: the daemon prints the fix, records it for `status`, and exits *without* being restarted by the service — retrying a dead token every 30 s helps nobody. Re-link and run `install-service` again.

### Foreground

```bash
obto-bridge start
```

You'll see two log lines and then the daemon waits silently:

```
{"msg":"starting daemon","data":{"accountId":"acc_...","agentId":"my-mac","capabilities":["claude","codex"],...}}
{"msg":"sse stream connected","data":{"status":200}}
```

`capabilities` is the list of agents this daemon will accept — the bridge UI offers exactly the union across your connected machines.

Now open the bridge UI in any browser, log in with the browser credentials from your invite, and either:

- Reply on an existing thread — daemon resumes the session bound to that thread (and to whichever agent the thread currently uses).
- Start a new thread via the **+ New thread** button — pick Claude, Codex, or Opencode; the daemon spawns a fresh session in your project directory.

Within ~5–10 seconds you should see the agent's reply appear back on the thread.

## Other commands

| Command | What it does |
|---|---|
| `obto-bridge whoami` | Verify your token works + show your account info |
| `obto-bridge status` | Daemon health (`connected` / `reconnecting` / `stopped (auth)` with the fix), last sync, service state, then bindings per (thread, agent). `--json` for scripts |
| `obto-bridge install-service` / `uninstall-service` | Background daemon via launchd (macOS) or systemd `--user` (Linux) |
| `obto-bridge rotate-token` | Rotate the API token (bridge-only accounts; linked accounts re-link with a new code instead) |
| `obto-bridge logout` | Wipe `~/.obto-bridge/config.json` |

## How it actually works

```
Your phone        OBTO server                      Your machine(s)
─────────         ───────────                      ───────────────
[reply form] ──►  /api/reply ─► Mongo (durable)
                  └─►  RabbitMQ (publish bridge.<acct>.reply.<thread>,
                                 payload carries agent + agentId)
                                                ◄── /api/bridge/stream  (SSE, Bearer auth)
                                                    └─► daemon (dispatches per payload.agent)
                                                        ├─► Claude Agent SDK   → ~/.claude/projects/...
                                                        ├─► @openai/codex-sdk  → ~/.codex/sessions/...
                                                        └─► @opencode-ai/sdk   → opencode server
                  /api/message ◄────  bridge_post (in-process MCP tool, Claude only)
[poll: /api/messages] ◄──── (4s loop)
```

Key bits:

- The daemon **never** holds RabbitMQ credentials; broker access stays server-side. Per-account routing key isolation enforced by `BridgeAuth`.
- For the **claude** driver, the spawned Claude session uses an **in-process MCP server** (`mcp__bridge__bridge_post`) — not the platform's hosted MCP, so the daemon's tools don't depend on a long-lived OBTO MCP proxy session. For **codex** and **opencode**, the SDKs can't auto-approve a write tool when run unattended, so the daemon captures the final response and posts it to the thread on the agent's behalf.
- Each bridge **thread** binds to its own session ID **per agent**. Subsequent messages on the same thread + same agent resume the same engine-specific session, so the agent keeps full context. Switching the thread's agent in the UI starts (or resumes) the other engine's session — each side's state stays intact. Your interactive sessions are unaffected — they live in separate session stores.
- Per-thread serialization means rapid bursts on the same thread are handled in order, never racing the same session.
- Multi-daemon races are killed by atomic first-touch claim against the thread record on the bridge.

## Agent costs

The daemon runs your chosen agent on your machine with **your** credentials — Anthropic for `claude` (whatever Claude Code uses: `ANTHROPIC_API_KEY` or your Claude.ai session); your OpenAI/ChatGPT account for `codex`; whichever provider you've configured `opencode` to call (Anthropic by default for this daemon). Every bridge-driven turn is a normal API call billed to you. We don't proxy.

## Data handling

**Your model traffic never touches us.** The daemon runs on your machine and calls Anthropic, OpenAI, or whichever provider opencode is configured for, with *your own* credentials. Your prompts, your code, and the model's responses pass directly between your machine and the model provider, under your own API account and its terms. OBTO does not proxy, route, or see that traffic.

**Session discovery (`discovery` in `~/.obto-bridge/config.json`, or `BRIDGE_DISCOVERY`).** Every 30 s the daemon scans the local session stores of Claude Code, Codex and opencode and reports them to the bridge so they appear in your OBTO DevZone. What leaves the machine depends on one setting:

| `discovery` | Sent per session | Default |
|---|---|---|
| `metadata` | session id, engine, project path, title, timestamps, one ≤200-character preview of the last message. **No transcript turns** — `recentMessages` is stripped before the request is built. | yes |
| `full` | all of the above plus the last ~10 turns (`recentMessages`), so adopted threads show history before your first reply | opt-in: `obto-bridge init --link … --discovery full`, or edit the key and restart |

The request carries the level (`discovery: "metadata"|"full"`) and the bridge mirrors transcript turns only when it says `full`.

**Full history of an adopted thread.** When you reply in DevZone on a local session's thread, the daemon resumes that session and sends its complete history to the thread once, so the web view shows the whole conversation. Under `metadata` your reply is the consent: it covers **that thread only**, and a session nobody replied on never sends transcript turns. Under `full` every adopted thread gets its history. In both modes the daemon first removes Claude Code and Codex harness wrappers from your turns (`<system-reminder>` blocks, which can contain your email address, git status and memory files; `<command-name>`, `<local-command-stdout>` and similar command echoes; Codex `<environment_context>`), and drops turns that are empty after that. The ≤200-character preview is cleaned the same way.

**What the bridge stores.** For threads to work, the messages you and the agent post are saved in OBTO's database — that's what makes a thread durable and readable from your phone. Threads are strictly scoped to your account; one tenant can never see another's. Your daemon's API token is stored server-side only as a SHA-256 hash; the plaintext token never leaves your local config file.

**What we don't do with it.** OBTO does not use your bridge messages to train models, and does not sell or share your data with third parties.

**Deletion.** Email `support@obto.co` to delete your account and every message associated with it.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Reporting issues

`https://github.com/obto-inc/agent-bridge/issues`

Daemon-side issues: please include the relevant section of daemon stdout (it's structured JSON; redact your `apiToken` if it appears).
