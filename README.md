# @obtoai/agent-bridge

A local daemon that lets coding agents — [Claude Code](https://claude.ai/code), [OpenAI Codex](https://developers.openai.com/codex), or [opencode](https://opencode.ai) — running on your machine be driven from the [OBTO Agent Bridge](https://obto.co) web UI, even when you're away from the keyboard.

You post a message on a thread from your phone or laptop. The daemon (running on your machine, no port forwarding required) receives it over a long-lived HTTPS stream, spawns or resumes a session for the agent that thread is bound to, and the response posts back to the bridge thread within seconds.

**Three commands, you're driving Claude/Codex/opencode on your phone:**

```bash
npm install -g @obtoai/agent-bridge
obto-bridge init     # creates a free account inline — no card, no invite
obto-bridge start    # daemon connects, you're live
```

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

```bash
obto-bridge init
```

`init` asks for one thing — your email. Username is derived from the email's local part (`divyansh.verma@gmail.com` → `divyansh-verma`); password is auto-generated as a strong 12-char string and **shown once** in stdout for you to save. It then creates the account inline via `POST /api/bridge/register`, saves the returned API token to `~/.obto-bridge/config.json` (mode 0600), and asks for an agent name (so multiple machines on the same account don't collide), the project directory the daemon should work in, a *fallback* agent (`claude` / `codex` / `opencode` — used only for legacy events without an explicit agent), and whether to relay tool-permission requests via the bridge. Sign in at `https://agent-bridge.obto.co/api/view` as `@username` with the generated password to start a thread.

Overrides:

- `obto-bridge init --username <name>` — pick your own username instead of the derived one.
- `obto-bridge init --password <pwd>` — set your own password instead of auto-generating.
- `obto-bridge init --token obto_xxxxxxxx --account acc_xxxxxxxx` — skip registration entirely (paste-in for existing users or scripted/headless setups).

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
| `obto-bridge status` | List bindings per (thread, agent) — one row per engine that's ever driven a thread |
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

**What the bridge stores.** For threads to work, the messages you and the agent post are saved in OBTO's database — that's what makes a thread durable and readable from your phone. Threads are strictly scoped to your account; one tenant can never see another's. Your daemon's API token is stored server-side only as a SHA-256 hash; the plaintext token never leaves your local config file.

**What we don't do with it.** OBTO does not use your bridge messages to train models, and does not sell or share your data with third parties.

**Deletion.** Email `support@obto.co` to delete your account and every message associated with it.

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Reporting issues

`https://github.com/obto-inc/agent-bridge/issues`

Daemon-side issues: please include the relevant section of daemon stdout (it's structured JSON; redact your `apiToken` if it appears).
