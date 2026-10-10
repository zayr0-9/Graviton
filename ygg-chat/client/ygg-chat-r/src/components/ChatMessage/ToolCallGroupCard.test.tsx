import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallGroupCard, type ToolCallGroupCardProps } from './ToolCallGroupCard'
import { TOOL_NAME_BASE_CLASS } from './chatMessageShared'

vi.mock('../EditFileDiffView/EditToolDiffView', () => ({
  EditToolDiffView: () => <div data-test-diff-view />,
}))
vi.mock('../PlanMdToolView', () => ({
  PlanMdToolView: ({ readOnly }: { readOnly?: boolean }) => <div data-test-plan-view data-read-only={readOnly} />,
}))
vi.mock('../McpAppIframe/McpAppIframe', () => ({ McpAppIframe: () => <div data-test-mcp-app /> }))
vi.mock('../SubagentTranscript/SubagentTranscript', () => ({
  SubagentToolName: ({ name, fallbackClass }: { name: string; fallbackClass: string }) => (
    <span className={fallbackClass}>{name}</span>
  ),
}))
vi.mock('./HtmlIframe', () => ({
  HtmlIframe: ({ html }: { html: string }) => <div data-test-html-preview>{html}</div>,
}))

const renderCard = (
  results: ToolCallGroupCardProps['group']['results'],
  name = 'read_file',
  args: ToolCallGroupCardProps['group']['args'] = { path: 'file.txt' },
  overrides: Partial<ToolCallGroupCardProps> = {},
) => {
  const props: ToolCallGroupCardProps = {
    group: { id: 'call-1', name, args, results, anchorIndex: 0 },
    toggleKey: 'call-1', messageId: 'message-1', expanded: true, onToggle: vi.fn(),
    truncateToolOutput: true, toolDefinitions: [], mcpLoadState: {}, mcpReloadTokens: {},
    onLoadMcpApp: vi.fn(), canOpenViewer: false, onOpenHtmlViewer: vi.fn(),
    onOpenMcpViewer: vi.fn(), onNavigate: vi.fn(),
  }
  return renderToStaticMarkup(<ToolCallGroupCard {...props} {...overrides} />)
}

describe('incomplete tool result presentation', () => {
  it('shows the placeholder as amber and in progress without changing the result', () => {
    const result = Object.freeze({ content: 'Tool execution did not complete.', is_error: true })
    const html = renderCard([result])
    expect(html).toContain('text-amber-700')
    expect(html).toContain('in progress')
    expect(html).toContain(result.content)
    expect(html).not.toContain('text-red-600')
    expect(html).not.toContain('failed')
    expect(result.is_error).toBe(true)
  })

  it('preserves tool-name sizing for a subagent_manager wait placeholder', () => {
    const html = renderCard(
      [{ content: 'Tool execution did not complete.', is_error: true }],
      'subagent_manager',
      { action: 'wait', handle: '660314' },
    )
    expect(html).toContain(`class="${TOOL_NAME_BASE_CLASS} text-amber-700 dark:text-amber-400">subagent_manager</span>`)
    expect(html).toContain('in progress')
    expect(html).toContain('Tool execution did not complete.')
    expect(html).not.toContain('text-red-600')
  })

  it('keeps actual failures red', () => {
    const html = renderCard([{ content: 'Permission denied.', is_error: true }])
    expect(html).toContain('text-red-600')
    expect(html).toContain('failed')
    expect(html).not.toContain('in progress')
  })

  it('keeps successful results successful', () => {
    const html = renderCard([{ content: 'Done.', is_error: false }])
    expect(html).not.toContain('text-red-600')
    expect(html).not.toContain('in progress')
    expect(html).toContain('ok')
  })

  it.each(['edit_file', 'internalLink', 'html_renderer', 'plan_md'])(
    'uses amber for incomplete %s calls', name => {
      expect(renderCard([{ content: 'Tool execution did not complete.', is_error: true }], name))
        .toContain('text-amber-700')
    }
  )

  it('does not hide a real failure alongside a placeholder', () => {
    const html = renderCard([
      { content: 'Tool execution did not complete.', is_error: true },
      { content: 'Permission denied.', is_error: true },
    ])
    expect(html).toContain('text-red-600')
    expect(html).toContain('failed')
  })
})

describe('read-only run preview tools', () => {
  it('uses the existing plan viewer with read-only capabilities', () => {
    const html = renderCard([{ content: { name: 'design', content: '# Plan' }, is_error: false }],
      'plan_md', { action: 'display', name: 'design' }, { readOnly: true })
    expect(html).toContain('data-test-plan-view')
    expect(html).toContain('data-read-only="true"')
  })
  it.each(['edit_file', 'multi_edit'])('reuses %s diff presentation', name => {
    expect(renderCard([{ content: { success: true } }], name, { path: 'file.ts' }, { readOnly: true }))
      .toContain('data-test-diff-view')
  })
  it('shares structured batch rendering without transcript actions', () => {
    const args = { calls: [{ tool: 'subagent', args: { prompt: 'inspect' } }, { tool: 'read_file', args: { path: 'missing' } }] }
    const results = [{ content: { results: [
      { tool: 'subagent', ok: true, data: { result: 'done' } },
      { tool: 'read_file', ok: false, error: 'File missing' },
    ] } }]
    const html = renderCard(results, 'multi_call', args, { readOnly: true })
    expect(html).toContain('2 calls')
    expect(html).toContain('2 results')
    expect(html).toContain('failed')
    expect(html).toContain('File missing')
    expect(html).not.toContain('View subagent transcript')
  })
  it('preserves normal chat presentation for generic results', () => {
    const results = [{ content: { success: false, error: 'File missing' }, is_error: true }]
    expect(renderCard(results, 'read_file', { path: 'missing' }, { readOnly: true }))
      .toBe(renderCard(results, 'read_file', { path: 'missing' }))
  })
  it('keeps resolved internal links and generic HTML outputs inert', () => {
    const link = renderCard([{ content: { success: true, label: 'Go to chat', target: { route: '/chat/project/conversation' } } }],
      'internalLink', {}, { readOnly: true })
    expect(link).not.toContain('Navigate to')
    const html = renderCard([{ content: { html: '<h1>Result</h1>' } }], 'custom_tool', {}, { readOnly: true })
    expect(html).not.toContain('data-test-html-preview')
    expect(html).not.toContain('Open tool output viewer')
    expect(html).toContain('&lt;h1&gt;Result&lt;/h1&gt;')
    expect(renderCard([{ content: 'done' }], 'subagent', {}, { readOnly: true }))
      .not.toContain('View subagent transcript')
  })
  it('does not mount MCP apps even with a UI definition', () => {
    const html = renderCard([{ content: { html: '<script>danger()</script>' } }], 'mcp__demo__run', {}, {
      readOnly: true,
      toolDefinitions: [{ name: 'mcp__demo__run', isMcp: true, mcpServerName: 'demo', mcpUi: { resourceUri: 'ui://demo' } }] as ToolCallGroupCardProps['toolDefinitions'],
    })
    expect(html).not.toContain('Load app')
    expect(html).not.toContain('Fullscreen')
    expect(html).not.toContain('data-test-html-preview')
    expect(html).not.toContain('data-test-mcp-app')
  })
  it.each(['html_renderer', 'mcp__demo__run', 'internalLink'])(
    'shows inert data instead of interactive %s surfaces', name => {
      const html = renderCard([{ content: 'saved result', is_error: false }], name,
        { action: 'display', html: '<script>danger()</script>' }, { readOnly: true })
      expect(html).toContain('saved result')
      expect(html).toContain('&lt;script&gt;')
      expect(html).not.toContain('<iframe')
      expect(html).not.toContain('data-test-html-preview')
      expect(html).not.toContain('Open tool output viewer')
      expect(html).not.toContain('Load app')
      expect(html).not.toContain('Fullscreen')
    }
  )
  it('does not construct collapsed result subtrees', () => {
    const html = renderCard([{ content: 'private result body', is_error: false }], 'bash', {},
      { readOnly: true, expanded: false })
    expect(html).not.toContain('private result body')
  })
})

describe('file-backed HTML renderer', () => {
  it('renders returned file HTML even when the tool card is collapsed', () => {
    const markup = renderCard([{ content: { success: true, html: '<h1>From disk</h1>' } }],
      'html_renderer', { path: '/outside/workspace/page.html' }, { expanded: false, canOpenViewer: true })
    expect(markup).toContain('data-test-html-preview')
    expect(markup).toContain('&lt;h1&gt;From disk&lt;/h1&gt;')
    expect(markup).toContain('Open tool output viewer')
  })

  it('does not render an HTML artifact when a file read fails', () => {
    const markup = renderCard([{ content: { success: false, error: 'Unable to read HTML file' }, is_error: true }],
      'html_renderer', { path: '/missing.html' })
    expect(markup).not.toContain('data-test-html-preview')
    expect(markup).toContain('Unable to read HTML file')
  })

  it('keeps file-backed HTML inert in read-only run previews', () => {
    const markup = renderCard([{ content: { success: true, html: '<h1>From disk</h1>' } }],
      'html_renderer', { path: '/page.html' }, { readOnly: true })
    expect(markup).not.toContain('data-test-html-preview')
  })
})

describe('manager-invoked MCP app', () => {
  it('renders from persisted discovery metadata without injecting schemas into the registry', () => {
    const html = renderCard([{ content: {
      content: [{ type: 'text', text: 'done' }],
      mcpToolDefinition: { name: 'echo', qualifiedName: 'mcp__demo_server__echo', serverName: 'demo_server',
        inputSchema: { type: 'object', properties: {} }, _meta: { ui: { resourceUri: 'ui://echo' } } },
    }, is_error: false }], 'mcp_manager', { action: 'invoke', name: 'demo_server', tool: 'echo', args: { text: 'x' } })
    expect(html).toContain('data-test-mcp-app')
    expect(html).toContain('MCP App')
  })
})
