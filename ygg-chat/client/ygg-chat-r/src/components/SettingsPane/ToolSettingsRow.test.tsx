import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '../../features/chats/toolDefinitions'

const mocks = vi.hoisted(() => ({ expanded: false, customTheme: false }))
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react')
  return { ...actual, useState: () => [mocks.expanded, vi.fn()] }
})
vi.mock('./settingsSectionTheme', () => ({
  useSettingsSectionThemeColors: () => mocks.customTheme ? {
    innerCardBg: '#111111', titleText: '#eeeeee', bodyText: '#aaaaaa',
    codeBg: '#222222', codeText: '#dddddd', buttonBg: '#333333', buttonText: '#ffffff',
  } : null,
}))
vi.mock('../ThemeManager/themeConfig', () => ({
  useCustomChatTheme: () => ({ enabled: mocks.customTheme, theme: { colors: { composerToggleActiveText: '#ff9900' } } }),
  useHtmlDarkMode: () => false,
  getThemeModeColor: (color: string) => color,
}))

import { ToolSettingsRow } from './ToolSettingsRow'

const tool: ToolDefinition = {
  name: 'read_file', description: 'Read text from a file.', enabled: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Source file path.' },
      mode: { type: 'string', enum: ['text', 'lines'], default: 'text' },
      ranges: { type: 'array', items: { type: 'object', properties: { start: { type: 'integer' } } } },
      value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['path'],
  },
}
const render = (overrides: Partial<ToolDefinition> = {}, updating = false) =>
  renderToStaticMarkup(<ToolSettingsRow tool={{ ...tool, ...overrides }} updating={updating} onToggle={vi.fn()} />)

afterEach(() => { mocks.expanded = false; mocks.customTheme = false })

describe('Compact tool row', () => {
  it('shows one identity and description without repeated source metadata', () => {
    mocks.expanded = true
    const html = render()
    expect(html.match(/>Read File</g)).toHaveLength(1)
    expect(html.match(/>Read text from a file\.</g)).toHaveLength(1)
    expect(html).not.toContain('>read_file<')
    expect(html).not.toContain('Built-in')
    expect(html).not.toContain('Native tools')
    expect(html).toContain('data-open="true"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-hidden="false"')
    expect(html).not.toContain('inert=""')
  })

  it('links an initially collapsed, inert schema to a separate enable switch', () => {
    const html = render({ enabled: false }, true)
    const id = html.match(/aria-controls="([^"]+)"/)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`id="${id}" aria-hidden="true" inert=""`)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('role="switch" aria-label="Enable Read File" aria-checked="false" aria-busy="true" disabled=""')
    expect(html).toContain('tools-settings-row-head')
  })

  it('renders types, required fields, defaults, enums, and complete nested JSON', () => {
    mocks.expanded = true
    const html = render()
    expect(html).toContain('>path</code>')
    expect(html).toContain('>required</span>')
    expect(html).toContain('Source file path.')
    expect(html).toContain('object[]')
    expect(html).toContain('string | null')
    expect(html).toContain('Default: &quot;text&quot;')
    expect(html).toContain('Options: &quot;text&quot;, &quot;lines&quot;')
    expect(html).toContain('<summary>Full schema</summary>')
    expect(html).toContain('&quot;start&quot;')
  })

  it('uses real custom and MCP definitions with server identity only for MCP', () => {
    expect(render({ name: 'custom_lookup', isCustom: true })).toContain('>Custom Lookup<')
    const html = render({ name: 'mcp__docs__lookup', isMcp: true, isCustom: true, mcpToolName: 'lookup', mcpServerName: 'docs' })
    expect(html).toContain('>Lookup<')
    expect(html.match(/>docs</g)).toHaveLength(1)
    expect(html).toContain('aria-label="Enable Lookup (docs)"')
    expect(html).not.toContain('>mcp__docs__lookup<')
    expect(html).toContain('>path</code>')
  })

  it('handles no-argument tools and themes surface, track, and thumb colors', () => {
    mocks.customTheme = true
    const html = render({ inputSchema: { type: 'object', properties: {} } })
    expect(html).toContain('No parameters.')
    expect(html).toContain('--tool-row-bg:#111111')
    expect(html).toContain('--tool-row-accent:#ff9900')
    expect(html).toContain('--tool-row-switch-off:color-mix')
    expect(html).toContain('--tool-row-thumb:#ffffff')
    expect(html).toContain('--tool-row-thumb-on:#333333')
  })
})
