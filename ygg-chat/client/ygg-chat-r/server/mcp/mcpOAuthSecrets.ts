import { deleteSecureSecret, getSecureSecret, setSecureSecret } from '../keytarSecrets.js'

export interface McpOAuthSecrets {
  accessToken?: string
  refreshToken?: string
  clientSecret?: string
}

export interface McpOAuthSecretStore {
  load(serverName: string): Promise<McpOAuthSecrets>
  save(serverName: string, secrets: McpOAuthSecrets): Promise<void>
  clear(serverName: string): Promise<void>
}

const accountFor = (serverName: string): string => `mcp-oauth:${serverName}`

export const mcpOAuthSecretStore: McpOAuthSecretStore = {
  async load(serverName) {
    const encoded = await getSecureSecret(accountFor(serverName))
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

  async clear(serverName) {
    await deleteSecureSecret(accountFor(serverName))
  },
}
