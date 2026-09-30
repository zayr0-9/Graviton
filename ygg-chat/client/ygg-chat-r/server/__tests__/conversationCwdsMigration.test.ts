import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../localServer.ts', import.meta.url), 'utf8')

// Exercise the production registry/runner without importing the server's tool,
// auth and worker graph or starting the application. Do not duplicate migration SQL.
const migrationStart = source.indexOf('function createHookRunsSchema(')
const migrationEnd = source.indexOf('// Initialize database at specified path', migrationStart)
if (migrationStart < 0 || migrationEnd < 0) throw new Error('Cannot locate production schema migrations')
const migrationCode = ts.transpileModule(source.slice(migrationStart, migrationEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const migrations = runInNewContext(`${migrationCode}\n({ SCHEMA_MIGRATIONS, runSchemaMigrations })`, {
  console: { log: vi.fn(), error: vi.fn() },
}) as {
  SCHEMA_MIGRATIONS: { version: number; name: string; up: (db: any) => void }[]
  runSchemaMigrations: (db: any) => void
}
const migration = migrations.SCHEMA_MIGRATIONS.find(entry => entry.name === 'conversation_additional_cwds')!
const freshSchema = source.match(/CREATE TABLE IF NOT EXISTS conversations \([\s\S]*?\n    \)/)?.[0]
if (!freshSchema) throw new Error('Cannot locate production conversations schema')

function openDatabase(): any {
  // Prefer the application's driver. Electron-ABI builds cannot load under plain
  // Node; Node >=22.13 supplies SQLite without rebuilding the app's native addon.
  try {
    const Database = require('better-sqlite3')
    return new Database(':memory:')
  } catch {
    const { DatabaseSync } = require('node:sqlite')
    const database = new DatabaseSync(':memory:')
    return {
      exec: (sql: string) => database.exec(sql),
      prepare: (sql: string) => database.prepare(sql),
      pragma: (sql: string, options?: { simple?: boolean }) => {
        const rows = database.prepare(`PRAGMA ${sql}`).all()
        return options?.simple ? Object.values(rows[0] ?? {})[0] : rows
      },
      close: () => database.close(),
    }
  }
}

function columns(db: any): any[] {
  return db.prepare('PRAGMA table_info(conversations)').all()
}

function createFreshTable(db: any): void {
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY)')
  db.exec(freshSchema)
  db.exec("INSERT INTO users (id) VALUES ('user-1')")
}

describe('conversation additional_cwds migration', () => {
  let db: any

  beforeEach(() => {
    db = openDatabase()
    db.pragma('user_version = 3')
  })

  afterEach(() => db.close())

  it('registers v4 and runs migrations during initialization before preparing statements', () => {
    expect(migration.version).toBe(4)
    expect(migrations.SCHEMA_MIGRATIONS.map(entry => entry.version)).toEqual([1, 2, 3, 4])
    const initialization = source.slice(source.indexOf('function initializeLocalDatabase('))
    const runnerCall = initialization.indexOf('runSchemaMigrations(db)')
    expect(runnerCall).toBeGreaterThan(initialization.indexOf('CREATE TABLE IF NOT EXISTS conversations'))
    expect(runnerCall).toBeLessThan(initialization.indexOf('upsertConversation: db.prepare('))
  })

  it('upgrades a v3 table without rewriting cwd or other existing data', () => {
    db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, cwd TEXT, title TEXT)')
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run('old', '/projects/frontend', 'Existing chat')
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?)').run('no-root', null, null)

    migrations.runSchemaMigrations(db)

    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(columns(db).find(column => column.name === 'additional_cwds')).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(db.prepare('SELECT * FROM conversations WHERE id = ?').get('old')).toEqual({
      id: 'old', cwd: '/projects/frontend', title: 'Existing chat', additional_cwds: null,
    })
    expect(db.prepare('SELECT cwd, additional_cwds FROM conversations WHERE id = ?').get('no-root'))
      .toEqual({ cwd: null, additional_cwds: null })
  })

  it('creates the same nullable column for fresh databases', () => {
    createFreshTable(db)
    const before = columns(db)
    migrations.runSchemaMigrations(db)
    expect(columns(db)).toEqual(before)
    db.prepare('INSERT INTO conversations (id, user_id, cwd) VALUES (?, ?, ?)')
      .run('new', 'user-1', '/projects/frontend')
    expect(db.prepare('SELECT cwd, additional_cwds FROM conversations').get())
      .toEqual({ cwd: '/projects/frontend', additional_cwds: null })
  })

  it('preserves stored JSON on a second launch and when the migration is retried', () => {
    createFreshTable(db)
    const roots = ['/projects/backend', '/projects/shared folder', 'C:\\projects\\backend']
    db.prepare('INSERT INTO conversations (id, user_id, cwd, additional_cwds) VALUES (?, ?, ?, ?)')
      .run('new', 'user-1', '/projects/frontend', JSON.stringify(roots))
    migration.up(db)
    migration.up(db)
    migrations.runSchemaMigrations(db)
    const exec = vi.spyOn(db, 'exec')
    migrations.runSchemaMigrations(db)
    expect(exec).not.toHaveBeenCalled()
    expect(JSON.parse(db.prepare('SELECT additional_cwds FROM conversations').get().additional_cwds)).toEqual(roots)
    expect(columns(db).filter(column => column.name === 'additional_cwds')).toHaveLength(1)
  })

  it('does not stamp a failed migration and retries successfully afterwards', () => {
    expect(() => migrations.runSchemaMigrations(db)).toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, cwd TEXT)')
    migrations.runSchemaMigrations(db)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
  })
})
