import { describe, expect, it } from 'vitest'
import { LOCAL_USER_ID } from '../../../../shared/localUser.js'
import { ensureLocalUser, reassignLegacyAccountData } from '../auth/localIdentity.js'

let Database: any = null
try {
  Database = (await import('better-sqlite3')).default
  new Database(':memory:').close()
} catch {
  Database = null
}
const describeIfSqlite = Database ? describe : describe.skip

function createDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, created_at TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE provider_cost (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE note_search_docs (message_id TEXT PRIMARY KEY, user_id TEXT);
  `)
  return db
}

describeIfSqlite('local identity (fully-local plan D4/Q5)', () => {
  it('seeds the local user idempotently', () => {
    const db = createDb()
    ensureLocalUser(db)
    ensureLocalUser(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(LOCAL_USER_ID).n).toBe(1)
  })

  it('moves rows owned by the retired account to the local user and keeps the old user row', () => {
    const db = createDb()
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('cloud-user', 'cloud')
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('other', 'other')
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('p1', 'cloud-user')
    db.prepare('INSERT INTO conversations VALUES (?, ?)').run('c1', 'cloud-user')
    db.prepare('INSERT INTO conversations VALUES (?, ?)').run('c2', 'other')
    db.prepare('INSERT INTO provider_cost VALUES (?, ?)').run('pc1', 'cloud-user')
    db.prepare('INSERT INTO note_search_docs VALUES (?, ?)').run('m1', 'cloud-user')

    expect(reassignLegacyAccountData(db, 'cloud-user')).toBe(4)
    expect(db.prepare('SELECT user_id FROM projects WHERE id = ?').get('p1').user_id).toBe(LOCAL_USER_ID)
    expect(db.prepare('SELECT user_id FROM conversations WHERE id = ?').get('c1').user_id).toBe(LOCAL_USER_ID)
    expect(db.prepare('SELECT user_id FROM conversations WHERE id = ?').get('c2').user_id).toBe('other')
    expect(db.prepare('SELECT user_id FROM note_search_docs WHERE message_id = ?').get('m1').user_id).toBe(LOCAL_USER_ID)
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get('cloud-user').n).toBe(1)
    // Idempotent: a second run moves nothing.
    expect(reassignLegacyAccountData(db, 'cloud-user')).toBe(0)
  })

  it('is a no-op for the local user itself', () => {
    expect(reassignLegacyAccountData(createDb(), LOCAL_USER_ID)).toBe(0)
  })
})
