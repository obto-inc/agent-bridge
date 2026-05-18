# @obtoai/agent-bridge

A local daemon that lets a coding agent — [Claude Code](https://claude.ai/code) or [OpenAI Codex](https://developers.openai.com/codex) — running on your machine be driven from the [OBTO Agent Bridge](https://obto.co) web UI, even when you're away from the keyboard.

You post a message on a thread from your phone or laptop. The daemon (running on your machine, no port forwarding required) receives it over a long-lived HTTPS stream, spawns or resumes an agent session in your project directory, and the response posts back to the bridge thread within seconds.

## Status

**Closed beta.** Need an invite? Email **support@obto.co** with your name and a short note about what you'd use it for. We'll provision an account and mail you credentials.

## What you'll need

- macOS, Linux, or Windows, **Node.js 18.17+**
- One coding agent installed, with your own auth:
  - **Claude** — Claude Code / the Claude Agent SDK, billed to your Anthropic account; or
  - **Codex** — the `codex` CLI (`npm i -g @openai/codex`), signed in to your OpenAI/ChatGPT account
- An invite from `support@obto.co` (gives you an `accountId`, browser username/password, and an API token)

## Install

```bash
npm install -g @obtoai/agent-bridge
```

Or run without installing:

```bash
npx @obtoai/agent-bridge <command>
```

## Setup

```bash
obto-bridge init
```

Walks you through a few questions: your account ID, API token, an agent name (to distinguish multiple machines on one account), which coding agent to drive (`claude` or `codex`), the project directory to work in, and whether to relay tool-permission requests via the bridge. (The server URL is a built-in default; advanced / self-hosted users can override it with the `BRIDGE_BASE_URL` env var.)

Config lands at `~/.obto-bridge/config.json` (mode 0600). Safe to commit your account ID; **never commit the `apiToken`**.

### claude vs codex

Both drive real coding work on your machine; they differ in how they report back:

- **claude** — the fuller integration. Posts status updates, questions, and results as it works (via an in-process MCP tool), and supports the human-in-the-loop tool-permission relay.
- **codex** — runs the task and delivers one final answer per turn. No mid-task updates and no per-tool relay (the Codex SDK exposes neither); it runs unattended inside a sandbox (`workspace-write` by default, override with `BRIDGE_CODEX_SANDBOX`).

One daemon drives one agent. To run both, use two daemons on two accounts.

## Run

```bash
obto-bridge start
```

You'll see two log lines and then the daemon waits silently:

```
{"msg":"starting daemon","data":{"accountId":"acc_...","agentId":"my-mac",...}}
{"msg":"sse stream connected","data":{"status":200}}
```

Now open the bridge UI in any browser, log in with the browser credentials from your invite, and either:

- Reply on an existing thread — daemon resumes the session bound to that thread
- Start a new thread via the **+ New thread** button — daemon spawns a fresh session in your project directory

Within ~5–10 seconds you should see the agent's reply appear back on the thread.

## Other commands

| Command | What it does |
|---|---|
| `obto-bridge whoami` | Verify your token works + show your account info |
| `obto-bridge status` | List active thread→session bindings |
| `obto-bridge logout` | Wipe `~/.obto-bridge/config.json` |

## How it actually works

```
Your phone        OBTO server                      Your machine
─────────         ───────────                      ────────────
[reply form] ──►  /api/reply ─► Mongo (durable)
                  └─►  RabbitMQ (publish bridge.<acct>.reply.<thread>)
                                                ◄── /api/bridge/stream  (SSE, Bearer auth)
                                                    └─► daemon process
                                                        └─► Claude Agent SDK
                                                            └─► session JSONL in
                                                                ~/.claude/projects/...
                  /api/message ◄────  bridge_post (in-process MCP tool from daemon)
[poll: /api/messages] ◄──── (4s loop)
```

Key bits:

- The daemon **never** holds RabbitMQ credentials; broker access stays server-side. Per-account routing key isolation enforced by `BridgeAuth`.
- The daemon's spawned Claude session uses an **in-process MCP server** (`mcp__bridge__bridge_post`) — not the platform's hosted MCP, so the daemon's tools don't depend on a long-lived OBTO MCP proxy session.
- Each bridge **thread** binds to its own agent **session ID** at first message. Subsequent messages on the same thread resume the same session, so the agent keeps full context. Your interactive sessions are unaffected — they live in separate session stores.
- Per-thread serialization means rapid bursts on the same thread are handled in order, never racing the same session.
- With **codex**, there is no in-process MCP tool — the Codex SDK can't auto-approve a write tool when run unattended, so the daemon captures Codex's final response and posts it to the thread on the agent's behalf.

## Agent costs

The daemon runs your chosen agent on your machine with **your** credentials — Anthropic for `claude` (whatever Claude Code uses: `ANTHROPIC_API_KEY` or your Claude.ai session), or your OpenAI/ChatGPT account for `codex`. Every bridge-driven turn is a normal API call billed to you. We don't proxy.

## Data handling

**Your model traffic never touches us.** The daemon runs on your machine and calls Anthropic or OpenAI with *your own* credentials. Your prompts, your code, and the model's responses pass directly between your machine and the model provider, under your own API account and its terms. OBTO does not proxy, route, or see that traffic.

**What the bridge stores.** For threads to work, the messages you and the agent post are saved in OBTO's database — that's what makes a thread durable and readable from your phone. Threads are strictly scoped to your account; one tenant can never see another's. Your daemon's API token is stored server-side only as a SHA-256 hash; the plaintext token never leaves your local config file.

**What we don't do with it.** OBTO does not use your bridge messages to train models, and does not sell or share your data with third parties.

**Deletion.** Email `support@obto.co` to delete your account and every message associated with it.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Reporting issues

`https://github.com/obto-inc/agent-bridge/issues`

Daemon-side issues: please include the relevant section of daemon stdout (it's structured JSON; redact your `apiToken` if it appears).
