import { describe, expect, it } from 'vitest'
import { getSearchResultHref } from './searchResultNavigation'

const result = {
  project_id: 'project-1',
  conversation_id: 'conversation-1',
  message_id: 'message-on-other-branch',
  match_type: 'fts' as const,
}

describe('search result navigation', () => {
  it('anchors full-text hits to the matched message, not just the chat', () => {
    expect(getSearchResultHref(result)).toBe('/chat/project-1/conversation-1#message-on-other-branch')
  })

  it('anchors fuzzy hits too', () => {
    expect(getSearchResultHref({ ...result, match_type: 'fuzzy' })).toBe('/chat/project-1/conversation-1#message-on-other-branch')
  })

  it('distinguishes results on different branches of the same conversation', () => {
    expect(getSearchResultHref({ ...result, message_id: 'sibling-branch-message' })).not.toBe(getSearchResultHref(result))
  })

  it('does not treat a title-only fallback synthetic id as a message', () => {
    expect(getSearchResultHref({ ...result, message_id: result.conversation_id, match_type: 'fallback' })).toBe('/chat/project-1/conversation-1')
  })

  it('preserves the unknown project route fallback', () => {
    expect(getSearchResultHref({ ...result, project_id: null })).toBe('/chat/unknown/conversation-1#message-on-other-branch')
  })

  it('omits empty anchors', () => {
    expect(getSearchResultHref({ ...result, message_id: '' })).toBe('/chat/project-1/conversation-1')
  })
})
