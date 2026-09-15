type RuntimeAuthSnapshot = {
  accessToken: string | null
  userId: string | null
}

export const LOCAL_AUTH_USER_ID = 'a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3'
const LOCAL_AUTH_TOKENS = new Set(['electron-local-token', 'local-mode-token'])

export const isElectronMode =
  (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) || import.meta.env.VITE_ENVIRONMENT === 'electron'

const isLikelyJwt = (token: string | null | undefined): boolean => {
  if (!token || typeof token !== 'string') return false
  return token.split('.').length === 3
}

export const isCloudSession = (snapshot: Partial<RuntimeAuthSnapshot> | null | undefined): boolean => {
  const accessToken = snapshot?.accessToken || null
  const userId = snapshot?.userId || null

  if (userId && userId !== LOCAL_AUTH_USER_ID) return true
  if (!accessToken || !userId) return false
  if (LOCAL_AUTH_TOKENS.has(accessToken)) return false

  return isLikelyJwt(accessToken)
}

let runtimeIdentity: RuntimeAuthSnapshot = { accessToken: null, userId: null }
const readRuntimeSnapshotFromStorage = (): RuntimeAuthSnapshot => runtimeIdentity

let cloudSessionEnabled = isCloudSession(readRuntimeSnapshotFromStorage())

export let isCommunityMode = !cloudSessionEnabled
export let isElectronCommunityMode = isElectronMode && isCommunityMode
export let isCloudBackendAllowed = cloudSessionEnabled

const applyRuntimeAuthMode = (enabled: boolean) => {
  cloudSessionEnabled = enabled
  isCommunityMode = !enabled
  isElectronCommunityMode = isElectronMode && isCommunityMode
  isCloudBackendAllowed = enabled
}

export const syncRuntimeAuthMode = (snapshot?: Partial<RuntimeAuthSnapshot> | null) => {
  const resolved = snapshot
    ? {
        accessToken: snapshot.accessToken || null,
        userId: snapshot.userId || null,
      }
    : readRuntimeSnapshotFromStorage()

  runtimeIdentity = { userId: resolved.userId, accessToken: null }
  applyRuntimeAuthMode(isCloudSession(resolved))
}

export const isCloudSessionEnabled = () => cloudSessionEnabled
