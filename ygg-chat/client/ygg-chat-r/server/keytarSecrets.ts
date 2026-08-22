const KEYTAR_PRIMARY_SERVICE_NAME = 'ygg-chat'
const KEYTAR_LEGACY_SERVICE_NAMES = ['ygg-chat-r', 'com.yggdrasil.chat']
const BRAVE_SEARCH_API_KEY_ACCOUNT = 'api-key:brave-search'

type KeytarModule = {
  getPassword: (service: string, account: string) => Promise<string | null>
  setPassword: (service: string, account: string, password: string) => Promise<void>
  deletePassword: (service: string, account: string) => Promise<boolean>
}

let cachedKeytar: KeytarModule | null | undefined

const KEYTAR_SERVICE_NAMES = [KEYTAR_PRIMARY_SERVICE_NAME, ...KEYTAR_LEGACY_SERVICE_NAMES]

function getNodeRequire(): NodeRequire | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return Function('return typeof require !== "undefined" ? require : null')() as NodeRequire | null
  } catch {
    return null
  }
}

async function loadKeytarViaImport(): Promise<KeytarModule> {
  const imported = await import('keytar')
  const resolved = (imported as any)?.default ?? imported
  if (!resolved || typeof resolved.getPassword !== 'function') {
    throw new Error('keytar module loaded but does not expose expected API')
  }
  return resolved as KeytarModule
}

async function getKeytar(): Promise<KeytarModule> {
  if (cachedKeytar) return cachedKeytar
  if (cachedKeytar === null) {
    throw new Error('keytar is unavailable')
  }

  try {
    const nodeRequire = getNodeRequire()
    if (nodeRequire) {
      const loaded = nodeRequire('keytar') as KeytarModule
      cachedKeytar = loaded
      return loaded
    }
  } catch {
    // Fall through to dynamic import below.
  }

  try {
    const loaded = await loadKeytarViaImport()
    cachedKeytar = loaded
    return loaded
  } catch (error) {
    cachedKeytar = null
    throw new Error(
      `Secure credential storage is unavailable because keytar could not be loaded: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export async function getSecureSecret(account: string): Promise<string | null> {
  const keytar = await getKeytar()

  for (const serviceName of KEYTAR_SERVICE_NAMES) {
    const value = await keytar.getPassword(serviceName, account)
    if (value) {
      if (serviceName !== KEYTAR_PRIMARY_SERVICE_NAME) {
        try {
          await keytar.setPassword(KEYTAR_PRIMARY_SERVICE_NAME, account, value)
        } catch {
          // Ignore migration write errors; returning the found value is more important.
        }
      }
      return value
    }
  }

  return null
}

export async function setSecureSecret(account: string, value: string): Promise<void> {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error('Secret value cannot be empty')
  }
  const keytar = await getKeytar()
  await keytar.setPassword(KEYTAR_PRIMARY_SERVICE_NAME, account, normalized)
}

export async function deleteSecureSecret(account: string): Promise<boolean> {
  const keytar = await getKeytar()
  let deleted = false

  for (const serviceName of KEYTAR_SERVICE_NAMES) {
    try {
      const removed = await keytar.deletePassword(serviceName, account)
      deleted = deleted || removed
    } catch {
      // Continue attempting other service names.
    }
  }

  return deleted
}

export async function getBraveApiKey(): Promise<string | null> {
  return await getSecureSecret(BRAVE_SEARCH_API_KEY_ACCOUNT)
}

export async function hasBraveApiKey(): Promise<boolean> {
  const value = await getBraveApiKey()
  return typeof value === 'string' && value.length > 0
}

export async function setBraveApiKey(value: string): Promise<void> {
  await setSecureSecret(BRAVE_SEARCH_API_KEY_ACCOUNT, value)
}

export async function deleteBraveApiKey(): Promise<boolean> {
  return await deleteSecureSecret(BRAVE_SEARCH_API_KEY_ACCOUNT)
}
