import { describe, expect, it } from 'vitest'
import { getTitleBarProjectId } from './titleBarProject'

const conversations = [
  { id: 'conversation-a', project_id: 'project-a' },
  { id: 'conversation-b', project_id: 'project-b' },
  { id: '42', project_id: 'project-c' },
]

describe('title bar project resolution', () => {
  it('follows back and forward routes without relying on the selected conversation', () => {
    for (const project of ['b', 'a', 'b']) {
      expect(getTitleBarProjectId(`/chat/project-${project}/conversation-${project}`, conversations))
        .toBe(`project-${project}`)
    }
  })

  it('uses the URL project even with stale or absent conversation metadata', () => {
    expect(getTitleBarProjectId('/chat/new-project/conversation-a', conversations)).toBe('new-project')
    expect(getTitleBarProjectId('/chat/new-project/not-loaded', [])).toBe('new-project')
  })

  it('supports lineage URLs', () => {
    expect(getTitleBarProjectId('/chat/project-b/conversation-b/lineage/branch', conversations)).toBe('project-b')
    expect(getTitleBarProjectId('/chat/unknown/conversation-b/lineage/branch', conversations)).toBe('project-b')
  })

  it('resolves unknown and null project placeholders from the route conversation only', () => {
    expect(getTitleBarProjectId('/chat/unknown/conversation-b', conversations)).toBe('project-b')
    expect(getTitleBarProjectId('/chat/null/42', conversations)).toBe('project-c')
    expect(getTitleBarProjectId('/chat/unknown/not-loaded', conversations)).toBeNull()
    expect(getTitleBarProjectId('/chat/unknown/no-project', [{ id: 'no-project', project_id: null }])).toBeNull()
  })

  it('does not reuse a selected project on non-chat routes', () => {
    for (const pathname of ['/settings', '/logging', '/projects/project-a/lineages/recent']) {
      expect(getTitleBarProjectId(pathname, conversations)).toBeNull()
    }
  })
})
