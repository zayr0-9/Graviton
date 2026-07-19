export const CHAT_UI_TOKEN_USAGE_VISIBILITY_KEY = 'chat:showTokenUsageBar'
export const CHAT_UI_TOKEN_USAGE_VISIBILITY_CHANGE_EVENT = 'chatUi:tokenUsageVisibilityChange'
export const CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_KEY = 'chat:showTokenUsageHoverDetails'
export const CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_CHANGE_EVENT =
  'chatUi:tokenUsageHoverDetailsVisibilityChange'
export const CHAT_UI_AUTO_COMPACTION_ENABLED_KEY = 'chat:autoCompactionEnabled'
export const CHAT_UI_AUTO_COMPACTION_ENABLED_CHANGE_EVENT = 'chatUi:autoCompactionEnabledChange'
export const CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_KEY = 'chat:showAddedFilesPills'
export const CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_CHANGE_EVENT = 'chatUi:addedFilesPillsVisibilityChange'
export const HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_KEY = 'heimdall:notePreviewHoverPaddingEnabled'
export const HEIMDALL_NOTE_PREVIEW_HOVER_PADDING_ENABLED_CHANGE_EVENT =
  'heimdall:notePreviewHoverPaddingEnabledChange'
export const HEIMDALL_MESSAGE_PREVIEW_HOVER_PADDING_ENABLED_KEY = 'heimdall:messagePreviewHoverPaddingEnabled'
export const HEIMDALL_MESSAGE_PREVIEW_HOVER_PADDING_ENABLED_CHANGE_EVENT =
  'heimdall:messagePreviewHoverPaddingEnabledChange'

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

export const loadShowTokenUsageHoverDetails = (): boolean => {
  try {
    const stored = localStorage.getItem(CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_KEY)
    return stored !== null ? stored === 'true' : true
  } catch {
    return true
  }
}

export const saveShowTokenUsageHoverDetails = (show: boolean): void => {
  try {
    localStorage.setItem(CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_KEY, String(show))
    window.dispatchEvent(
      new CustomEvent<boolean>(CHAT_UI_TOKEN_USAGE_HOVER_DETAILS_VISIBILITY_CHANGE_EVENT, { detail: show })
    )
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

export const loadShowAddedFilesPills = (): boolean => {
  try {
    const stored = localStorage.getItem(CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_KEY)
    return stored !== null ? stored === 'true' : true
  } catch {
    return true
  }
}

export const saveShowAddedFilesPills = (show: boolean): void => {
  try {
    localStorage.setItem(CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_KEY, String(show))
    window.dispatchEvent(new CustomEvent<boolean>(CHAT_UI_ADDED_FILES_PILLS_VISIBILITY_CHANGE_EVENT, { detail: show }))
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

export const loadHeimdallMessagePreviewHoverPaddingEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(HEIMDALL_MESSAGE_PREVIEW_HOVER_PADDING_ENABLED_KEY)
    return stored !== null ? stored === 'true' : true
  } catch {
    return true
  }
}

export const saveHeimdallMessagePreviewHoverPaddingEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(HEIMDALL_MESSAGE_PREVIEW_HOVER_PADDING_ENABLED_KEY, String(enabled))
    window.dispatchEvent(
      new CustomEvent<boolean>(HEIMDALL_MESSAGE_PREVIEW_HOVER_PADDING_ENABLED_CHANGE_EVENT, { detail: enabled })
    )
  } catch {
    // no-op
  }
}
