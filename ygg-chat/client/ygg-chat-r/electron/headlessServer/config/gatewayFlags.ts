/**
 * Gateway feature flags (Phase 4+). Conf-backed, env-overridable, default OFF.
 *
 * With every flag off the server behaves byte-for-byte as before, so these gate
 * only the opt-in server-owned cloud path:
 *  - `chat`       — route the cloud (openrouter) chat through the server engine:
 *                   relay free-tier SSE events and adopt Railway message ids via
 *                   the CloudMirrorSink. Consumed by ChatOrchestrator.
 *  - `tokenOwner` — make the server the sole Supabase-token refresher. NOT yet
 *                   consumed (lands with the token-owner slice); resolved here so
 *                   the whole flag surface lives in one place.
 *  - `crud`       — mount the storage-aware /api/gw/* CRUD gateway (conversations/
 *                   projects/messages: local+cloud merge + dual-write). Phase 5.
 *  - `cloudProxy` — mount the /api/cloud/* authenticated pass-through to Railway
 *                   (models/users/system-prompts/stripe/app-store/drive). Phase 5.
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
}

function isEnvTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim())
}

export function resolveGatewayFlags(): GatewayFlags {
  // Master env override wins and short-circuits any Conf read.
  if (isEnvTruthy(process.env.YGG_GATEWAY_MODE)) {
    return { chat: true, tokenOwner: true, crud: true, cloudProxy: true }
  }

  let chat = false
  let tokenOwner = false
  let crud = false
  let cloudProxy = false
  try {
    const store = new Conf({ projectName: 'ygg-chat-r', configFileMode: 0o600 })
    chat = store.get('gateway.chat') === true
    tokenOwner = store.get('gateway.tokenOwner') === true
    crud = store.get('gateway.crud') === true
    cloudProxy = store.get('gateway.cloudProxy') === true
  } catch {
    // A missing/corrupt Conf store must never break server startup; stay default-off.
  }
  return { chat, tokenOwner, crud, cloudProxy }
}
