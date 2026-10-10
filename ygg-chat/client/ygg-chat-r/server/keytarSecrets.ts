import { CredentialVault, type CredentialBackend } from './credentialVault.js'
import { withCredentialVaultLock } from './credentialVaultLock.js'
const BRAVE_SEARCH_API_KEY_ACCOUNT = 'api-key:brave-search'

type KeytarModule = CredentialBackend

let cachedKeytar: KeytarModule | null | undefined

const vault = new CredentialVault(getKeytar, withCredentialVaultLock)

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
      'Secure credential storage is unavailable because keytar could not be loaded.'
    )
  }
}

export async function getSecureSecret(account: string, requireConsolidation = false): Promise<string | null> {
  return vault.get(account, requireConsolidation)
}

export async function setSecureSecret(account: string, value: string): Promise<void> {
  return vault.set(account, value)
}

export async function deleteSecureSecret(account: string): Promise<boolean> {
  return vault.delete(account)
}

export async function importLegacySecureSecret(account: string, value: string): Promise<void> {
  return vault.importLegacy(account, value)
}

export async function updateSecureSecret(account: string, transform: (current: string | null) => string | null): Promise<void> {
  return vault.update(account, transform)
}

export async function consolidateSecureSecrets() {
  return vault.consolidate()
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
