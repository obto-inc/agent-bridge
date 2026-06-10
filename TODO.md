# OBTO Agent Bridge — Open Items

**As of `0.1.0-beta.25` (2026-06-10, published to npm).** Companion to [ARCHITECTURE.md](ARCHITECTURE.md) — that doc describes what exists; this one tracks what doesn't yet.

---

## P0 — blocking / housekeeping

- [ ] **Resolve the codebase relocation discrepancy.** `trunk/OBTO/agent-bridge-daemon/` holds a stale v1 snapshot (`0.2.0-pre`, mid-May, Claude-only — no Phase 6 work). The real beta.23 source is this repo. Decide: sync beta.23 over there and make it the canonical home, or delete the stale copy. Until then, all edits happen HERE.
- [x] ~~**Stripe activation** (Queue #4).~~ Done 2026-06-10 in TEST mode: product `prod_UgBKGHGKF1lA7E`, price `price_1TgoxlAAIZsR5bQ3kTOAbVEC` ($10/mo USD); properties `co.obto.bridge.stripe.price_id`, `co.obto.bridge.stripe.trial_days=14`, `co.obto.bridge.checkout_url=https://app.obto.co/ms/v2/bridge_checkout` (the old relative `.bto` default was doubly broken — wrong host AND wrong suffix). `bridge_checkout` now applies property-driven `trial_period_days`. No pod reboot needed (properties are read per-request). **Remaining for live launch:** run one test-card checkout end-to-end (4242…), then switch the platform Stripe key to live mode, re-create product/price live (re-enable the one-shot `bridge_billing_setup` route in obpay — currently 410-disabled), and update the price_id property.
- [x] ~~**README pricing section** (Queue #5).~~ Done 2026-06-10 ($10/mo, 14-day trial, model usage never proxied/marked up).

## P1 — vision-defining features

- [x] ~~**Phase 5a — provider switching, stage 1 (history injection).**~~ Shipped in beta.24: all three drivers prepend the bridge thread's recent history (≤40 msgs / 24KB) to the engine's first prompt on a thread that already has conversation. `src/history.js#buildHistoryBlock`.
- [ ] **Phase 5b — Hindsight summarization handoff.** Replace the raw-transcript block with a Hindsight-distilled summary (only `buildHistoryBlock` changes — drivers stay untouched). Design doc not yet written.
- [ ] **Phase 7 — cross-machine routing.** Daemons advertise which sessionIds they hold locally; bridge routes each reply to the machine that actually has the session, instead of first-claim-wins-forever. Fixes the "thread is dead because the claiming machine is offline" failure.
- [ ] **Phase 2b race-fix remainder.** Claim protocol is in, but the v1.1 notes flagged a residual race window during claim + first-touch overlap; re-verify under two live daemons.

## P2 — feature gaps

- [ ] **Media v2.** PDF/text attachment support; thumbnails for the chip preview; size-cap UX (client-side reject before upload); S3-compatible storage swap inside `BridgeAttachment` when load justifies it.
- [ ] **Codex/OpenCode image input.** Currently dropped with an honest note. Revisit when `@openai/codex-sdk` / `@opencode-ai/sdk` grow multimodal input.
- [ ] **OpenCode sub-sessions in discovery.** Scanner surfaces top-level sessions only (`parent_id IS NULL`). One-line toggle in `opencode-sqlite-scanner.js` if sub-session visibility is wanted.
- [ ] **Password reset flow (UI).** Backlog since onboarding shipped; currently a manual support path.
- [ ] **VSCode-extension chat coverage.** Diagnostic (2026-06) showed 112 VSCode chat files skipped (0 with parseable content). Decide whether that format is worth a scanner.
- [ ] **Thread-delete → daemon binding cleanup.** Deleting a thread in the UI leaves the daemon's state.json binding for it; the (still-existing) local session is then filtered from external sync as "owned" and won't resurface for re-adoption until the binding is manually cleared. Needs a thread-deleted event to daemons (or a binding TTL).

## P3 — polish / debt

- [ ] **Daemon as a service.** `nohup` is the current run mode; ship launchd plist (macOS) + systemd unit (Linux) via `obto-bridge install-service`.
- [ ] **view route size.** Single server-rendered route is ~1,000 lines of string-concatenated HTML/CSS/JS. Works, but every patch is line-number surgery. Consider splitting CSS/JS into separate served artifacts.
- [ ] **External-scan efficiency.** Daemon re-sends all ~150 sessions every 30s tick (`upserted: 0` most ticks). Add an mtime/contents-hash skip so unchanged sessions aren't re-shipped.
- [ ] **Attachment GC.** No cleanup for orphaned attachments (uploaded but never sent) or attachments of deleted threads. Add a sweep.
- [ ] **`agent_bridge_external_sessions` allowlist for obto_db_query.** Collection not in the app's `exposedCollections`, so platform data tools can't inspect it; add it for debuggability.

## Standing rules (do not regress)

- Never rely on `cfg.projectDir` as a resume-cwd fallback — refuse non-absolute adoption paths (honest context loss > silent misroute).
- `BRIDGE_ALLOW_ALL=1` is for controlled experiments only, never long-term.
- New external-source scanners must ALSO extend `SUPPORTED_SOURCES` in the `BridgeExternal` server script — unknown sources silently coerce to `'claude'`.
- New `pltf_script_server` scripts: don't re-`require` `path`/`crypto` (pre-injected; parse error silently blocks `xe.*` registration); `fs` must still be required; pod restart needed for first registration.
- Verify after upsert: `ok:true` proves the Mongo write, not that the script compiled.
