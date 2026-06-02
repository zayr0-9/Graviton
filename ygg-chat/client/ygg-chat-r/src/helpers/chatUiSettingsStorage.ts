export const CHAT_UI_TOKEN_USAGE_VISIBILITY_KEY = 'chat:showTokenUsageBar'
export const CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT = 'chatUi:tokenUsageVisibilityChange'
export const CHAT_UI_AUTO_COMPACTION_ENABLED_KEY = 'chat:autoCompactionEnabled'
export const CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT = 'chatUi:autoCompactionEnabledChange'
export const HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_KEY = 'heimdall:notePreviewHoverPaddingEnabled'
export const HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_CHANGE_EVENT =
  'heimdall:notePreviewHoverPaddingEnabledChange'

export const loadShowTokenUsageBar = (): boolean => {
  try {
    const stored = localStorage.getItem(CHAT_UI_TOKEN_USAGE_VISIBILITY_KEY)
    return stored !== null ? stored === 'true' : true
  } catch {
    return true
  }
}

export const saveShowTokenUsageBar = (show: boolean): void => {
  try {
    localStorage.setItem(CHAT_UI_TOKEN_USAGE_VISIBILITY_KEY, String(show))
    window.dispatchEvent(new CustomEvent<boolean>(CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT, { detail: show }))
  } catch {
    // no-op
  }
}

export const loadAutoCompactionEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(CHAT_UI_AUTO_COMPACTION_ENABLED_KEY)
    return stored !== null ? stored === 'true' : true
  } catch {
    return true
  }
}

export const saveAutoCompactionEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(CHAT_UI_AUTO_COMPACTION_ENABLED_KEY, String(enabled))
    window.dispatchEvent(new CustomEvent<boolean>(CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT, { detail: enabled }))
  } catch {
    // no-op
  }
}

export const loadHeimdallNotePreviewHoverPaddingEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_KEY)
    return stored !== null ? stored === 'true' : true
  } catch {
    return true
  }
}

export const saveHeimdallNotePreviewHoverPaddingEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_KEY, String(enabled))
    window.dispatchEvent(
      new CustomEvent<boolean>(HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_CHANGE_EVENT, { detail: enabled })
    )
  } catch {
    // no-op
  }
}
