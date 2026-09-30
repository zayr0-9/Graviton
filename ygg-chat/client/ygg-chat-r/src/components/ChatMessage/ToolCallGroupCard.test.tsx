import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallGroupCard, type ToolCallGroupCardProps } from './ToolCallGroupCard'

vi.mock('../EditFileDiffView/EditToolDiffView', () => ({ EditToolDiffView: () => null }))
vi.mock('../PlanMdToolView', () => ({ PlanMdToolView: () => null }))
vi.mock('../McpAppIframe/McpAppIframe', () => ({ McpAppIframe: () => null }))
vi.mock('../SubagentTranscript/SubagentTranscript', () => ({ SubagentToolName: () => null }))
vi.mock('./HtmlIframe', () => ({ HtmlIframe: () => null }))

const renderCard = (results: ToolCallGroupCardProps['group']['results'], name = 'read_file') => {
  const props: ToolCallGroupCardProps = {
    group: { id: 'call-1', name, args: { path: 'file.txt' }, results, anchorIndex: 0 },
    toggleKey: 'call-1', messageId: 'message-1', expanded: true, onToggle: vi.fn(),
    truncateToolOutput: true, toolDefinitions: [], mcpLoadState: {}, mcpReloadTokens: {},
    onLoadMcpApp: vi.fn(), canOpenViewer: false, onOpenHtmlViewer: vi.fn(),
    onOpenMcpViewer: vi.fn(), onNavigate: vi.fn(),
  }
  return renderToStaticMarkup(<ToolCallGroupCard {...props} />)
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
