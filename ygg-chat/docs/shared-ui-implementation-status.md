# Shared UI implementation status

This is an implementation checkpoint, **not completion of the full shared-client plan**.

Plan: `.ygg/plans/graviton-shared-ui-multiclient-v1.md` at the Graviton repository root.

## Implemented foundation

- `build:browser-client` builds the existing React entry/component tree into `dist-browser`; desktop file loading remains unchanged.
- Electron host configuration serves that built public tree at the host root. Root/client build wrappers and Electron packaging include the browser output.
- Browser bootstrap checks public host protocol/identity before app/store startup effects. Browser identity projects the existing managed host state without credentials or token migration. Cloud sign-in currently directs users to complete it on the Electron host.
- Core app/query/provider/chat gates distinguish shared-host features from native shell capabilities. IDE/job sockets use the host origin and per-document identities. HTTP LAN command IDs do not require secure-context `crypto.randomUUID`.
- Run transport supports multiple subscribers, isolates disconnects, removes no-viewer idle cancellation, bounds replay bytes and slow-subscriber queues, preserves nonterminal errors, and suppresses duplicate client sequence projection.
- Gateway self-HTTP is pinned to the actual internal listener rather than incoming Host.

## Still required before feature acceptance

- Authoritative snapshots/discovery and snapshot/tree revision handshake.
- Atomic same-lineage admission/automatic queue and durable command receipts.
- Shared pending-decision snapshots/resolution receipts. Production host resumability is now mandatory; the old connection-bound route branch still needs final compatibility cleanup.
- Host settings/prompt ownership, cross-client invalidation, revisioned saves and cache/account reconciliation.
- PTY/LSP/iframe browser parity, native fallbacks, host path picker, responsive phone access.
- Full network origin/exposure policy and packaged/real-phone/Tailscale acceptance.
- Retire the old mobile UI only after these gates. It remains intentionally present for now.

`/api/host/runtime` advertises `sharedRuns: false` because transport fanout alone is not complete multi-client run support. Do not promote this checkpoint as the finished feature.

## Validation observed

- Focused baseline: 15 renderer and 21 headless tests passed before edits.
- Full renderer suite: 1,073 passed at the initial checkpoint; later focused auth/ID/stream tests also passed.
- Browser renderer build, Electron renderer/main builds and standalone server build passed (6 GiB Node heap for production bundling).
- `node scripts/test-browser-client.cjs`: two isolated Chromium windows without preload mounted shared login using a synthetic host. This is not end-to-end chat/workspace/phone proof.
- `node scripts/test-chat-selection-electron.cjs`: all 10 existing real React/Electron selection checks passed.
- Matching Electron ABI server suite: 195 passed, 1 skipped. System Node instead fails SQLite loading (native ABI 139 versus 147); dependencies were not rebuilt or changed.
- Matching Electron ABI headless suite: 787 passed, 17 failed, 24 todo. Failures include unchanged outdated SQLite fixtures/expectations and the committed subagent-description assertion. The implementation's old unattended-watch reaper assertion was updated and its focused suite passes.
- Vite reports existing large-chunk/static-dynamic import warnings. The root package manifest uses existing CRLF endings, which `git diff --check` reports on its edited line; no whole-file line-ending rewrite performed.

## Review

The existing Claude Fable 5.1 session was resumed, preserving its plan-review history: `679efd5b-7eb6-42f4-a1d5-974e67dc76ac`. Two implementation-checkpoint review passes completed. The follow-up reported all requested blocker fixes present and no new blocker for this partial slice. It did not approve the full feature as complete. The reviewer missed the existing `server/headlessServer/stream/runSubscriber.test.ts`; its drain-order/overflow tests were run and passed. A bounded late-event warning was added for cancellation-fallback unwind diagnostics.

## Continue safely

No source edits were delegated. Do not discard current work. Re-read the plan's binding review amendments before continuing. Temporary structured handoff: `.ygg/artifacts/shared-ui-implementation-progress.json` at repository root. Browser access remains a trusted-network prototype, not authenticated remote deployment.

## Continuation implementation (2026-10-19)

The migration is substantially further along, but **the full plan is still not complete**. The old mobile UI remains because its retirement gates have not been met. `sharedRuns: false` remains deliberate; do not interpret successful unit/build checks as full acceptance.

### Added in this continuation

- Append-only migrations **7–9**: host-owned message revisions, transactional bounded metadata outbox, and durable command acceptance receipts. SQLite triggers cover real message updates without JS double increments; no-op updates retain revision. Sink rows are reread after lineage changes. Completed receipts survive restart; uncertain accepted commands become interrupted and are never replayed automatically.
- JSON ordinary-send admission now feeds the shared engine; compatible concurrent same-lineage sends queue, including pending startup/empty-conversation ownership. Read-only ancestry classification rejects sibling, unknown, foreign and idle historical parents. Legacy POSTs adapt to the same service; direct queue submissions also receive durable receipts. Queue request fingerprints cover the full submission; access-policy mismatches reject without elevating a live run or successor.
- Main-run discovery and schema-versioned bootstrap at sequence S; exact host row revisions and compact current-turn projection accompany pending decisions and queue state. Multiple readers attach independently. Fresh/rebuilt clients bootstrap instead of trusting a saved cursor. Duplicate deltas are ignored; gaps request bootstrap. Projector failures cannot stop execution or receipt recording. Independent runs reattach concurrently without claiming another client's view.
- Shared decisions register before publication. Settlement, allow-always groups, mode reconciliation and cancellation broadcast correlation metadata. Identical lost-response retries use bounded in-process receipts; conflicting outcomes dismiss stale dialogs without claiming the new answer won.
- Headless startup reconciles only previously running headless lifecycle rows to aborted/unknown with an interrupted metadata marker. Child/tool cleanup remains separate.
- Metadata polling consumes committed message/conversation/project changes; active transcripts refresh through their existing coordinator, not just Query invalidation. Already-projected revisions avoid redundant active-tree refreshes. Browser inflight/cache/terminal-view storage is session-scoped. Account-change cache clearing and old-auth-epoch response fencing were added.
- Interactive LSP is keyed by document client/server/workspace, with scoped close/restart, old-socket fencing, startup cleanup and a 32-session bound. Tool-context LSP is unchanged.
- File editor saves require the read content hash and serialize by canonical path. A conflicting save preserves the draft. RightBar, plan editor, LSP disk edits and the retained mobile editor use the precondition. Existing-file saves only; arbitrary external writers remain outside the host lock.
- Browser terminal adapter uses independent host PTYs, bounded output polling, a 60-second reconnect lease and explicit close/shutdown. Native PTYs retain IPC/WebContents ownership; shell/WSL launch normalization is extracted/shared. Browser create receipts are bounded at 4,096 per host lifetime and **fail closed at capacity until host restart**, rather than re-executing an expired ID. Native bindings load lazily and missing bindings return a capability message. Actual PTY binding/device acceptance is not yet proven.
- Browser file links open the shared editor; browser-pane commands open normal tabs. Project/chat folder selection accepts and validates a path on the host, not a phone upload path. Basic phone workspace access and sidebar access are present, but phone layout/accessibility acceptance remains incomplete. Desktop Settings has an explicitly experimental shared-UI launch action; the old mobile launch remains.

### Remaining full-migration blockers

1. Complete host preferences/execution-defaults/saved-prompt ownership, trusted one-time desktop import, schema validation and conflict UX; generic localStorage helpers are not migrated yet.
2. Child-specific bootstrap, oversized active-output spill/on-demand references, exact snapshot/tree deletion handshake and full cloud attachment/resource/ID-adoption acceptance. Main bootstrap currently fails explicitly above its 16 MiB budget rather than silently discarding output.
3. Complete reservation/receipt semantics for all explicit branch/edit/manual-compaction/watch/successor races and post-restart decision outcomes. Some compatibility endpoints accept missing epoch as current for old clients; this is not the final fenced protocol. Queue policy acknowledgement UX and complete selected-file parity still need integration.
4. Complete typed iframe bridge parity, native capability audit, PTY extraction/reconnect UX and browser workspace behavior. The new browser PTY service does not yet replace native IPC ownership.
5. Full responsive phone UX (including focus trapping, safe areas, keyboard and panel sizing), configured origin/WS policy, foreign-host/protocol/cache reconciliation and effective network exposure status.
6. Packaged ASAR serving/build freshness, real phone/LAN/Tailscale and multi-client end-to-end acceptance; only then remove mobile sources/build hooks and retain `/mobile` as a redirect.

### Validation in this continuation

- Latest full renderer: **128 files / 1,080 tests passed**.
- Latest full server under matching Electron ABI: **29 files / 207 passed, 1 skipped**.
- Focused new shared-run suites: **6 files / 50 passed**, including two actual HTTP clients bootstrapping/queuing/answering one fixture run without duplicate execution.
- Full headless run: **797 passed, 18 failed, 24 todo** before updating one access-policy test to the new explicit mismatch contract. That updated test subsequently passed. The other 17 failures match the earlier checkpoint's stale fixtures/expectations; the full headless suite was not rerun after that correction. Do not describe it as green.
- Latest Electron renderer, browser renderer, Electron main and standalone server builds all passed; server/Electron/mobile typechecks passed.
- Latest no-preload browser smoke: **two isolated Chromium clients passed** (login/bootstrap fixture only, not full chat/workspace E2E).
- Latest isolated Electron selection smoke: **all 10 passed**, including StrictMode, history, retry fencing and the 20,000-node tree. One attempt with build-only Node heap flags crashed in Electron/V8; rerunning without those flags exposed an unnecessary transport import in the fixture, which was decoupled, then all checks passed.
- `git diff --check` still reports the pre-existing CRLF-style edited root package-script line; no unrelated whole-file conversion was made. No dependencies installed and no commits/pushes performed.

### Review reconciliation

The same **Claude Fable 5.1** session `679efd5b-7eb6-42f4-a1d5-974e67dc76ac` performed four additional read-only passes. Verified issues were fixed: opaque Electron GETs, projector failure isolation, run-scoped snapshot rows, stale epoch retries, queued sender view ownership, deleted-row resurrection, queue-specific outcomes and outcome callbacks independent from projection. The reviewer retracted its claim that `LineageRepo.resolve` mutates (it confused `resolve` with `reconcile`) and its stale active-tree-refresh finding. Its final focused pass (`1e1637dd-61f2-455b-bc4c-d8933a46feb3`) reported **no remaining blocker in the reviewed slice**, explicitly not approval of the full migration.

Security remains the chosen trusted-network prototype: reachable peers have powerful host access. Opaque-origin GET/HEAD compatibility permits public host metadata reads under the existing permissive CORS; it is not authentication. Null-origin auth mutations remain rejected. Do not deploy publicly or claim device access authentication.

## Additional continuation

Still incomplete: the six full-migration blocker groups above remain open. Additional fixes made:

- App login now reserves the host flow through asynchronous verification, rejects competing document/provider attempts, and scopes cancellation to the initiating native frame. Main-frame reload/crash clears abandoned reservations. A completed deep-link callback is deduplicated only for its exact state and current account generation.
- Cloud prompt creation checks the public managed identity instead of requiring a renderer access token, which is intentionally absent.
- Direct composer queue submissions capture selected files before attachment preparation and forward them through both admission and compatibility queue routes, with count/size bounds.

Validation: login ownership tests 4 passed; renderer enqueue tests 2 passed; queue route tests 3 passed. All four builds passed after queue changes; Electron main and standalone server builds passed again after login review fixes. Server/Electron typechecks passed before the final review fixes and main build typechecking subsequently passed. No real-device or full migration acceptance is claimed.

Same Claude session reviewed this narrow increment (job `79b24a52-931f-4c6a-8692-f3b4993b5b78`). Its duplicate callback and abandoned frame findings were addressed and tested; no post-fix reviewer approval is claimed. Element-level selected-file schema validation remains to audit. Read-only settings audit identified required trusted import, typed revisioned saves, bootstrap/Redux initialization and server consumer migration; that migration has not been implemented.

## Continuing implementation — host settings and child observers

Implemented and integrated after the additional continuation:

- Host-owned local prompt collection with schema validation, host/epoch/revision preconditions, awaited renderer saves, same-payload retry and stable prompt IDs across failed acknowledgements. Trusted native-only legacy import preserves existing host records/defaults; floating renderers read without importing. Corrupt/future host records disable writes while preserving original data; malformed legacy rows are normalized individually. Send-time local prompt lookup uses canonical host records rather than stale Query copies.
- Typed host execution preferences for approval default, context directories, auto-memory, plan verbosity and provider/compaction preferences. Browser startup only reads; trusted native startup imports present legacy keys once. Saves are acknowledged with revision checks. Startup initializes Redux approval explicitly; external approval updates apply unless this renderer explicitly overrode the default. Provider-selector visibility stays local. Admission snapshots omitted execution values into the request, and queue inheritance remains unchanged.
- Child-specific bootstrap for unfinished text/reasoning after replay eviction, independent observers, duplicate suppression, gap-triggered rebootstrap and browser transcript access. Oversized child/main tails still fail explicitly; spill/on-demand and exact persisted child handoff remain open.
- Phone workspace uses a native modal dialog with focus containment, safe-area padding and viewport-width editor/terminal overlays instead of offscreen desktop docking.
- Browser terminal commands are serialized per session; uncertain delivery blocks later buffered input instead of reordering/retrying commands.

Validation observed: full renderer **129 files / 1,082 passed**; full matching-ABI server **32 files / 218 passed, 1 skipped** (before final provider additions); prompt/execution store **7 passed**; child snapshot/registry **21 passed**; admission/child-service/HTTP integration **40 passed** after updating the minimal child registry test double. Latest four builds pass. Browser login/bootstrap smoke **2 passed**; native selection smoke **10 passed** after adding the required host URL export to its isolated API mock.

Same Fable session completed jobs `700f6331-20f4-41e6-8598-33b5977501bc` and `066d2b4d-ab0b-4024-b233-ae33a480405f`. Accepted findings fixed: corrupt settings startup, floating prompt IPC, legacy normalization, stale local prompt cache, host change warning, child capacity error incorrectly marking execution done. Reviewer incorrectly said execution preferences were not polled: they already share prompt polling. Approval override-aware Redux refresh was missing and was added. The route-state-loss claim was not reproduced: RightBarShell stays mounted when returning null, retaining mobileOpen.

Still implementing: remaining tool/subagent/operation-mode defaults; full dirty-form revision ownership; oversized spill; full child transcript boundary/abort ownership; durable decisions and explicit-operation races; iframe parity/native PTY extraction; network/cache/resource audit; packaging and real-device acceptance; mobile retirement. No full-migration completion or review approval is claimed.

Further settings integration: execution preferences now carry per-domain revisions; provider forms reject missing base revisions and compare values independently of object key order. Legacy provider import filters unknown/invalid fields without discarding valid fields. Provider environment application occurs at startup/commit, not every read. Per-tool patches merge on host. Subagent configuration is host-owned and snapshotted at parent admission, then threaded into child tool dispatch; mode prompts and tool-call/bash timeouts also use typed host storage and awaited saves. Stream-idle watchdog and provider-selector visibility remain client-local. Last renderer suite **130 files / 1,085 passed**, and all four builds passed after these integrations. New focused provider CAS tests **3 passed**, host execution store **5 passed**, subagent executor **33 passed**. Two build errors encountered during integration (mobile lib compatibility for Object.hasOwn; incorrect subagent prompt request field) were corrected and affected builds rerun successfully. Remaining full-scope gates above still apply.

## Paused at the user's request — settings integration section validated

The current **settings integration and review-fix section is closed at a tested boundary**. This is not full migration acceptance. No build, test, subagent or Claude review job remains running from this section.

### Latest fixes completed

- Provider saves compare fields independently of key order and reject missing edit-base revisions. Per-domain CAS prevents unrelated preference changes from conflicting with a provider edit.
- Legacy provider import retains valid known fields even when obsolete/invalid fields are present. Import preserves the existing per-domain revision map and increments only newly imported domains.
- A regression test uncovered that saving one setting persisted synthesized defaults for every other domain, preventing a later native import. Saves now persist only the explicitly changed domains; unimported native values are not overwritten by browser-created defaults.
- Configuring a different subagent provider no longer reuses the parent provider's model; provider-specific fallback models are used. Parent admission filters default child tools against disabled host tools/direct MCP names and fills omitted child reasoning effort.
- Chat-mode prompt selection now carries the form's edit base, matching other mode prompt edits.

### Final validation at pause

- Full renderer: **130 files / 1,085 tests passed**.
- Full server, matching Electron native ABI: **32 files / 222 passed, 1 skipped**.
- Focused host execution settings: **6 passed**; subagent executor: **34 passed**.
- Electron renderer, browser renderer, Electron main and standalone server builds: **all passed** on current sources.
- Production browser bootstrap/login fixture: **2 clients passed**.
- Isolated native React/selection fixture: **10 checks passed**.
- No full-headless green claim: the previously recorded broader suite failures were not rerun/resolved in this section. No packaged ASAR, real phone/LAN/Tailscale, or full browser workspace E2E acceptance performed.

### Review and remaining work

Latest same-session Fable review: `ef1eba52-5ac9-4e37-8071-c6b6ff6828f2` in `679efd5b-7eb6-42f4-a1d5-974e67dc76ac`. Verified findings above were fixed and tested. No follow-up approval of those last fixes, or approval of the full migration, is claimed.

Resume with settings edge-case/consumer audit (including cross-client open-form refresh, repair notices, tool-map removal semantics, legacy subagent unknown fields, auto-compaction preference and bash-timeout consumer), then oversized snapshot spill/on-demand, exact persisted-tree/child handoff, durable decision/explicit-operation contracts, iframe/native PTY parity, network/resource/cache audit, packaged/browser/device acceptance and mobile retirement. `sharedRuns:false` and the old mobile UI remain intentional until acceptance gates pass. See the root `.ygg/artifacts/shared-ui-implementation-progress.json` for the structured handoff. No dependencies installed or commits/pushes made.

## Resumed implementation — local integration and acceptance (2026-10-19)

The local implementation is substantially complete and now has broad green regression evidence. **Full plan acceptance is still blocked by physical-device/network/provider/release-platform gates; the old mobile UI and `sharedRuns:false` remain intentional.**

### Implemented in this pass

- Main/child current-turn spill with immutable prefix leases, bounded multipart retrieval, process-wide 512 MiB scratch budget, reserved reader capacity, periodic cleanup and host shutdown cleanup. Large individual frames use references too. Viewers detach during hydration and resume above S. Missing observer payloads force machine-readable rebootstrap rather than accepting a sequence with missing output.
- Child bootstrap includes an exact synchronous persisted transcript; query cancellation fences older responses. Child registry Stop reaches the actual loop signal. Main bootstrap exposes absent referenced-message IDs and client deletion tombstones override active-row protection.
- Kind-scoped durable decision receipts, preserving upgrade-then-approval on one tool ID. Migrations 10–11 handle fresh and prototype databases without deleting old outcomes. Compact command tombstones intentionally are not expired into executable new commands.
- Host-owned auto-compaction, remaining timeout plumbing (shell hard cap stays three minutes), visible repair notices, dirty-domain Settings refresh, valid legacy subagent-field import, acknowledged composer orchestrator toggle, host-injected custom-tool timeout reads.
- Native and browser PTYs now share TerminalService; native IPC retains sender ownership and push events, no browser lease. Navigation/crash/destruction cleanup, compact native-create receipt cleanup, browser command delivery errors and same-ID create retry are wired.
- Explicit typed browser app transport for file/stat/write/mkdir/exec/HTTP/own custom-tool invocation. Workspace/hash/mode/access and source ownership are preserved; writes require confirmation. Opaque browser frames cannot access parent state. Connection CSP and opaque-origin mutation fencing prevent direct legacy API bypass; native session header is main-injected and never exposed through public status. Public app HTTP uses pinned DNS/no redirects/private-address denial and no ambient credentials.
- GET-only custom/MCP/skill observers reconcile other clients without connecting MCP, refreshing handlers or invoking tools. Installed-skill section updates while open.
- Host bind/port/exposure status, configured proxy origins (`YGG_BROWSER_ALLOWED_ORIGINS`), WebSocket origin checks, foreign-host blocking/cache clearing, recognized legacy attachment URL rewriting, host titlebar folder picker and explicit queue access-policy acknowledgement.
- Full headless failures were traced to stale fixtures/contracts: added lineage test schema, awaited async prompt saves, correct mode-row ancestry, canonical tool-result blocks, retained mode-upgrade schemas, required emit callbacks and persistent provider retry failures. Assertions were not replaced with blanket skips.

### Observed validation

- Renderer: **134 files / 1,093 passed**.
- Matching-Electron-ABI server: **37 files / 229 passed, 1 skipped**.
- Matching-Electron-ABI headless: **83 passed files, 1 skipped file / 824 passed, 24 todo**.
- Tools: **38 files / 477 passed, 2 skipped**.
- All four builds and client parallel release scheduler passed. Production bundling uses a build-only 6 GiB heap setting; live UI smoke runs omit it.
- Production no-preload browser login: two isolated clients passed.
- Production shared React chat fixture: two live observers, independent phone draft, admission, permission settlement, queue/remove, one final reply and 390×844 Workspace dialog passed, with no unexpected fixture API requests.
- Opaque browser app fixture: nested modules load, parent DOM is blocked, direct host fetch is blocked, parent-mediated typed read succeeds, spoofed source is rejected.
- Native selection/StrictMode/history fixture: all ten checks passed. One earlier timeout was resolved by allowing the large-tree fixture a 90-second budget; one run with build-only heap flags crashed and was rerun without them.
- Native loadFile WebSocket Origin verified as `file://`.
- Unsigned macOS arm64 `--dir` packaging passed with installed bindings (`npmRebuild=false`, no publish). Actual ASAR index/seven entry assets, missing API/asset 404s and packaged native PTY output passed. This is not signed CI/native-rebuild or full real-user app startup acceptance.

### Review and remaining gates

Continued the same Fable 5.1 session `679efd5b-7eb6-42f4-a1d5-974e67dc76ac`. Reviews approved the locally tested snapshot/decision/admission/catalog/settings slices; verified iframe-isolation issues were subsequently fixed and tested. Latest final fence review is still being reconciled; no full-plan or physical-device approval is claimed.

Remaining evidence: real iOS/Android HTTP-LAN keyboard/safe-area/sleep/network-switch behavior; Tailscale/HTTPS/Host-rewriting proxy SSE/WSS; Windows/WSL; real-provider 1/3/10-viewer latency/heap/scratch; signed multi-platform CI. Only after these acceptance gates may the duplicate mobile source/build/package hooks be retired and `/mobile` redirected. Local synthetic tests are not a substitute for those gates. No dependencies installed, commits or pushes performed.

Final local Fable pass `88dcf338-04d7-4388-92ff-665125982bf1` reported **no remaining P1** and approved the locally tested code slice, explicitly not physical/full-plan acceptance. Its two nonblocking injector notes were addressed: header injection is limited to main/floating WebContents and URL parsing is guarded; Electron main build passed again. Final browser app/two-observer/phone workspace and ten native selection fixtures passed. Native origin probe observed WebSocket `file://`; the standalone file-origin POST probe did not reach its test server (reported undefined), so no POST-origin verification is claimed. The final build-only package validation predates only that small injector narrowing; no signed/rebuild/device claim is added.

## Installed startup regression — createRequire collision

The installed 0.3.21 build exposed a duplicate `createRequire` declaration in emitted Electron main (also reproduced in standalone server). The new terminal service imported it, while the esbuild banner declared it outside esbuild's symbol renaming. Previous build/asset/PTY checks did not parse the main entrypoint and missed this startup blocker.

Fixed via a shared binding-free dynamic-import require banner, mandatory emitted ESM syntax checks in both builds, and packaged ASAR entrypoint syntax checks. Validation: 8 build-script tests passed, including collision reproduction/rejection and valid require execution; Electron main/mobile and standalone server typechecks/builds passed; unsigned macOS arm64 directory packaging with existing bindings (`npmRebuild=false`) passed; actual ASAR Electron module syntax, 7 browser entry assets, missing API/asset 404s and native PTY checks passed. Full user-profile app startup, signing and native rebuild were not performed in this fix. Rebuild and reinstall the ZIP to replace the broken installed bundle; no user-data reset is required for this syntax error.

## Native bootstrap and remote launch correction

Reproduced `Host bootstrap unavailable` using actual Electron 38 `loadFile` fetches: `Origin` is absent while `Sec-Fetch-Site` is cross-site, so the host policy returned 403. Earlier unit fixtures only simulated `Origin: null`, and browser fixtures used a synthetic host without the policy. The native fence now permits these main-owned requests through origin matching while retaining JSON requirements and rejection of unfenced/forged cross-site calls. A new real Chromium fixture exercises the production policies plus renderer admission client; bootstrap, admission and preference PATCH pass. Admission errors now include HTTP status and distinguish old-host 404 from policy 403 without automatically resubmitting a command.

The live `/Applications/Graviton.app` inspected during diagnosis was 0.3.20, had neither `/api/host/runtime` nor browser UI assets, and served bootstrap/root 404s. This is separate stale-host evidence, not proof that the user reported only that copy. No installed app, running process or real profile was changed.

Settings now labels the section Remote UI Access, displays/copies/QR-encodes the shared root URL, retains an explicitly labelled legacy mobile launcher, catches preview-launch errors, and does not persist newly auto-detected IP/port as a stale override. Existing saved overrides are preserved; Clear uses fresh detection.

Local checks observed: admission renderer 5 tests, host policy/fence 3 tests, native loadFile bootstrap/admission/preferences fixture; both renderer targets, Electron main and standalone server builds; two-observer browser chat/phone workspace fixture; opaque app isolation fixture; unsigned directory packaging with installed native bindings; actual ASAR entrypoint syntax/browser assets/PTY smoke all passed. No real-provider, device or full real-profile launch acceptance is claimed. Same-session Fable review requested; result not yet reconciled.

To test after rebuilding/installing: fully quit all Graviton copies, launch the new app, open Settings → Remote UI Access, Clear any stale saved base URL and check Bound host/actual port. Open shared UI preview on the host, then copy Shared UI URL into a second device on the same trusted Wi-Fi/Tailscale network. Use `/`, not `/mobile`. Keep Electron running. If loopback-bound, restart with `YGG_LOCAL_SERVER_ALLOW_REMOTE=1 YGG_LOCAL_SERVER_HOST=0.0.0.0`; changing the base URL alone does not rebind the listener. This remains unauthenticated host access: do not expose publicly.

Fable review `bef7f3c7-5804-4e0f-9032-0a13315b41b3` identified missing coverage for a pre-existing default Electron session. Fixed with `electron/nativeHostSession.ts`: idempotent per-session installation directly on main/floating windows before load, retaining session-created as a backup. The real Chromium fixture now uses that production installer twice on an existing session and passes. Optional WebContents ID typecheck was corrected and main build rerun successfully. Follow-up Fable job `be36e763-aa1e-4896-af61-f7079ead0b49` closed P1 with no new blocker for this narrow fix. Final ASAR syntax/assets/PTY smoke passed after repackaging. Fresh `release/Graviton-0.3.21-mac-arm64.zip` generated with installed bindings/no publish, ad-hoc signing and no notarization. Existing third-party QR generation remains a nonblocking privacy limitation; no device/full-feature acceptance is claimed.

## Forced browser backgrounds and passive transcript correction

User-confirmed Chrome shared UI sends exposed two additional issues. Browser backgrounds inherited native transparent defaults/tinted gradients; nonnative delivery now forces an opaque theme-aware canvas on html/body/root, strips alpha from custom background colors, falls back for transparent/unresolved/unsupported values and ignores saved video wallpaper mode. Electron glass/video behavior is preserved. Current Chromium pixel tests cover 14 light/dark/default/custom/alpha/transparent/video combinations across all three document layers; older relative-color support is feature-gated and unit tested.

Reproduced observer/reload tool-history loss with the actual production browser UI: discovery slots had `updatePath:false`, so persisted turns entered Redux but stayed off the selected transcript path while each next generation cleared transient events. Added a separate passive `followSelectedTip` policy that follows only selected adjacent same-conversation/lineage rows without taking navigation ownership. Explicit parallel panes remain isolated. The fixture now reloads an observer, streams three persisted tool turns, verifies accumulated completion counts and all expanded call names, and verifies the final reply on both clients. Bootstrap fixture projection events were corrected to the real unsequenced event contract.

Validation: full renderer **136 files / 1,118 tests passed**; native and browser renderer builds and Electron main/mobile typecheck/build passed (one parallel build timeout rerun separately; initial effect cleanup type error corrected). Real Chromium background pixels, observer reload/tool history, two-client chat/queue/decisions/phone workspace, ten native selection lifecycle checks and browser app isolation passed. Claude Fable review `2e88f071-5fa5-4a7f-a05a-059d121d574a` reported no P1 for the background/passive-follow fixes after closing its older-browser color-syntax finding; cross-conversation ancestry and sibling-retention assertions were added. Full real-provider/device acceptance remains unclaimed.

Fresh macOS arm64 `release/Graviton-0.3.21-mac-arm64.zip` regenerated with both fixes, installed native bindings (`npmRebuild=false`), ad-hoc signing, no notarization/publish. Final actual ASAR entrypoint syntax, seven browser assets, non-SPA API/asset 404 and packaged native PTY smoke passed. Installed app/profile not replaced by the assistant.

## Post-compaction next-send parent correction

Reproduced stale ordinary-send parents after manual compaction: the host persists a restored-context row below the committed summary and advances the lineage head, while renderer context/control events previously only inserted rows into the message map. The selected path stayed at the summary; complete.message also returns that earlier summary. Refresh selected the real tail, explaining the workaround.

Context/control projection now extends the guarded continuation path without replacing the triggering user message. A shared renderer continuation-tail predicate preserves context/compaction-control/settings tails through summary replay and terminal completion. Parallel ownership and observer adjacency/lineage/ancestry protections remain. Context-injection events also trigger derived-view refresh callbacks.

Validation: new regression initially reproduced three failures, then all five initial cases passed; full renderer **137 files / 1,123 tests passed**. A sixth negative ordinary-user-tail case subsequently passed in the focused suite. Browser and native renderer builds passed; native selection fixture passed all ten checks. Production browser fixture compacts via the composer, publishes summary/restored context, then strictly validates the immediate next admission parent without refresh; it passed alongside prior two-client/background/history checks. Combined test/build/browser command hit the 180-second deadline after green tests/build; browser rerun separately passed. Packaging also hit that deadline during ZIP generation; archive was successfully regenerated from the already packaged app using --prepackaged, then ZIP integrity and actual ASAR syntax/assets/PTY smoke passed. Fresh same-version macOS arm64 ZIP at release/Graviton-0.3.21-mac-arm64.zip; ad-hoc signed, no notarization/publish, installed app/profile unchanged. Claude narrow review requested; result pending at this checkpoint. No server or schema changes for this fix.

Final renderer rerun including the negative ordinary-user-tail case: **137 files / 1,124 tests passed**. ZIP integrity (`unzip -tq`) passed on the regenerated archive.

Claude review ac526567-c767-43be-8f88-1de2780058f6 completed: no blocker in this narrow manual-compaction renderer fix. Reviewer verified guarded continuation, terminal no-rewind and strict browser admission fixture. Its ordinary-user-tail and parallel-isolation test suggestions are already covered by compactionBranchHead.test.ts. Remaining coverage: observer-side browser send and real-server auto-compaction resume. Nonblocking follow-up hypothesis: runSnapshotProjector does not anchor context_injection_persisted across a subsequent turn reset; stale tree/bootstrap healing was not reproduced or changed in this fix. Review is not full-migration/device/provider acceptance.

## Compact reconnect transcript recovery

User reported history loss returning after connection recovery. The previous UI fixture incorrectly replayed every event in its bootstrap; production RunSnapshotProjector retains only prior-anchor/current-turn events plus exact persisted rows. Primary bootstrap could replay the old user and rewind selection; passive observers could not bridge multiple offline persisted turns. Bootstrap now gates navigation during installation, then reconciles monotonically along fully validated descendants of the selected tip. Siblings, foreign lineage/conversation, missing/cyclic ancestry and explicit parallel panes remain excluded. Terminal recovery preserves restored-context/control tails and corresponding durable stream anchors. Watch-continuation keeps its existing separate structural ownership policy.

The browser fixture now bundles the real projector, disconnects both clients after one tool, publishes two offline turns, forces replay-eviction rebootstrap, then checks all three completed calls and final reply on sender/observer. It also retains strict post-compaction follow-up parent validation. Ended synthetic responses must be removed before publishing offline events; writing to them caused the initial fixture hangs. An instant compaction/composer settlement race required waiting for the final composer state before inserting the synthetic draft; no production composer changes made.

Validation: full renderer **137 files / 1,133 tests passed**, browser and native renderer builds passed, production two-client compact-resync/history/background/queue/decision/phone and post-compaction follow-up smoke passed, ten native selection lifecycle checks passed, focused whitespace audit passed. Initial combined build deadline was rerun successfully independently. Claude review caught a recovery-tail rewind in the initial patch; strictly monotone recovery and owner/observer terminal-compaction tests now cover it. Follow-up review pending. No real-provider/network-switch acceptance or new packaged ZIP is claimed yet.

Fresh same-version macOS arm64 ZIP generated with reconnect recovery. Initial package command timed out during compression; archive regenerated using the already packaged app (`--prepackaged`), ZIP integrity and actual ASAR entrypoint syntax/browser assets/native PTY smoke passed. Ad-hoc signed, not notarized; no installed app/profile replacement, dependency rebuild or publish.

## Agents-pill compact snapshot recovery

Investigated separately from Chat selected-path loss. Reproduced missing first/second offline assistant turns in the pill using the actual server projector, SSE reader and preview middleware with both foreground and background conversations. Exact persisted rows were inserted into Chat but never captured by the preview; only compact current-turn events were captured. A second regression reproduced stale transient tails after repeated bootstrap. This is a shared reconnect trigger but a different reducer/capture defect, not the Chat navigation bug.

Preview bootstrap now consumes all exact run rows parent-first, excludes a prior-run starting anchor unless emitted as a run message, drops obsolete/deleted rows, and installs the authoritative current tail once. Replay capture is gated so old entries cannot be overwritten; late enrichment/results and future generation boundaries resume normally. Original run start time is preserved for fork ordering; terminal cleanup releases a failed installation gate. Six new tests cover foreground/background recovery, repeated snapshots, exact tool blocks/deletion/enrichment, late results/new turn and failed-install cleanup.

Validation: full renderer **139 files / 1,141 tests passed**; native/browser builds passed; real two-browser responsive 320/390/767/820 layout, compact reconnect/history, compaction next-send and workspace fixture passed; native selection fixture ten checks passed before the final cleanup-only refinement. Claude Fable job `06f8e249-a12d-4c33-8c4d-8d1016e564cc` reported no commit blockers; its P2 failed-install freeze was fixed/tested, while stale historical ordering and start-time concerns were already removed/preserved in the patch. Existing responsive UI changes are included at the user's explicit all-changes commit request. No push or fresh packaged ZIP in this increment.
