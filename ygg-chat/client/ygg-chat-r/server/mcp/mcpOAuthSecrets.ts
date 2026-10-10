import { deleteSecureSecret, getSecureSecret, setSecureSecret, importLegacySecureSecret, updateSecureSecret } from '../keytarSecrets.js'

export interface McpOAuthSecrets {
  accessToken?: string
  refreshToken?: string
  clientSecret?: string
}

export interface McpOAuthSecretStore {
  load(serverName: string, requireConsolidation?: boolean): Promise<McpOAuthSecrets>
  save(serverName: string, secrets: McpOAuthSecrets): Promise<void>
  clear(serverName: string): Promise<void>
  importLegacy(serverName: string, secrets: McpOAuthSecrets): Promise<void>
  patch(serverName: string, secrets: McpOAuthSecrets): Promise<void>
}

const accountFor = (serverName: string): string => `mcp-oauth:${serverName}`

export const mcpOAuthSecretStore: McpOAuthSecretStore = {
  async load(serverName, requireConsolidation = false) {
    const encoded = await getSecureSecret(accountFor(serverName), requireConsolidation)
    if (!encoded) return {}

    try {
      const parsed = JSON.parse(encoded) as McpOAuthSecrets
      return {
        accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
        clientSecret: typeof parsed.clientSecret === 'string' ? parsed.clientSecret : undefined,
      }
    } catch {
      throw new Error(`Stored OAuth credentials for MCP server '${serverName}' are invalid`)
    }
  },

  async save(serverName, secrets) {
    const compact = Object.fromEntries(
      Object.entries(secrets).filter(([, value]) => typeof value === 'string' && value.length > 0)
    ) as McpOAuthSecrets

    if (Object.keys(compact).length === 0) {
      await this.clear(serverName)
      return
    }

    await setSecureSecret(accountFor(serverName), JSON.stringify(compact))
  },

  async importLegacy(serverName, secrets) {
    await importLegacySecureSecret(accountFor(serverName), JSON.stringify(secrets))
  },

  async patch(serverName, secrets) {
    await updateSecureSecret(accountFor(serverName), current => {
      let stored: McpOAuthSecrets = {}
      if (current) {
        try { stored = JSON.parse(current) as McpOAuthSecrets } catch { throw new Error('Stored MCP credentials are invalid') }
      }
      const next = Object.fromEntries(Object.entries({ ...stored, ...secrets }).filter(([, value]) => typeof value === 'string' && value.length > 0))
      return Object.keys(next).length ? JSON.stringify(next) : null
    })
  },

  async clear(serverName) {
    await deleteSecureSecret(accountFor(serverName))
  },
}
