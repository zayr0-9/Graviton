import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Keep the public navigation boundary explicit. Automatic stream advancement and deletion repair
// live in reducers/actions and are intentionally not prohibited by this UI-only boundary test.
const callers = [
  'containers/Chat.tsx', 'containers/sideBar.tsx', 'containers/RecentLineages.tsx',
  'containers/ConversationPage.tsx', 'containers/HomepageRedirect.tsx', 'containers/Homepage.tsx',
  'components/Heimdall/Heimdall.tsx', 'components/QuickInput/QuickInput.tsx',
  'components/LowBar/ResearchNotesList.tsx', 'components/RunningAgentsFloatingButton/RunningAgentsFloatingButton.tsx',
  'components/MarkdownLink/MarkdownLink.tsx', 'components/ChatMessage/ChatMessage.tsx',
  'components/GlobalNotifications/GlobalNotifications.tsx',
]

describe('primary navigation ownership boundary', () => {
  it.each(callers)('%s delegates chat navigation and never directly selects path/focus', file => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    expect(source).toContain('ChatSelectionProvider')
    expect(source).not.toMatch(/dispatch\(chatSliceActions\.(conversationPathSet|focusedChatMessageSet|lineageSelected)\(/)
    expect(source).not.toMatch(/import\s*\{[^}]*\buseNavigate\b[^}]*\}\s*from\s*['"]react-router-dom/)
  })
})
