import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_STEP_LABELS_KEY, loadActivityStepLabels, saveActivityStepLabels } from '../../helpers/activityStepLabelsSettings'
import type { ContentBlock, HookRunRecord } from '../../features/chats/chatTypes'
import { MessageActivity } from './MessageActivity'

vi.mock('../ThemeManager/themeConfig', () => ({
  useHtmlDarkMode: () => false,
  useCustomChatTheme: () => ({ enabled: false }),
  getCustomChatThemeEnabled: () => false,
}))
vi.mock('../../utils/api', () => ({ localApi: { get: vi.fn() } }))

const blocks: ContentBlock[] = [
  { type: 'tool_use', id: 'read', name: 'read_file', input: {}, index: 0 },
  { type: 'context_injection', tool_use_id: 'read', path: 'docs/rule.md', label: 'Rule', reason: 'path_glob_match', text: 'Hidden body' },
  { type: 'tool_use', id: 'skill', name: 'skill_manager', input: {}, index: 2 },
  { type: 'context_injection', tool_use_id: 'skill', path: 'skills/motion.md', label: 'Motion', reason: 'skill', text: 'Hidden skill' },
]

describe('MessageActivity', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('hides step labels by default while keeping context visible', () => {
    expect(loadActivityStepLabels()).toBe(false)
    const html = renderToStaticMarkup(<MessageActivity messageId='m1' blocks={blocks} />)
    expect(html).not.toContain('After step')
    expect(html).toContain('Path rule matched')
    expect(html).toContain('Skill loaded')
  })
  it('persists opt-in and opt-out', () => {
    saveActivityStepLabels(true)
    expect(localStorage.getItem(ACTIVITY_STEP_LABELS_KEY)).toBe('true')
    expect(loadActivityStepLabels()).toBe(true)
    saveActivityStepLabels(false)
    expect(loadActivityStepLabels()).toBe(false)
  })
  it('shows rules and skills once, correlated to real tool steps across messages', () => {
    saveActivityStepLabels(true)
    const html = renderToStaticMarkup(<MessageActivity messageId='m1' blocks={blocks} toolOffset={3} customThemeEnabled={false} />)
    expect(html).toContain('After step 4')
    expect(html).toContain('After step 5')
    expect(html.match(/data-testid="context-injection-card"/g)).toHaveLength(2)
    expect(html).toContain('Path rule matched')
    expect(html).toContain('Skill loaded')
    expect(html).not.toContain('Hidden body')
    expect(html).not.toContain('Hidden skill')
  })
  it('does not invent a step for uncorrelated context or hooks', () => {
    saveActivityStepLabels(true)
    const html = renderToStaticMarkup(<MessageActivity messageId='m1' blocks={[{ ...blocks[1], tool_use_id: undefined } as ContentBlock]}
      hooks={[{ id: 'h1', event: 'PreToolUse', status: 'failed' } as HookRunRecord]} />)
    expect(html).not.toContain('After step')
    expect(html).toContain('1 failed')
    expect(html).toContain('data-testid="hook-activity-card"')
  })
})
