# OBTO Agent Bridge — Architecture Blueprint

**Status:** living document. Accurate as of `@obtoai/agent-bridge@0.1.0-beta.25` (2026-06-10, published to npm).
**Audience:** any developer who needs to understand, extend, or operate the Agent Bridge — both the local daemon (this repo) and the cloud application (built on the OBTO platform).

---

## 1. Vision and end goal

### The problem

Developers now run *multiple* AI coding agents, often simultaneously: Claude Code in a terminal, Claude Desktop on the same machine, Codex in another tab, OpenCode in its own desktop app — across more than one computer. Each agent holds conversations the others know nothing about, each stores them in its own format, and every one of them is **trapped on the machine it runs on**. Step away from the desk and every conversation freezes.

### The product

Agent Bridge is a **remote-control surface for local AI coding agents**. One web URL — `https://agent-bridge.obto.co/api/view` — that:

1. **Shows every conversation** across every supported agent on every machine the user has enrolled (both bridge-originated threads and externally discovered ones).
2. **Lets the user continue any of them** from any browser, including a phone — the reply routes to the original agent on the original machine and resumes the original session with full context.
3. **Lets the agent reach back** to the human through the same thread, even though the human isn't watching the terminal.

### The north star

The conversation is the source of truth, not the agent. The long-term goal is that a user can:

- switch a thread between providers (Claude ↔ Codex ↔ OpenCode) mid-conversation with context preserved (Phase 5, via OBTO's Hindsight knowledge graph),
- have the bridge route replies to whichever **machine** actually holds the session (Phase 7, cross-machine routing),
- and treat the bridge as a chief-of-staff over a fleet of agents rather than a viewer of individual ones.

Commercially, the bridge is a self-serve product: email-based registration, flat per-account billing (Stripe integration built, activation pending), distributed as an npm package.

---

## 2. System overview

Three components. The daemon and the browser never talk to each other directly — everything flows through the bridge cloud app.

```
┌─────────────┐         ┌──────────────────────────┐         ┌─────────────────────────┐
│   Browser    │  HTTPS  │   Bridge cloud app        │   SSE   │   Daemon (per machine)   │
│  (any device)│ ───────▶│   (OBTO platform app      │ ───────▶│   @obtoai/agent-bridge   │
│              │◀─────── │    `ob-agent-bridge`,     │◀─────── │                          │
│  /api/view   │  SSE +  │    domain `core`)         │  HTTPS  │  drives local agents via │
│              │  poll   │                           │  POST   │  their SDKs              │
└─────────────┘         │  Mongo + RabbitMQ (AMQP)  │         └─────────────────────────┘
                        └──────────────────────────┘                      │
                                                            ┌─────────────┼──────────────┐
                                                            ▼             ▼              ▼
                                                      Claude Agent     Codex SDK    OpenCode SDK
                                                      SDK (resume      (thread      (self-spawned
                                                      via JSONL)       resume)      HTTP server)
```

**Message flow for one reply (happy path):**

1. User types a reply in the browser → `POST /api/reply`.
2. The route persists the message to `agent_bridge_messages`, then publishes an AMQP event with routing key `bridge.<accountId>.reply.<threadId>`.
3. The broker fans the event out to every connected daemon for that account over the SSE stream (`GET /api/bridge/stream`).
4. The winning daemon (see §6.3, claim protocol) resolves which agent and which session the thread is bound to, and calls the agent's SDK with the new message (`resume: sessionId`, `cwd: projectDir`).
5. The agent does its work and posts its answer back via the in-process MCP tool `mcp__bridge__bridge_post` → `POST /api/message` → persisted → pushed to the browser over its own SSE connection.

Wall-clock from phone tap to agent receiving the message: typically < 1 second.

---

## 3. Component inventory — daemon (this repo)

All files under `src/`. Node ≥ 18.17, zero runtime deps beyond the three agent SDKs.

| File | Responsibility |
|---|---|
| `daemon.js` | Main loop. Connects SSE, dispatches reply events, runs the external-discovery scan timer, handles the multi-daemon claim, synthesizes adoption bindings. |
| `config.js` | Loads `~/.obto-bridge/config.json` with env-var overrides (env always wins — CI/launchd friendly). Re-read on every HTTP call and SSE reconnect so token rotation needs no restart. |
| `state.js` | Persistent thread→session bindings at `~/.agent-bridge-daemon/state.json`. v1.1 schema keeps **one session per agent per thread** (`bindings.<threadId>.sessions.{claude,codex,opencode}`) so provider switches resume each engine's own context. v1 flat bindings migrate on load. |
| `stream-client.js` | Dependency-free SSE consumer over `fetch` + ReadableStream. Exponential backoff 1s→30s. `getHeaders` callback re-resolves auth per reconnect. |
| `bridge-http.js` | Authenticated HTTP client for all bridge calls. Bearer `apiToken` + `OBTO-ORIGIN-HOST` header (routes to the app even when DNS is cold). Includes `getAttachmentBytes` (Phase 6.4). |
| `driver.js` | Per-event dispatch to the right agent driver, lazily `require`d and cached. Fallback agent comes from config. |
| `claude-driver.js` | The richest driver. First-touch vs resume, per-thread promise queue (serializes concurrent events on one thread), JSONL freshness guard (opt-in), permission relay (§6.4), multimodal prompt assembly (§6.5), bootstrap prompt that teaches the session to use `bridge_post`. |
| `codex-driver.js` | Codex SDK (`startThread`/`resumeThread`). No tool-permission callback exists in the SDK, so safety = sandbox mode (`workspace-write` default; `BRIDGE_ALLOW_ALL=1` → `danger-full-access`, never long-term). Final response is relayed by the daemon itself via `POST /api/message`. |
| `opencode-driver.js` | OpenCode SDK. `createOpencode({directory})` spawns a local HTTP server per turn, torn down after. Session create/resume + `session.prompt` with text parts. |
| `bridge-mcp-server.js` | In-process MCP server (`createSdkMcpServer`) injected into every Claude session the daemon spawns. Two tools: `bridge_post` and `bridge_thread_read`. This is the **agent→human back-channel**. |
| `capabilities.js` | What this machine advertises (`?capabilities=` on SSE connect). `claude` + `opencode` are bundled SDKs → always advertised. `codex` needs its CLI on PATH → probed. |
| `external-scanner.js` | External Thread Discovery for JSONL-based tools: Claude Code (`~/.claude/projects/`), Claude Desktop (`~/Library/Application Support/Claude/local-agent-mode-sessions/**/.claude/projects/`), Codex (`~/.codex/sessions/Y/M/D/`). Streaming backward tail-read (64KB chunks, 512KB cap), ai-title extraction, message coalescing, injection-noise filtering, markdown-preserving whitespace normalization. |
| `opencode-sqlite-scanner.js` | Same discovery for OpenCode's SQLite store (`~/.local/share/opencode/opencode.db`), shared by its CLI and desktop app. Reads via `sqlite3 -readonly -json` subprocess (no native dep; WAL-safe concurrent reads). Top-level sessions only (`parent_id IS NULL`). |
| `session-scanner.js` | `encodeProjectDir` and friends — maps a project path to Claude's JSONL directory naming. |
| `bin/obto-bridge.js`, `cli/` | CLI: `init` (self-serve registration), `start`, `rotate-token`. |

### Daemon configuration surface

`~/.obto-bridge/config.json`, every key overridable by env:

| Key | Env | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `BRIDGE_BASE_URL` | `https://agent-bridge.obto.co` | Bridge cloud base |
| `originHost` | `BRIDGE_ORIGIN_HOST` | `agent-bridge.obto.co` | Sent as `OBTO-ORIGIN-HOST` |
| `accountId` / `apiToken` | `BRIDGE_ACCOUNT_ID` / `BRIDGE_API_TOKEN` | — | Account identity. Token required. |
| `agentId` | `AGENT_ID` | `unnamed-agent` | **Machine** identity (one per computer) |
| `projectDir` | `BRIDGE_PROJECT_DIR` | `cwd` | Default cwd for first-touch sessions |
| `agent` | `BRIDGE_AGENT` | `claude` | Fallback agent for legacy events |
| `codexSandbox` | `BRIDGE_CODEX_SANDBOX` | `workspace-write` | Codex filesystem sandbox |
| `relayPermissions` | `BRIDGE_RELAY_PERMISSIONS` | off | Claude per-tool human approval via bridge |
| `allowAll` | `BRIDGE_ALLOW_ALL` | off | ⚠️ disables all permission gating; never long-term |

---

## 4. Component inventory — bridge cloud app

The backend is an **OBTO platform app**: `ob-agent-bridge` in domain `core`, served at `agent-bridge.obto.co` (wildcard `*.obto.co` ingress → `obto5-app` pod on the obto1 LKE cluster). Every artifact below is a MongoDB record (`pltf_script_server` / `pltf_route`), deployed via OBTO MCP tools and hot-reloaded — **there is no separate repo or CI pipeline for the backend**.

### 4.1 Server scripts (`pltf_script_server`, callable as `xe.<Name>`)

| Script | Responsibility |
|---|---|
| `BridgeData` | Core data layer. Threads (`agent_bridge_threads`: per-thread routing — bound agent, claimed `agentId`, `externalAdoption` payload), messages (`agent_bridge_messages`: idempotent insert via unique sparse `clientMsgId`, `attachments[]` link list), daemons (`agent_bridge_daemons`: capability advertising). `listThreads` merges message aggregates with zero-message routing records so freshly adopted threads stay visible. `claimThread` is the atomic conditional update that kills the multi-daemon race. |
| `BridgeAuth` | Account auth. Bearer `apiToken` for daemons/scripts, session cookie for browsers (`requireAuth(req,res,{browser:true})`). Self-serve registration creates the account + token. |
| `BridgeBroker` | AMQP publisher. `publishReply` → `bridge.<acct>.reply.<thread>`; activity pings → `bridge.<acct>.activity.<thread>`. |
| `BridgeExternal` | External-session store (`agent_bridge_external_sessions`). Bulk upsert keyed `(accountId, sessionId)`, `SUPPORTED_SOURCES = ['claude','codex','opencode']` (unknown sources are coerced to `claude` — extend this list when adding a scanner!), `markAdopted`, 60-day `pruneStale`, listing excludes already-adopted rows and projects out `recentMessages`. |
| `BridgeAttachment` | Phase 6.4 media. Files on the pod volume at `/mnt/data/media/bridge-attachments/<accountId>/<threadId>/<attachmentId>.<ext>`; metadata in `agent_bridge_attachments`. 25 MB cap, image-mime allowlist, account-ownership check on read. ⚠️ Sandbox gotchas: `path`/`crypto` are pre-injected globals (re-`require` = parse error that silently blocks `xe.*` registration); `crypto` is WebCrypto-shaped (`getRandomValues`, no `randomBytes`); `fs` must still be required. |

### 4.2 Routes (`pltf_route`, router `api`, all under `/api/...`)

| Route | Method/path | Purpose |
|---|---|---|
| `view` | `GET /api/view` | The entire web UI — a single server-rendered route (~1,000 lines). Sidebar (threads + external + search), chat pane, reply form (text + paperclip + mic), SSE-primary live updates with polling fallback, client-side markdown renderer, light/dark CSS, agent switcher, permission approve/deny buttons. |
| `postReply` | `POST /api/reply` | Human reply ingestion. Validates, verifies attachment ownership, persists, AMQP-publishes with `agent`, `agentId`, `externalAdoption`, `attachmentIds`. |
| `message` | `POST /api/message` | Agent-side message ingestion (used by `bridge_post` and the codex/opencode drivers). |
| `messages` | `GET /api/messages` | Cursor-paginated thread read (also the browser's polling fallback and the MCP `bridge_thread_read` backend). |
| `streamSubscribe` | `GET /api/bridge/stream` | SSE endpoint for BOTH daemons (Bearer; registers capabilities) and browsers (cookie). Bridges AMQP → SSE. |
| `claimThread` | `POST /api/bridge/thread/claim` | Atomic first-touch claim (Phase 2b). |
| `threadAgent` | `POST /api/bridge/thread/agent` | Thread-header provider switcher. |
| `agentActivity` | `POST /api/bridge/agent-activity` | Transient typing indicator (RMQ only, not persisted). |
| `externalSync` | `POST /api/bridge/external/sync` | Daemon scanner upload (30s ticks). |
| `externalList` / adopt | `GET /api/bridge/external/list`, adopt form posts | Sidebar external section + adoption (creates thread with `externalAdoption`, `markAdopted`, backfills `recentMessages` as real messages). |
| `uploadAttachment` | `POST /api/bridge/attachment/upload` | JSON + base64 image upload (no multipart dependency). |
| `getAttachment` | `GET /api/bridge/attachment/:attachmentId` | Auth-checked streaming read; used by both `<img>` tags and the daemon. |
| `repairLimboAdoptions` | `POST` (admin) | Re-backfills adopted threads from external rows; `force:true` wipes and rebuilds. |
| registration/login/rotate-token | various | Self-serve onboarding; `obto-bridge init` drives these. |

### 4.3 Mongo collections

| Collection | Key shape | Notes |
|---|---|---|
| `agent_bridge_messages` | `(accountId, threadId, createdAt)` idx; unique sparse `clientMsgId` | The conversation source of truth. `attachments: [attachmentId]`. |
| `agent_bridge_threads` | unique `(accountId, threadId)` | Routing only: `agent`, `agentId` (claimed machine), `externalAdoption {sessionId, projectDir, projectName, source}`. |
| `agent_bridge_daemons` | unique `(accountId, agentId)` | `capabilities[]`, `lastSeenAt`. Feeds the UI's provider picker. |
| `agent_bridge_external_sessions` | unique `(accountId, sessionId)` | Discovery inventory. `adoptedThreadId` marks consumed rows. |
| `agent_bridge_attachments` | unique `attachmentId` | Metadata + `storagePath`; bytes live on the pod volume. |

---

## 5. External Thread Discovery and Adoption (Phase 6)

The signature feature: conversations that **did not** originate on the bridge appear in the sidebar and can be "adopted" into bridge threads that resume the original engine session.

### 5.1 Discovery

Every 30s the daemon scans all known storage formats and POSTs a normalized shape to `externalSync`:

```js
{ source: 'claude'|'codex'|'opencode', sessionId, projectDir, projectName,
  title, recentMessages: [{role, body, ts}], lastActivityAt,
  lastMessagePreview, lastMessageAuthor }
```

Sessions the daemon itself created (tracked in `state.json`) are filtered out — they're bridge threads already.

Format-specific notes:

- **Claude (CLI + Desktop):** same JSONL format, different roots. Titles come from late-appended `type:"ai-title"` records (walk the tail backward). Assistant turns fragment across JSONL lines (tool_use parts) → consecutive same-role lines are coalesced. `<system-reminder>`/injection noise is filtered from user turns. Whitespace normalization preserves `\n\n` so markdown survives.
- **Codex:** `rollout-<ts>-<sid>.jsonl` under date dirs; `cwd` comes from the meta line *when present* (see §5.2 for when it isn't).
- **OpenCode:** SQLite, not JSONL. `session.directory` is the cwd; `session.title` is maintained by the app itself.

### 5.2 Adoption and resume

Clicking an external row:

1. Creates a bridge thread whose routing record carries `externalAdoption` (persisted on `$setOnInsert` — first write wins).
2. Marks the external row `adoptedThreadId` (it disappears from the External list; `listThreads` keeps the new thread visible even with zero messages).
3. Backfills `recentMessages` into `agent_bridge_messages` so the user sees history immediately.

On the user's **first reply**, `postReply` attaches `externalAdoption` to the AMQP payload. The daemon, finding no local binding for `(thread, agent)`, synthesizes one:

```js
session = { sessionId: ea.sessionId, projectDir: resumeCwd, jsonlPath: null, ... }
```

…and the driver's normal resume path takes over. After the first successful drive the binding persists to `state.json` and `externalAdoption` stops mattering.

**Critical guard:** if the adoption record carries no absolute path (`resumeCwd` doesn't start with `/`), the daemon **refuses** to synthesize the binding, logs loudly, and lets the driver first-touch fresh. The prior fallback to `cfg.projectDir` silently resumed sessions in the wrong directory — honest context loss beats silent corruption. Keep this property when touching the adoption path.

---

## 6. Key design decisions and protocols

### 6.1 SSE-primary, polling-fallback (browser)

The browser opens its own SSE connection and ingests reply events directly (deduped by `data-mid`). Polling (`/api/messages?since=`) engages **only** when SSE errors, and releases after one catch-up poll on reconnect. The daemon side is SSE-only with exponential backoff.

### 6.2 The envelope and bootstrap prompt (Claude)

Every message forwarded into a Claude session is wrapped in an envelope header (`[OBTO Agent Bridge | thread:… | from:… | ts:… | messageId:…]`). On first touch, a bootstrap prompt teaches the session the rules: the human is NOT watching the terminal, the ONLY reply channel is `mcp__bridge__bridge_post`, end every turn with a post, prefer `mcp__bridge__*` over any similarly-named external tools. Codex/OpenCode get a simpler variant: their final response is delivered verbatim by the daemon, so the prompt says "make your final message the complete answer."

### 6.3 Multi-daemon claim (Phase 2b)

Multiple machines = multiple daemons on one SSE topic. Routing:

1. If the event carries a non-null `agentId` (thread already claimed) and it isn't this machine → skip.
2. If `agentId` is null → `POST /bridge/thread/claim`, which is a single conditional Mongo update (`{agentId: null} → {$set: {agentId}}`). Exactly one daemon's update matches; it wins. Everyone else reads the winner and skips.

### 6.4 Permission relay (Claude only, opt-in)

With `BRIDGE_RELAY_PERMISSIONS=1`, tools outside the read-only allowlist (`Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `NotebookRead`, `TodoWrite`, both `mcp__bridge__*` tools) trigger a `kind:"question"` bridge message with Approve/Deny buttons in the UI. The reply resolves the pending SDK permission callback (single-pending-per-thread, 10-min default timeout). Codex/OpenCode have no SDK permission callback — their safety boundary is the sandbox mode.

### 6.5 Attachments and voice (Phase 6.4)

- **Upload:** browser → base64 JSON → `BridgeAttachment.store` → chip preview → reply form carries `attachmentIds[]`.
- **Delivery to Claude:** the daemon downloads each attachment (Bearer-authed) and builds a multimodal first message — image blocks before the text envelope — passed to the SDK as an async-iterable prompt. Text-only path is untouched (zero overhead).
- **Codex/OpenCode:** no image input support in their SDKs yet; the prompt is prefixed with an honest "[N image attachment(s) came with this message… proceeding with text only]" note.
- **Voice:** browser Web Speech API (`webkitSpeechRecognition`), ~40 lines, no server cost. Mic button hidden on unsupported browsers (Firefox).
- **Storage choice:** local pod volume deliberately, not S3 — swap is internal to `BridgeAttachment` when scale demands it.

### 6.6 Capability advertising

Daemons announce `?capabilities=claude,opencode[,codex]` on SSE connect → `agent_bridge_daemons` → UI provider picker. Rule of thumb learned the hard way: **gate on the actual dependency, not a proxy.** Claude + OpenCode SDKs are bundled (always advertised); only Codex genuinely needs its CLI on PATH.

---

## 7. Security model

- **Identity:** one account = one `accountId` + rotatable Bearer `apiToken` (CLI `rotate-token`; daemon picks rotation up without restart). Browsers use session cookies.
- **Tenancy:** every read/write is scoped by `accountId` server-side. Attachment reads verify ownership before streaming. `postReply` verifies attachment IDs belong to the caller before linking (forged IDs are dropped).
- **Agent safety:** Claude defaults to a read-only tool allowlist + optional human permission relay. Codex/OpenCode default to `workspace-write` sandbox. `BRIDGE_ALLOW_ALL=1` exists for controlled experiments only — standing rule: never long-term.
- **Filesystem hygiene:** attachment path segments are sanitized (`[^a-zA-Z0-9_-] → _`); state dir is `0700`.
- **Idempotency:** `clientMsgId` unique-sparse index makes daemon retries safe.

---

## 8. Operations

### Deploying the daemon

```bash
npm publish            # from this repo; version in package.json
# user side:
npm i -g @obtoai/agent-bridge && obto-bridge init && obto-bridge start
```

Local dev runs straight from source: `nohup node bin/obto-bridge.js start > ~/.obto-bridge/daemon.log 2>&1 &`. Logs are JSON-lines.

### Deploying the bridge backend

There is no repo/CI. Server scripts and routes are Mongo records edited via OBTO MCP tools (`obto_upsert_record`, `obto_create_route`, `obto_update_route`, `obto_patch_artifact`) against app `ob-agent-bridge`, domain `core`. Routes hot-reload immediately. **New** server scripts need a pod restart to register on `xe.*`:

```bash
KUBECONFIG=k8/nodes/obto1-kubeconfig.yaml kubectl -n default rollout restart deploy/obto5-app
```

Debugging: `obto_get_app_logs` surfaces runtime logs, but **parse-time** failures (e.g. re-requiring an injected global) never reach it — check the pod log for the Babel stack when a new script reports `xe.X is not a constructor`.

### Known operational gotchas

- npm registry replication can lag a publish by minutes (`notarget` on install) — `npm cache clean --force` + explicit version, or run from source.
- One `Mcp-Session-Id` is shared across parallel Claude conversations per install — coordinate `set_active_app` handoffs.
- `obto_upsert_record ok:true` proves the Mongo write, **not** that the script compiles. Fetch back + smoke-test before declaring deployment.

---

## 9. Current limitations

| Limitation | Impact | Planned fix |
|---|---|---|
| Thread bound to one machine after claim | Reply to a thread whose machine is offline goes nowhere | Phase 7 cross-machine routing (daemons advertise local sessionIds) |
| Provider switch loses cross-engine context | Each engine resumes only its own session history | Phase 5 Hindsight handoff |
| Attachments on single pod volume | No horizontal scaling of media | Swap `BridgeAttachment` internals to S3-compatible |
| Codex/OpenCode can't receive images | Text-only with honest drop note | Upstream SDK support |
| OpenCode discovery surfaces top-level sessions only | Sub-sessions invisible | One-line toggle in `opencode-sqlite-scanner.js` if wanted |
| No password reset UI | Manual support path | Backlog |

---

## 10. Roadmap snapshot

1. **Phase 5 — provider switching with context preservation.** The vision-defining piece: flip a thread Claude↔Codex mid-conversation, context carried via Hindsight summarization. Per-agent session state (`state.json` v1.1) was built specifically to make this possible.
2. **Phase 7 — cross-machine routing.** Daemons advertise which sessionIds they hold; the bridge routes per-thread to the right machine instead of first-claim-wins.
3. **Billing activation.** Stripe product config + app reboot (self-serve registration and flat-per-account billing already built).
4. **Media v2.** PDFs/text attachments, thumbnails, S3 swap when load justifies it.

---

## 11. Version history (abridged)

| Version | Milestone |
|---|---|
| beta.3 | v1.1 per-thread model selection (Claude/Codex picker) |
| beta.7–8 | Self-serve onboarding (`obto-bridge init`, email = username) |
| beta.10–17 | Phase 6.1–6.2: External Thread Discovery + adoption + resume |
| beta.18–20 | Streaming tail, message coalescing, markdown preservation, Claude Desktop coverage, sidebar titles |
| beta.21 | Sidebar search; adoption-cwd guard (refuse non-absolute resume paths) |
| beta.22 | Phase 6.4: image attachments end-to-end + voice-to-text |
| beta.23 | Phase 6.4.1 + 6.5: opencode always advertised; OpenCode SQLite discovery |
| beta.24–25 | Phase 6.6 + 5a: full thread history (newest-N `listMessages` fix, `before=` backward pagination + "Load older" in the UI, full-history adoption backfill via `/api/bridge/external/backfill`); thread delete end-to-end (`deleteThread` route, attachments cleanup, external row un-adopt for re-adoption); Phase 5a provider-switch history injection (all three drivers prepend bridge thread history on first touch — pre-Hindsight handoff); Claude driver never fails silently (resume failure → bridge notice + fresh-session fallback seeded with thread history); Phase 6.7 vanished-session reconciliation (daemon ships full inventory per tick; bridge hides + rejects adoption of sessions whose local file is gone); Stripe billing activated in test mode ($10/mo, 14-day trial, property-driven price/trial/checkout-url) |
