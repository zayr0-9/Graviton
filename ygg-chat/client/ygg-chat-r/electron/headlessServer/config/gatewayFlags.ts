/**
 * Gateway feature flags (Phase 4+). Conf-backed, env-overridable.
 *
 * As of the Phase 6 cutover `chat` defaults ON (the renderer routes all chat
 * through the server-owned loop); the rest default OFF. These gate the
 * server-owned cloud path:
 *  - `chat`       — route the cloud (openrouter) chat through the server engine:
 *                   relay free-tier SSE events and adopt Railway message ids via
 *                   the CloudMirrorSink. Consumed by ChatOrchestrator. DEFAULT ON;
 *                   an explicit `gateway.chat === false` Conf key forces it off.
 *  - `tokenOwner` — make the server the sole Supabase-token refresher. NOT yet
 *                   consumed (lands with the token-owner slice); resolved here so
 *                   the whole flag surface lives in one place.
 *  - `crud`       — mount the storage-aware /api/gw/* CRUD gateway (conversations/
 *                   projects/messages: local+cloud merge + dual-write). Phase 5.
 *  - `cloudProxy` — mount the /api/cloud/* authenticated pass-through to Railway
 *                   (models/users/system-prompts/stripe/app-store/drive). Phase 5.
 *  - `resumableRuns` — decouple a chat run's lifetime from its SSE connection: a
 *                   bare client disconnect DETACHES (the run keeps going in the main
 *                   process) instead of aborting; the client resubscribes by streamId
 *                   and replays. Only an explicit POST /api/streams/:id/abort cancels.
 *                   DEFAULT OFF (off => today's disconnect==abort behavior). App-quit
 *                   still kills every run (the in-memory sessions die with the process).
 *
 * `YGG_GATEWAY_MODE` truthy is a master override that turns every gateway flag on
 * (mirrors the env-truthy precedent in openaiChatgptProvider.ts:982). Otherwise
 * each flag reads its own Conf key (same store as electronAppAuth.ts:79-84). Conf
 * access is wrapped so a bad/missing store can never throw at server startup on
 * the default-off path.
 */

import Conf from 'conf'

export interface GatewayFlags {
  chat: boolean
  tokenOwner: boolean
  crud: boolean
  cloudProxy: boolean
  resumableRuns: boolean
}

function isEnvTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim())
}

export function resolveGatewayFlags(): GatewayFlags {
  // Master env override wins and short-circuits any Conf read.
  if (isEnvTruthy(process.env.YGG_GATEWAY_MODE)) {
    return { chat: true, tokenOwner: true, crud: true, cloudProxy: true, resumableRuns: true }
  }

  // Phase 6 cutover: `chat` now defaults ON. The renderer routes all 5 chat
  // providers through the server-owned loop unconditionally, and the openrouter
  // (cloud) route requires gateway.chat for its CloudMirrorSink (Railway id
  // adoption) + free-tier SSE relay. An explicit `gateway.chat === false` Conf key
  // still forces it off as an escape hatch. `crud`/`cloudProxy` are vestigial —
  // the Phase 5 gateway routes mount unconditionally (index.ts, `enabled: true`) —
  // and `tokenOwner` stays default-off (the separate sole-refresher slice, coupled
  // to the renderer flag and validated independently).
  let chat = true
  let tokenOwner = false
  let crud = false
  let cloudProxy = false
  let resumableRuns = false
  try {
    const store = new Conf({ projectName: 'ygg-chat-r', configFileMode: 0o600 })
    chat = store.get('gateway.chat') !== false
    tokenOwner = store.get('gateway.tokenOwner') === true
    crud = store.get('gateway.crud') === true
    cloudProxy = store.get('gateway.cloudProxy') === true
    resumableRuns = store.get('gateway.resumableRuns') === true
  } catch {
    // A missing/corrupt Conf store must never break server startup; keep chat on.
  }
  return { chat, tokenOwner, crud, cloudProxy, resumableRuns }
}
