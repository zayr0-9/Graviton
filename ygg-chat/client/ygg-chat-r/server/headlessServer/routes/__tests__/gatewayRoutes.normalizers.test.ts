import { describe, expect, it } from 'vitest'
import { sortByUpdatedDesc, toLocalConversationCreate, toLocalProjectCreate } from '../gatewayRoutes.js'

const row = (id: string, updated_at: string) => ({ id, updated_at })

describe('gateway helpers', () => {
  it('sortByUpdatedDesc orders newest-first and tolerates bad dates', () => {
    const out = sortByUpdatedDesc([row('a', '2020-01-01'), row('b', '2022-01-01'), row('c', 'not-a-date')])
    expect(out.map(r => r.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('gateway write normalizers (canonical camelCase → local snake_case)', () => {
  it('toLocalConversationCreate maps camel→snake and forces storage_mode local', () => {
    const out = toLocalConversationCreate({
      userId: 'u1',
      title: 'T',
      projectId: 'p1',
      systemPrompt: 'sp',
      conversationContext: 'ctx',
      cwd: '/tmp',
      storageMode: 'cloud',
    })
    expect(out).toMatchObject({
      user_id: 'u1',
      title: 'T',
      project_id: 'p1',
      system_prompt: 'sp',
      conversation_context: 'ctx',
      cwd: '/tmp',
      storage_mode: 'local',
    })
  })

  it('toLocalProjectCreate carries cwd and user_id', () => {
    expect(toLocalProjectCreate({ userId: 'u1', name: 'P', system_prompt: 'sp', cwd: '/tmp' })).toMatchObject({
      user_id: 'u1',
      name: 'P',
      system_prompt: 'sp',
      cwd: '/tmp',
    })
  })
})
