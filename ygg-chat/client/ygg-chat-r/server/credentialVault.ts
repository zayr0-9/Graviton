export interface CredentialBackend {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>
}

export const CREDENTIAL_SERVICE = 'ygg-chat'
export const CREDENTIAL_VAULT_ACCOUNT = 'graviton-credential-vault'
const LEGACY_SERVICES = [CREDENTIAL_SERVICE, 'ygg-chat-r', 'com.yggdrasil.chat']

interface Vault {
  version: 1
  secrets: Record<string, string>
  // Includes intentional deletions, so an old item cannot resurrect a removed key.
  resolved: Record<string, boolean>
  consolidated: boolean
}

export interface ConsolidationResult {
  migrated: number
  removed: number
  complete: boolean
  warnings: string[]
}

const emptyVault = (): Vault => ({ version: 1, secrets: Object.create(null), resolved: Object.create(null), consolidated: false })
const owns = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)
const managedAccount = (account: string): boolean => account === 'api-key:brave-search' || account.startsWith('mcp-oauth:')

function parseVault(encoded: string | null): Vault {
  if (encoded === null) return emptyVault()
  let value: any
  try { value = JSON.parse(encoded) } catch { throw new Error('Stored credential vault is invalid; it has not been overwritten.') }
  const dictionary = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input)
  if (!value || value.version !== 1 || !dictionary(value.secrets) || !dictionary(value.resolved) ||
      typeof value.consolidated !== 'boolean' || Object.values(value.secrets).some(secret => typeof secret !== 'string') ||
      Object.values(value.resolved).some(resolved => typeof resolved !== 'boolean')) {
    throw new Error('Unsupported or invalid credential vault; it has not been overwritten.')
  }
  return { version: 1, secrets: Object.assign(Object.create(null), value.secrets), resolved: Object.assign(Object.create(null), value.resolved), consolidated: value.consolidated }
}

/** One OS credential item. No normal operation probes legacy per-account items. */
export class CredentialVault {
  private queue: Promise<unknown> = Promise.resolve()
  private readPromise: Promise<Vault> | undefined

  constructor(
    private readonly backend: () => Promise<CredentialBackend>,
    private readonly withLock: <T>(work: () => Promise<T>) => Promise<T>,
  ) {}

  private async read(backend: CredentialBackend): Promise<Vault> {
    return parseVault(await backend.getPassword(CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT))
  }

  private transaction<T>(work: (backend: CredentialBackend, vault: Vault) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.withLock(async () => {
      const backend = await this.backend()
      const vault = await this.read(backend)
      return work(backend, vault)
    }))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async write(backend: CredentialBackend, vault: Vault): Promise<void> {
    const encoded = JSON.stringify(vault)
    await backend.setPassword(CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT, encoded)
    if (await backend.getPassword(CREDENTIAL_SERVICE, CREDENTIAL_VAULT_ACCOUNT) !== encoded) {
      throw new Error('Credential vault persistence could not be verified.')
    }
  }

  async get(account: string, requireConsolidation = false): Promise<string | null> {
    // Coalesce overlapping readers, not a lifetime cache (other hosts can write).
    if (!this.readPromise) {
      const pending = this.queue.then(async () => this.read(await this.backend()))
      this.readPromise = pending
      void pending.then(() => { if (this.readPromise === pending) this.readPromise = undefined }, () => { if (this.readPromise === pending) this.readPromise = undefined })
    }
    const vault = await this.readPromise
    if (owns(vault.secrets, account)) return vault.secrets[account]
    if (requireConsolidation && !vault.consolidated && !owns(vault.resolved, account)) {
      throw new Error('Existing MCP credentials may need migration. Open Settings → API Keys → Consolidate credentials, then retry.')
    }
    return null
  }

  async set(account: string, value: string): Promise<void> {
    const normalized = value.trim()
    if (!normalized) throw new Error('Secret value cannot be empty')
    await this.transaction(async (backend, vault) => {
      vault.secrets[account] = normalized
      vault.resolved[account] = true
      await this.write(backend, vault)
    })
  }

  /** Import old plaintext only when this account has never been resolved. */
  async importLegacy(account: string, value: string): Promise<void> {
    await this.transaction(async (backend, vault) => {
      if (owns(vault.resolved, account) || owns(vault.secrets, account)) return
      vault.secrets[account] = value
      vault.resolved[account] = true
      await this.write(backend, vault)
    })
  }

  /** Atomic logical-account patch; callback never leaves the trusted process. */
  async update(account: string, transform: (current: string | null) => string | null): Promise<void> {
    await this.transaction(async (backend, vault) => {
      const next = transform(owns(vault.secrets, account) ? vault.secrets[account] : null)
      if (next === null) delete vault.secrets[account]
      else vault.secrets[account] = next
      vault.resolved[account] = true
      await this.write(backend, vault)
    })
  }

  async delete(account: string): Promise<boolean> {
    return this.transaction(async (backend, vault) => {
      const existed = owns(vault.secrets, account)
      delete vault.secrets[account]
      vault.resolved[account] = true
      await this.write(backend, vault)
      return existed
    })
  }

  async consolidate(): Promise<ConsolidationResult> {
    return this.transaction(async (backend, vault) => {
      // Enumerate only on explicit user action. If any enumeration fails, do not
      // choose a lower-precedence copy or delete any original.
      const copies: Array<{ service: string; account: string; password: string }> = []
      for (const service of LEGACY_SERVICES) {
        const credentials = await backend.findCredentials(service)
        for (const credential of credentials) {
          if (managedAccount(credential.account)) copies.push({ service, ...credential })
        }
      }
      let migrated = 0
      for (const copy of copies) {
        if (!owns(vault.resolved, copy.account) && !owns(vault.secrets, copy.account)) {
          vault.secrets[copy.account] = copy.password
          vault.resolved[copy.account] = true
          migrated++
        }
      }
      vault.consolidated = true
      await this.write(backend, vault)
      let removed = 0
      const warnings: string[] = []
      for (const copy of copies) {
        try {
          if (await backend.deletePassword(copy.service, copy.account)) removed++
          else if (await backend.getPassword(copy.service, copy.account) !== null) {
            warnings.push('An old credential copy could not be removed. Retry consolidation to finish cleanup.')
          }
        } catch {
          warnings.push('An old credential copy could not be removed. Retry consolidation to finish cleanup.')
        }
      }
      return { migrated, removed, complete: warnings.length === 0, warnings: [...new Set(warnings)] }
    })
  }
}
