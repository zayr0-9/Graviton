import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../../features/chats/toolDefinitions'

const mocks = vi.hoisted(() => ({ tools: [] as ToolDefinition[] }))
vi.mock('../../features/chats/chatActions', () => ({
  fetchCustomTools: vi.fn(), fetchTools: vi.fn(), updateToolEnabled: vi.fn(),
}))
vi.mock('../../features/chats/chatSelectors', () => ({ selectTools: vi.fn() }))
vi.mock('../../features/chats/toolDefinitions', () => ({ getAllTools: () => mocks.tools }))
vi.mock('../../hooks/redux', () => ({ useAppDispatch: () => vi.fn(), useAppSelector: vi.fn() }))
vi.mock('../../utils/api', () => ({ localApi: {} }))
vi.mock('./settingsSectionTheme', () => ({ useSettingsSectionThemeColors: () => null }))

import { ToolsSettings } from './ToolsSettings'

const tool = (name: string, metadata: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name, enabled: true, description: `${name} description`,
  inputSchema: { type: 'object', properties: {} }, ...metadata,
})

const section = (html: string, label: string) =>
  html.match(new RegExp(`<section[^>]*aria-label="${label}"[^>]*>(.*?)</section>`))?.[1] || ''

describe('ToolsSettings source groups', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_ENVIRONMENT', 'electron')
    vi.stubGlobal('localStorage', { getItem: () => null })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('separates built-in, custom and MCP tools, prioritizing MCP metadata', () => {
    mocks.tools = [
      tool('read_file'), tool('my_app', { isCustom: true }),
      tool('mcp__example__lookup', {
        isMcp: true, isCustom: true, mcpServerName: 'example', mcpToolName: 'lookup',
      }),
    ]
    const html = renderToStaticMarkup(<ToolsSettings />)
    expect(section(html, 'Built-in Tools')).toContain('Read File')
    expect(section(html, 'Built-in Tools')).not.toContain('Lookup')
    expect(section(html, 'Custom Tools')).toContain('My App')
    expect(section(html, 'Custom Tools')).not.toContain('Lookup')
    expect(section(html, 'MCP Tools')).toContain('Lookup')
    expect(section(html, 'MCP Tools')).toContain('example')
    expect(section(html, 'MCP Tools')).not.toContain('Read File')
    expect(html).toContain('MCP Tools (1)')
    for (const label of ['Built-in Tools', 'Custom Tools', 'MCP Tools']) {
      const groupHtml = section(html, label)
      expect(groupHtml).toContain('type="button" aria-expanded="true"')
      const panelId = groupHtml.match(/aria-controls="([^"]+)"/)?.[1]
      expect(panelId).toBeTruthy()
      expect(groupHtml).toContain(`id="${panelId}" aria-hidden="false"`)
      expect(groupHtml).toContain('transition-[grid-template-rows,opacity] duration-300 ease-in-out motion-reduce:transition-none')
    }
  })

  it('keeps all-disabled tools visible and omits empty groups', () => {
    mocks.tools = [tool('read_file', { enabled: false })]
    const html = renderToStaticMarkup(<ToolsSettings />)
    expect(section(html, 'Built-in Tools')).toContain('Read File')
    expect(html).not.toContain('max-h-0')
    expect(html).not.toContain('aria-label="MCP Tools"')
    expect(html).not.toContain('aria-label="Custom Tools"')
  })
})
