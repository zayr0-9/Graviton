import type Database from 'better-sqlite3'

export interface ProviderTokenRecord {
  provider: string
  userId: string
  accessToken: string
  refreshToken?: string | null
  expiresAt?: string | null
  accountId?: string | null
}

interface DbStatements {
  getToken: Database.Statement
  getLatestToken: Database.Statement
  upsertToken: Database.Statement
  deleteToken: Database.Statement
}

/**
 * Provider token storage.
 *
 * - If a DB handle is provided, tokens are persisted in SQLite (`provider_tokens`).
 * - If no DB handle is provided (tests/lightweight contexts), falls back to in-memory Map.
 */
export class ProviderTokenStore {
  private readonly db?: Database.Database
  private readonly statements?: DbStatements
  private readonly memoryTokens = new Map<string, ProviderTokenRecord>()

  constructor(db?: Database.Database) {
    this.db = db

    if (!db) return

    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_tokens (
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TEXT,
        account_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, user_id)
      )
    `)

    this.statements = {
      getToken: db.prepare(`
        SELECT
          provider,
          user_id,
          access_token,
          refresh_token,
          expires_at,
          account_id
        FROM provider_tokens
        WHERE provider = ? AND user_id = ?
      `),
      getLatestToken: db.prepare(`
        SELECT
          provider,
          user_id,
          access_token,
          refresh_token,
          expires_at,
          account_id
        FROM provider_tokens
        WHERE provider = ?
        ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
        LIMIT 1
      `),
      upsertToken: db.prepare(`
        INSERT INTO provider_tokens (provider, user_id, access_token, refresh_token, expires_at, account_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(provider, user_id) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          account_id = excluded.account_id,
          updated_at = CURRENT_TIMESTAMP
      `),
      deleteToken: db.prepare(`DELETE FROM provider_tokens WHERE provider = ? AND user_id = ?`),
    }
  }

  private key(provider: string, userId: string): string {
    return `${provider}::${userId}`
  }

  get(provider: string, userId: string): ProviderTokenRecord | null {
    if (this.db && this.statements) {
      const row = this.statements.getToken.get(provider, userId) as
        | {
            provider: string
            user_id: string
            access_token: string
            refresh_token?: string | null
            expires_at?: string | null
            account_id?: string | null
          }
        | undefined

      if (!row) return null
      return {
        provider: row.provider,
        userId: row.user_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token ?? null,
        expiresAt: row.expires_at ?? null,
        accountId: row.account_id ?? null,
      }
    }

    return this.memoryTokens.get(this.key(provider, userId)) ?? null
  }

  getLatest(provider: string): ProviderTokenRecord | null {
    if (this.db && this.statements) {
      const row = this.statements.getLatestToken.get(provider) as
        | {
            provider: string
            user_id: string
            access_token: string
            refresh_token?: string | null
            expires_at?: string | null
            account_id?: string | null
          }
        | undefined

      if (!row) return null
      return {
        provider: row.provider,
        userId: row.user_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token ?? null,
        expiresAt: row.expires_at ?? null,
        accountId: row.account_id ?? null,
      }
    }

    const latest = Array.from(this.memoryTokens.values())
      .filter(record => record.provider === provider)
      .at(-1)

    return latest ?? null
  }

  upsert(record: ProviderTokenRecord): void {
    if (this.db && this.statements) {
      this.statements.upsertToken.run(
        record.provider,
        record.userId,
        record.accessToken,
        record.refreshToken ?? null,
        record.expiresAt ?? null,
        record.accountId ?? null
      )
      return
    }

    this.memoryTokens.set(this.key(record.provider, record.userId), {
      provider: record.provider,
      userId: record.userId,
      accessToken: record.accessToken,
      refreshToken: record.refreshToken ?? null,
      expiresAt: record.expiresAt ?? null,
      accountId: record.accountId ?? null,
    })
  }

  delete(provider: string, userId: string): void {
    if (this.db && this.statements) {
      this.statements.deleteToken.run(provider, userId)
      return
    }

    this.memoryTokens.delete(this.key(provider, userId))
  }
}
