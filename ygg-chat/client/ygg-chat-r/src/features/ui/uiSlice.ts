// uiSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import {
  buildChatErrorEnvelope,
  normalizeChatErrorEnvelope,
  type ChatErrorCode,
  type ChatErrorEnvelope,
} from '../../../../../shared/chatErrors'
import { ConversationId, MessageId, ProjectId } from '../../../../../shared/types'

/**
 * A NAVIGABLE notification: "your background branch finished, click to open it".
 *
 * Deliberately left as a single-member union with REQUIRED `conversationId` /
 * `messageId`. `RunningAgentsFloatingButton` renders these as a click-to-navigate
 * inline banner and builds `/chat/{projectId}/{conversationId}#{messageId}` from
 * them — widening this type to carry failures would push non-navigable errors
 * into a navigate-on-click surface and produce `/chat/unknown/undefined#undefined`.
 * Failures get their own channel below (`UiErrorNotice`).
 */
export type UiNotification = {
  id: string
  kind: 'branch_stream_completed'
  title: string
  description?: string
  conversationId: ConversationId
  projectId: ProjectId | null
  messageId: MessageId
  createdAt: string
}

/**
 * What the user was doing when it failed. Used for de-duplication and for
 * telemetry/debugging — NEVER rendered. `envelope.userMessage` is the only
 * string a user reads.
 */
export type UiErrorNoticeSource =
  | 'message_update'
  | 'message_delete'
  | 'conversation_clone'
  | 'conversation_title'
  | 'conversation_research_note'
  | 'conversation_cwd'
  | 'local_server'
  | 'unknown'

/**
 * An OUT-OF-THREAD failure: a mutation that has no chat bubble to live on.
 *
 * These are the failures that were previously `console.error`-only — update or
 * delete a message, clone a conversation, rename, set a research note, set cwd.
 * The chat error bubble belongs to the chat stream; these need a global surface,
 * and `GlobalNotifications` is it.
 */
export interface UiErrorNotice {
  id: string
  source: UiErrorNoticeSource
  /** The ONLY user-visible content. Raw `Error.message` text belongs in `envelope.detail`. */
  envelope: ChatErrorEnvelope
  /** Context for the caller, when it has it. Never required — most of these have neither. */
  conversationId?: ConversationId | null
  messageId?: MessageId | null
  createdAt: string
}

/** What a caller hands to `errorNoticeRaised`. Everything except `source` is optional. */
export interface UiErrorNoticeInput {
  source: UiErrorNoticeSource
  /** A ready envelope (from a classifier). Normalized defensively. */
  envelope?: unknown
  /** Used only when `envelope` is absent — builds one from the shared defaults table. */
  code?: ChatErrorCode
  /** Raw technical text. Goes behind the "Details" disclosure, never inline. */
  detail?: string
  conversationId?: ConversationId | null
  messageId?: MessageId | null
  /** Override the default `${source}:${code}` de-duplication key. */
  id?: string
}

export interface UiState {
  rightBarCollapsed: boolean
  rightBarWidth: number
  notifications: UiNotification[]
  errorNotices: UiErrorNotice[]
}

const MAX_NOTIFICATIONS = 6
/** Fewer than notifications: an error stack taller than this is noise, not signal. */
const MAX_ERROR_NOTICES = 4
const RIGHT_BAR_COLLAPSED_STORAGE_KEY = 'rightbar:collapsed'
const RIGHT_BAR_WIDTH_STORAGE_KEY = 'rightbar:width'
const RIGHT_BAR_DEFAULT_WIDTH_PX = 360
const RIGHT_BAR_MIN_WIDTH_PX = 280
const RIGHT_BAR_MAX_WIDTH_PX = 720

const clampRightBarWidth = (value: number): number => {
  if (!Number.isFinite(value)) return RIGHT_BAR_DEFAULT_WIDTH_PX
  return Math.min(RIGHT_BAR_MAX_WIDTH_PX, Math.max(RIGHT_BAR_MIN_WIDTH_PX, Math.round(value)))
}

const persistRightBarCollapsed = (collapsed: boolean) => {
  try {
    localStorage.setItem(RIGHT_BAR_COLLAPSED_STORAGE_KEY, String(collapsed))
  } catch {}
}

const persistRightBarWidth = (width: number) => {
  try {
    localStorage.setItem(RIGHT_BAR_WIDTH_STORAGE_KEY, String(clampRightBarWidth(width)))
  } catch {}
}

// Load initial state from localStorage
const getInitialCollapsed = (): boolean => {
  try {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(RIGHT_BAR_COLLAPSED_STORAGE_KEY)
    if (stored !== null) {
      return stored === 'true'
    }
    return true // Default collapsed
  } catch {
    return true
  }
}

const getInitialRightBarWidth = (): number => {
  try {
    if (typeof window === 'undefined') return RIGHT_BAR_DEFAULT_WIDTH_PX
    const stored = localStorage.getItem(RIGHT_BAR_WIDTH_STORAGE_KEY)
    const parsed = stored ? Number.parseFloat(stored) : Number.NaN
    return clampRightBarWidth(parsed)
  } catch {
    return RIGHT_BAR_DEFAULT_WIDTH_PX
  }
}

const initialState: UiState = {
  rightBarCollapsed: getInitialCollapsed(),
  rightBarWidth: getInitialRightBarWidth(),
  notifications: [],
  errorNotices: [],
}

export const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    rightBarCollapsedSet: (state, action: PayloadAction<boolean>) => {
      state.rightBarCollapsed = action.payload
      persistRightBarCollapsed(action.payload)
    },
    rightBarWidthSet: (state, action: PayloadAction<number>) => {
      const nextWidth = clampRightBarWidth(action.payload)
      state.rightBarWidth = nextWidth
      persistRightBarWidth(nextWidth)
    },
    rightBarToggled: state => {
      state.rightBarCollapsed = !state.rightBarCollapsed
      persistRightBarCollapsed(state.rightBarCollapsed)
    },
    rightBarExpanded: state => {
      state.rightBarCollapsed = false
      persistRightBarCollapsed(false)
    },
    notificationAdded: (state, action: PayloadAction<UiNotification>) => {
      const notification = action.payload
      const existingIndex = state.notifications.findIndex(item => item.id === notification.id)
      if (existingIndex >= 0) {
        state.notifications[existingIndex] = notification
      } else {
        state.notifications.unshift(notification)
      }

      if (state.notifications.length > MAX_NOTIFICATIONS) {
        state.notifications = state.notifications.slice(0, MAX_NOTIFICATIONS)
      }
    },
    notificationDismissed: (state, action: PayloadAction<string>) => {
      state.notifications = state.notifications.filter(item => item.id !== action.payload)
    },
    notificationsCleared: state => {
      state.notifications = []
    },

    /**
     * Raise an out-of-thread failure. The `prepare` step is what keeps IRON RULE 1
     * enforceable at the boundary: callers pass a code (or a classifier's envelope)
     * plus raw text, and the shared defaults table supplies the prose. A caller
     * physically cannot get a raw `Error.message` onto the screen through here.
     */
    errorNoticeRaised: {
      reducer: (state, action: PayloadAction<UiErrorNotice>) => {
        const notice = action.payload
        const existingIndex = state.errorNotices.findIndex(item => item.id === notice.id)
        if (existingIndex >= 0) {
          // Same operation failing again refreshes the notice rather than stacking duplicates.
          state.errorNotices[existingIndex] = notice
          return
        }

        state.errorNotices.unshift(notice)
        if (state.errorNotices.length > MAX_ERROR_NOTICES) {
          state.errorNotices = state.errorNotices.slice(0, MAX_ERROR_NOTICES)
        }
      },
      prepare: (input: UiErrorNoticeInput) => {
        const envelope =
          input.envelope != null
            ? normalizeChatErrorEnvelope(input.envelope, input.detail)
            : buildChatErrorEnvelope(input.code ?? 'internal_error', { detail: input.detail })

        return {
          payload: {
            id: input.id ?? `${input.source}:${envelope.code}`,
            source: input.source,
            envelope,
            conversationId: input.conversationId ?? null,
            messageId: input.messageId ?? null,
            createdAt: new Date().toISOString(),
          } satisfies UiErrorNotice,
        }
      },
    },
    errorNoticeDismissed: (state, action: PayloadAction<string>) => {
      state.errorNotices = state.errorNotices.filter(item => item.id !== action.payload)
    },
    errorNoticesCleared: state => {
      state.errorNotices = []
    },
  },
})

export const uiActions = uiSlice.actions

export default uiSlice.reducer
