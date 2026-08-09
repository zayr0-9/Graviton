/**
 * The shared chat-error vocabulary.
 *
 * ONE declaration for both sides, like `headlessApi.ts` next to it: the server
 * (electron/tsconfig.json) classifies, the renderer (tsconfig.app.json) renders.
 * Neither side may invent its own codes or its own prose.
 *
 * The rule that makes this worth having: `ChatErrorEnvelope.userMessage` is the
 * ONLY string that is ever rendered to a user. A raw `Error.message` must never
 * reach the screen — it leaks internal loop vocabulary ("Provider turn 7/400"),
 * lineage ids, and stack text. Raw text goes in `detail`, behind a disclosure.
 */

/**
 * Every terminal failure the chat loop can reach. Grouped by cause, because the
 * grouping is what decides the recovery affordance.
 */
export type ChatErrorCode =
  // ── Network / transport (renderer <-> local server on :3002) ──
  | 'local_server_unreachable'
  | 'server_rejected_request'
  | 'connection_lost'
  | 'stream_interrupted'
  | 'run_expired'
  | 'history_truncated'
  | 'stream_stalled'
  | 'offline'
  // ── Auth and identity ──
  | 'session_expired'
  | 'provider_signin_required'
  | 'credentials_missing'
  // ── Usage, quota, billing ──
  | 'free_tier_exhausted'
  | 'provider_quota_exceeded'
  | 'rate_limited'
  | 'subscription_inactive'
  // ── Provider ──
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_empty_response'
  | 'content_filtered'
  | 'context_length_exceeded'
  | 'model_not_found'
  | 'bad_request'
  // ── Tools and hooks ──
  | 'tool_failed'
  | 'tool_timeout'
  | 'tool_denied'
  | 'tool_blocked_by_policy'
  | 'mcp_unavailable'
  | 'hook_failed'
  // ── Loop and lifecycle ──
  | 'max_turns_reached'
  | 'compaction_failed'
  | 'decision_not_delivered'
  | 'stop_not_confirmed'
  | 'cancelled'
  | 'unsupported_runtime'
  | 'internal_error'

/**
 * Non-terminal, purely informational frames. These never end a run and are never
 * persisted as message content — they exist so a multi-second silence has a
 * visible cause ("Reconnecting…", "Retrying 2 of 3").
 */
export type ChatNoticeCode = 'retrying' | 'reconnecting' | 'compacting' | 'quota_warning' | ChatErrorCode

/**
 * What the user can do about it. Drives the ONE button on the error bubble.
 * `retry` is the only action the renderer can satisfy without leaving the chat.
 */
export type ChatErrorActionKind =
  | 'retry'
  | 'sign_in'
  | 'reconnect_provider'
  | 'upgrade'
  | 'switch_mode'
  | 'open_settings'
  | 'reload_conversation'
  | 'compact'

export interface ChatErrorAction {
  kind: ChatErrorActionKind
  label: string
}

/**
 * `retryable`   - the same send may well work; offer Retry.
 * `user_action` - nothing changes until the user does something; offer that thing.
 * `fatal`       - not actionable in-app; explain and stop.
 */
export type ChatErrorRecoverability = 'retryable' | 'user_action' | 'fatal'

export interface ChatErrorEnvelope {
  code: ChatErrorCode
  /** Plain language, addressed to the user, safe to render verbatim. NEVER a raw Error.message. */
  userMessage: string
  recoverability: ChatErrorRecoverability
  /** At most one call to action. The renderer maps `kind` to a button handler. */
  action?: ChatErrorAction
  /** Wall-clock ms to wait before a retry can succeed (rate limits / quota resets). */
  retryAfterMs?: number
  /** Absolute epoch ms at which a quota resets. Preferred over `retryAfterMs` when known. */
  resetAt?: number
  /** Raw technical text. Shown only behind a "Details" disclosure, never inline. */
  detail?: string
  /** Provider slug, when the failure is attributable to one. */
  provider?: string
  /** HTTP status, when there was one. */
  status?: number
}

interface ChatErrorDefault {
  userMessage: string
  recoverability: ChatErrorRecoverability
  action?: ChatErrorAction
}

/**
 * The default prose for every code. A classifier may override `userMessage` when
 * it has something more specific (a provider's own explanation, a reset time),
 * but it must never leave a code without prose.
 */
export const CHAT_ERROR_DEFAULTS: Record<ChatErrorCode, ChatErrorDefault> = {
  // ── Network / transport ──
  local_server_unreachable: {
    userMessage:
      "I couldn't reach the chat service running on your machine. It may still be starting up, or it may have stopped.",
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  server_rejected_request: {
    userMessage: 'The chat service rejected this request, so nothing was sent.',
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  connection_lost: {
    userMessage: "The connection dropped while I was replying. I couldn't reconnect.",
    recoverability: 'retryable',
    action: { kind: 'reload_conversation', label: 'Reload conversation' },
  },
  stream_interrupted: {
    userMessage: 'This reply was cut off before it finished. It may have completed in the background.',
    recoverability: 'retryable',
    action: { kind: 'reload_conversation', label: 'Reload conversation' },
  },
  run_expired: {
    userMessage:
      'This reply is no longer streaming — it either finished while you were away, or the run expired.',
    recoverability: 'user_action',
    action: { kind: 'reload_conversation', label: 'Reload conversation' },
  },
  history_truncated: {
    userMessage: 'I lost part of this reply while reconnecting. The saved copy is complete.',
    recoverability: 'user_action',
    action: { kind: 'reload_conversation', label: 'Reload conversation' },
  },
  stream_stalled: {
    userMessage: "This reply has gone quiet and isn't producing anything. Something upstream is stuck.",
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  offline: {
    userMessage: "Your device is offline, so I can't reach the model.",
    recoverability: 'user_action',
    action: { kind: 'retry', label: 'Try again' },
  },
  // ── Auth and identity ──
  session_expired: {
    userMessage: 'Your session expired, so I stopped here. Sign in again to keep going.',
    recoverability: 'user_action',
    action: { kind: 'sign_in', label: 'Sign in' },
  },
  provider_signin_required: {
    userMessage: "This provider needs you to sign in again before I can use it.",
    recoverability: 'user_action',
    action: { kind: 'reconnect_provider', label: 'Reconnect' },
  },
  credentials_missing: {
    userMessage: "This provider has no API key set, so I couldn't start.",
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Open settings' },
  },
  // ── Usage, quota, billing ──
  free_tier_exhausted: {
    userMessage: "You've used all of your free generations.",
    recoverability: 'user_action',
    action: { kind: 'upgrade', label: 'See plans' },
  },
  provider_quota_exceeded: {
    userMessage: "This provider reports that you're out of credit or quota.",
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Open settings' },
  },
  rate_limited: {
    userMessage: "The provider is rate limiting this account, so I couldn't finish.",
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  subscription_inactive: {
    userMessage: 'Your subscription is not active, so this model is unavailable.',
    recoverability: 'user_action',
    action: { kind: 'upgrade', label: 'See plans' },
  },
  // ── Provider ──
  provider_unavailable: {
    userMessage: "I couldn't reach the model provider.",
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  provider_timeout: {
    userMessage: 'The model took too long to respond, so I stopped waiting.',
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  provider_empty_response: {
    userMessage: 'The model returned an empty reply.',
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  content_filtered: {
    userMessage: 'The provider stopped this reply with a content filter.',
    recoverability: 'user_action',
  },
  context_length_exceeded: {
    userMessage: "This conversation is too long for the model's context window.",
    recoverability: 'user_action',
    action: { kind: 'compact', label: 'Compact conversation' },
  },
  model_not_found: {
    userMessage: 'That model is not available on this provider.',
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Choose a model' },
  },
  bad_request: {
    userMessage: 'The provider rejected this request as malformed.',
    recoverability: 'user_action',
  },
  // ── Tools and hooks ──
  tool_failed: {
    userMessage: 'A tool failed, so I stopped here.',
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  tool_timeout: {
    userMessage: 'A tool ran too long and was cancelled.',
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
  tool_denied: {
    userMessage: 'You declined that tool, so I stopped here.',
    recoverability: 'user_action',
  },
  tool_blocked_by_policy: {
    userMessage: 'That tool needs Agent mode, and this conversation is in Plan mode.',
    recoverability: 'user_action',
    action: { kind: 'switch_mode', label: 'Switch to Agent mode' },
  },
  mcp_unavailable: {
    userMessage: "An MCP server didn't respond, so its tools are unavailable.",
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Check MCP servers' },
  },
  hook_failed: {
    userMessage: 'One of your hooks failed to run.',
    recoverability: 'user_action',
    action: { kind: 'open_settings', label: 'Check hooks' },
  },
  // ── Loop and lifecycle ──
  max_turns_reached: {
    userMessage: 'I hit the turn limit for one reply and stopped before finishing.',
    recoverability: 'user_action',
    action: { kind: 'retry', label: 'Continue' },
  },
  compaction_failed: {
    userMessage: 'This conversation needed compacting to continue, and compacting failed.',
    recoverability: 'user_action',
    action: { kind: 'compact', label: 'Compact conversation' },
  },
  decision_not_delivered: {
    userMessage: "Your answer didn't reach the chat service, so this reply is stuck waiting for it.",
    recoverability: 'user_action',
    action: { kind: 'retry', label: 'Try again' },
  },
  stop_not_confirmed: {
    userMessage: "I couldn't confirm the stop. This reply may still be running in the background.",
    recoverability: 'user_action',
    action: { kind: 'reload_conversation', label: 'Reload conversation' },
  },
  cancelled: {
    userMessage: 'This reply was cancelled.',
    recoverability: 'user_action',
    action: { kind: 'retry', label: 'Try again' },
  },
  unsupported_runtime: {
    userMessage: 'Chat needs the desktop app. This build cannot run the agent loop.',
    recoverability: 'fatal',
  },
  internal_error: {
    userMessage: 'Something went wrong on my side and I stopped here.',
    recoverability: 'retryable',
    action: { kind: 'retry', label: 'Try again' },
  },
}

/**
 * Build a complete envelope from a code plus whatever the classifier learned.
 *
 * `overrides.userMessage` wins when it is a non-empty string, so a provider's own
 * explanation ("You have used all 50 free generations; resets Feb 1") beats the
 * generic default. Everything else falls back to the table, which guarantees no
 * code can ever reach the UI without prose.
 */
export function buildChatErrorEnvelope(
  code: ChatErrorCode,
  overrides: Partial<Omit<ChatErrorEnvelope, 'code'>> = {}
): ChatErrorEnvelope {
  const base = CHAT_ERROR_DEFAULTS[code] ?? CHAT_ERROR_DEFAULTS.internal_error
  const userMessage =
    typeof overrides.userMessage === 'string' && overrides.userMessage.trim() ? overrides.userMessage : base.userMessage
  const envelope: ChatErrorEnvelope = {
    code,
    userMessage,
    recoverability: overrides.recoverability ?? base.recoverability,
  }
  const action = overrides.action ?? base.action
  if (action) envelope.action = action
  if (typeof overrides.retryAfterMs === 'number') envelope.retryAfterMs = overrides.retryAfterMs
  if (typeof overrides.resetAt === 'number') envelope.resetAt = overrides.resetAt
  if (typeof overrides.detail === 'string' && overrides.detail.trim()) envelope.detail = overrides.detail
  if (typeof overrides.provider === 'string' && overrides.provider) envelope.provider = overrides.provider
  if (typeof overrides.status === 'number') envelope.status = overrides.status
  return envelope
}

/**
 * Coerce anything that crossed a wire into a usable envelope.
 *
 * Used on BOTH read paths: an older server may send `{type:'error'}` with no
 * envelope at all, and a persisted `ErrorBlock` may predate a later code. Falling
 * back to `internal_error` keeps the bubble renderable instead of blank.
 */
export function normalizeChatErrorEnvelope(value: unknown, fallbackDetail?: string): ChatErrorEnvelope {
  const raw = value && typeof value === 'object' ? (value as Partial<ChatErrorEnvelope>) : null
  const code =
    raw && typeof raw.code === 'string' && raw.code in CHAT_ERROR_DEFAULTS ? (raw.code as ChatErrorCode) : 'internal_error'
  return buildChatErrorEnvelope(code, {
    userMessage: raw?.userMessage,
    recoverability: raw?.recoverability,
    action: raw?.action,
    retryAfterMs: raw?.retryAfterMs,
    resetAt: raw?.resetAt,
    detail: raw?.detail ?? fallbackDetail,
    provider: raw?.provider,
    status: raw?.status,
  })
}

/** True when a Retry button would be honest. Keeps that judgement in one place. */
export function isChatErrorRetryable(envelope: ChatErrorEnvelope | null | undefined): boolean {
  return envelope?.recoverability === 'retryable'
}
