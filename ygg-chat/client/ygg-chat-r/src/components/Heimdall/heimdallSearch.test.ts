import { describe, expect, it } from 'vitest'
import { heimdallSearchRoleOf, searchHeimdallMessages } from './heimdallSearch'

const messages = [
  { id: 'u1', role: 'user', content: 'Deploy the **API**', content_plain_text: 'Deploy the API' },
  { id: 'a1', role: 'assistant', content: 'The api is deployed' },
  { id: 'x1', role: 'ex_agent', content: 'Agent checked the API logs' },
  { id: 's1', role: 'system', content: 'api context' },
  { id: 'u2', role: 'user', content: 'Unrelated question' },
]

describe('searchHeimdallMessages', () => {
  it('returns nothing for an empty query', () => {
    expect(searchHeimdallMessages(messages, '   ', 'all')).toEqual({ results: [], counts: { all: 0, user: 0, assistant: 0 } })
  })

  it('matches case-insensitively against plain text and counts every role', () => {
    const { results, counts } = searchHeimdallMessages(messages, 'API', 'all')
    expect(results.map(r => r.id)).toEqual(['u1', 'a1', 'x1', 's1'])
    expect(results[0].plain).toBe('Deploy the API')
    expect(counts).toEqual({ all: 4, user: 1, assistant: 2 })
  })

  it('filters to user messages while keeping counts for the other chips', () => {
    const { results, counts } = searchHeimdallMessages(messages, 'api', 'user')
    expect(results.map(r => r.id)).toEqual(['u1'])
    expect(counts.all).toBe(4)
  })

  it('treats ex_agent rows as assistant and excludes other roles', () => {
    const { results } = searchHeimdallMessages(messages, 'api', 'assistant')
    expect(results.map(r => r.id)).toEqual(['a1', 'x1'])
  })

  it('maps roles onto filter groups', () => {
    expect(heimdallSearchRoleOf('user')).toBe('user')
    expect(heimdallSearchRoleOf('ex_agent')).toBe('assistant')
    expect(heimdallSearchRoleOf('tool')).toBeNull()
  })
})
