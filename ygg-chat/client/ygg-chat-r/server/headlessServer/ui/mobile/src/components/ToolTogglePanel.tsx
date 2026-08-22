import React, { useState } from 'react'
import { Badge, Button } from './ui'
import type { MobileCustomTool } from '../types'

interface ToolTogglePanelProps {
  tools: MobileCustomTool[]
  busyToolNames: string[]
  loading: boolean
  disabled: boolean
  onRefresh: () => void
  onToggleTool: (toolName: string, enabled: boolean) => void
}

export const ToolTogglePanel: React.FC<ToolTogglePanelProps> = ({
  tools,
  busyToolNames,
  loading,
  disabled,
  onRefresh,
  onToggleTool,
}) => {
  const busy = new Set(busyToolNames)
  const [isOpen, setIsOpen] = useState(false)

  return (
    <section className='mobile-tool-panel'>
      <details
        className='mobile-tool-panel-details'
        open={isOpen}
        onToggle={event => setIsOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className='mobile-tool-panel-header'>
          <h2>Custom tools</h2>
          <span className='mobile-tool-panel-chevron' aria-hidden='true'>
            {isOpen ? '▾' : '▸'}
          </span>
        </summary>

        <div className='mobile-tool-panel-body'>
          <div className='mobile-tool-panel-actions'>
            <Button onClick={onRefresh} disabled={disabled || loading} variant='outline' size='sm'>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          {tools.length === 0 ? (
            <p className='mobile-tree-muted'>No custom tools found.</p>
          ) : (
            <div className='mobile-tool-toggle-list'>
              {tools.map(tool => {
                const toggling = busy.has(tool.name)
                return (
                  <div key={tool.name} className='mobile-tool-toggle-row'>
                    <div>
                      <strong>{tool.name}</strong>
                      <div className='mobile-tool-toggle-meta'>
                        <Badge variant={tool.enabled ? 'success' : 'outline'}>{tool.enabled ? 'Enabled' : 'Disabled'}</Badge>
                        <Badge variant={tool.loaded ? 'default' : 'outline'}>{tool.loaded ? 'Loaded' : 'Not loaded'}</Badge>
                      </div>
                      {tool.description ? <p>{tool.description}</p> : null}
                    </div>

                    <Button
                      onClick={() => onToggleTool(tool.name, !tool.enabled)}
                      disabled={disabled || toggling || loading}
                      variant={tool.enabled ? 'secondary' : 'default'}
                      size='sm'
                    >
                      {toggling ? 'Saving…' : tool.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </details>
    </section>
  )
}
