import { describe, expect, it, vi } from 'vitest'
import { createCloudMirrorService } from '../cloudMirrorService.js'

function makeStatements() {
  return {
    upsertUser: { run: vi.fn() },
    upsertProject: { run: vi.fn() },
    upsertConversation: { run: vi.fn() },
    upsertMessage: { run: vi.fn() },
    upsertAttachment: { run: vi.fn() },
    upsertProviderCost: { run: vi.fn() },
    getAttachmentBySha256: { get: vi.fn(() => undefined) },
  }
}

/** Fake better-sqlite3 db: existence checks miss (force ensure-stub inserts), conversation lookups return a row. */
function makeDb() {
  const runCalls: Array<{ sql: string; args: any[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        get: (..._a: any[]) => {
          if (/SELECT user_id, project_id FROM conversations/.test(sql)) return { user_id: 'u-conv', project_id: 'p-conv' }
          if (/SELECT project_id FROM conversations/.test(sql)) return { project_id: 'p-conv' }
          return undefined
        },
        run: (...args: any[]) => {
          runCalls.push({ sql, args })
        },
      }
    },
  }
  return { db, runCalls }
}

describe('cloudMirrorService', () => {
  it('mirrors a project mapping owner_id→user_id and defaulting storage_mode to cloud', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('project', { id: 'p1', owner_id: 'o1', name: 'Proj' })
    expect(statements.upsertProject.run).toHaveBeenCalledWith(
      'p1',
      'Proj',
      'o1',
      null,
      null,
      null,
      'cloud',
      expect.any(String),
      expect.any(String)
    )
  })

  it('skips a project with no id or no user/owner id', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('project', { id: 'p1' }) // no user_id/owner_id
    await svc.mirror('project', { owner_id: 'o1' }) // no id
    expect(statements.upsertProject.run).not.toHaveBeenCalled()
  })

  it('mirrors a conversation mapping owner_id→user_id and defaulting model_name', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('conversation', { id: 'c1', owner_id: 'o1', project_id: 'p1', title: 'T' })
    expect(statements.upsertConversation.run).toHaveBeenCalledWith(
      'c1',
      'p1',
      'o1',
      'T',
      'unknown',
      null,
      null,
      null,
      null,
      'cloud',
      expect.any(String),
      expect.any(String)
    )
  })

  it('mirrorConversation reuses the existing local row user_id when a cloud UPDATE omits it (rename fix)', async () => {
    const statements = makeStatements()
    const db = {
      prepare(sql: string) {
        return {
          get: () => (/SELECT user_id FROM conversations WHERE id/.test(sql) ? { user_id: 'u-existing' } : undefined),
          run: () => {},
        }
      },
    }
    const svc = createCloudMirrorService({ db, statements })
    // A Railway PATCH (rename) response with no user_id/owner_id must still update the local mirror.
    await svc.mirror('conversation', { id: 'c1', title: 'renamed' })
    expect(statements.upsertConversation.run).toHaveBeenCalled()
    const args = statements.upsertConversation.run.mock.calls[0]
    expect(args[2]).toBe('u-existing') // effectiveUserId resolved from the existing row
    expect(args[3]).toBe('renamed') // new title persisted
  })

  it('mirrors a message: JSON-stringifies tool_calls/children_ids/content_blocks and touches timestamps', async () => {
    const statements = makeStatements()
    const { db, runCalls } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('message', { id: 'm1', conversation_id: 'c1', role: 'assistant', content: 'hi' })
    const args = statements.upsertMessage.run.mock.calls[0]
    expect(args[0]).toBe('m1')
    expect(args[1]).toBe('c1')
    expect(args[3]).toBe('[]') // children_ids default
    expect(args[8]).toBe('null') // tool_calls default (JSON)
    expect(args[10]).toBe('unknown') // model_name default
    expect(args[15]).toBe('null') // content_blocks default (JSON)
    // Timestamp touches ran.
    expect(runCalls.some(c => /UPDATE conversations SET updated_at/.test(c.sql))).toBe(true)
    expect(runCalls.some(c => /UPDATE projects SET updated_at/.test(c.sql))).toBe(true)
  })

  it('preserves already-stringified content_blocks/tool_calls without double-encoding', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('message', {
      id: 'm2',
      conversation_id: 'c1',
      role: 'user',
      content: 'x',
      tool_calls: '[{"id":"t"}]',
      content_blocks: '[{"type":"text"}]',
    })
    const args = statements.upsertMessage.run.mock.calls[0]
    expect(args[8]).toBe('[{"id":"t"}]')
    expect(args[15]).toBe('[{"type":"text"}]')
  })

  it('mirrors an attachment but skips when the sha256 already exists under another id', async () => {
    const statements = makeStatements()
    statements.getAttachmentBySha256.get = vi.fn(() => ({ id: 'existing-other' }))
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('attachment', { id: 'a1', sha256: 'deadbeef', kind: 'image', mime_type: 'image/png' })
    expect(statements.upsertAttachment.run).not.toHaveBeenCalled()
  })

  it('mirrors an attachment when sha256 is new', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('attachment', { id: 'a1', sha256: 'newhash', kind: 'image', mime_type: 'image/png', message_id: 'm1' })
    expect(statements.upsertAttachment.run).toHaveBeenCalledWith(
      'a1',
      'm1',
      'image',
      'image/png',
      'url',
      null,
      null,
      null,
      null,
      null,
      'newhash',
      expect.any(String),
      null
    )
  })

  it('mirrors provider-cost with numeric defaults', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await svc.mirror('provider-cost', { id: 'pc1', user_id: 'u1', message_id: 'm1' })
    expect(statements.upsertProviderCost.run).toHaveBeenCalledWith('pc1', 'u1', 'm1', 0, 0, 0, 0, 0, expect.any(String))
  })

  it('is a no-op for an unknown entity kind', async () => {
    const statements = makeStatements()
    const { db } = makeDb()
    const svc = createCloudMirrorService({ db, statements })
    await expect(svc.mirror('nope' as any, { id: 'x' })).resolves.toBeUndefined()
    expect(statements.upsertMessage.run).not.toHaveBeenCalled()
  })
})
