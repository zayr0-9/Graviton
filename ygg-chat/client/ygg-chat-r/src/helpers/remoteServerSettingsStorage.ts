export const REMOTE_SERVER_SETTINGS_STORAGE_KEY = 'ygg_remote_server_settings'
export const REMOTE_SERVER_SETTINGS_CHANGE_EVENT = 'ygg-remote-server-settings-change'

export interface RemoteServerSettings {
  remoteBaseUrl: string | null
}

const DEFAULT_REMOTE_SERVER_SETTINGS: RemoteServerSettings = {
  remoteBaseUrl: null,
}

export const normalizeRemoteBaseUrl = (value: string | null | undefined): string | null => {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed)) return null
  return trimmed
}

export const buildRemoteMobileUrl = (baseUrl: string | null | undefined): string | null => {
  const normalized = normalizeRemoteBaseUrl(baseUrl)
  if (!normalized) return null
  return `${normalized}/mobile`
}

export const loadRemoteServerSettings = (): RemoteServerSettings => {
  try {
    const stored = localStorage.getItem(REMOTE_SERVER_SETTINGS_STORAGE_KEY)
    const parsed = stored ? (JSON.parse(stored) as Partial<RemoteServerSettings>) : DEFAULT_REMOTE_SERVER_SETTINGS
    return {
      remoteBaseUrl: normalizeRemoteBaseUrl(parsed.remoteBaseUrl) ?? null,
    }
  } catch {
    return { ...DEFAULT_REMOTE_SERVER_SETTINGS }
  }
}

export const saveRemoteServerSettings = (settings: RemoteServerSettings): RemoteServerSettings => {
  const normalized: RemoteServerSettings = {
    remoteBaseUrl: normalizeRemoteBaseUrl(settings.remoteBaseUrl) ?? null,
  }

  try {
    localStorage.setItem(REMOTE_SERVER_SETTINGS_STORAGE_KEY, JSON.stringify(normalized))
    window.dispatchEvent(new CustomEvent<RemoteServerSettings>(REMOTE_SERVER_SETTINGS_CHANGE_EVENT, { detail: normalized }))
  } catch {
    // no-op
  }

  return normalized
}

export const buildSharedBrowserUrl = (baseUrl: string | null | undefined): string | null => {
  const normalized = normalizeRemoteBaseUrl(baseUrl)
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    if (url.username || url.password || url.hostname === '0.0.0.0' || url.hostname === '[::]') return null
    return `${url.origin}/`
  } catch { return null }
}
