import React, { useId, useState } from 'react'
import { Code2, FileJson, Server } from 'lucide-react'
import type { ToolDefinition } from '../../features/chats/toolDefinitions'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'
import { useSettingsSectionThemeColors } from './settingsSectionTheme'
import './toolsSettings.css'

type SchemaProperty = {
  type?: string | string[]
  description?: string
  enum?: unknown[]
  default?: unknown
  items?: { type?: string | string[] }
  anyOf?: SchemaProperty[]
  oneOf?: SchemaProperty[]
  $ref?: string
}

function propertyType(property: SchemaProperty): string {
  if (Array.isArray(property.type)) return property.type.join(' | ')
  if (property.type === 'array' && property.items?.type) return `${property.items.type}[]`
  if (property.type) return property.type
  const variants = property.anyOf || property.oneOf
  if (variants) return variants.map(propertyType).join(' | ')
  return property.$ref ? 'reference' : 'value'
}

export function ToolSettingsRow({ tool, updating, onToggle }: {
  tool: ToolDefinition
  updating: boolean
  onToggle: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const colors = useSettingsSectionThemeColors()
  const { theme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const name = (tool.mcpToolName || tool.name).replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
  const switchName = tool.isMcp && tool.mcpServerName ? `${name} (${tool.mcpServerName})` : name
  const Icon = tool.isMcp ? Server : tool.isCustom ? Code2 : FileJson
  const properties = Object.entries(tool.inputSchema.properties || {}) as [string, SchemaProperty][]
  const required = new Set(tool.inputSchema.required || [])
  const style = colors ? {
    '--tool-row-bg': colors.innerCardBg,
    '--tool-row-text': colors.titleText,
    '--tool-row-muted': colors.bodyText,
    '--tool-row-code-bg': colors.codeBg,
    '--tool-row-code-text': colors.codeText,
    '--tool-row-icon-bg': colors.buttonBg,
    '--tool-row-switch-off': `color-mix(in srgb, ${colors.bodyText} 30%, ${colors.innerCardBg})`,
    '--tool-row-thumb': colors.buttonText,
    '--tool-row-thumb-on': colors.buttonBg,
    ...(customThemeEnabled ? {
      '--tool-row-accent': getThemeModeColor(theme.colors.composerToggleActiveText, isDarkMode),
    } : {}),
  } as React.CSSProperties : undefined

  return (
    <div className='tools-settings-row t-acc' data-open={expanded} style={style}>
      <div className='tools-settings-row-head'>
        <button
          type='button'
          className='tools-settings-disclosure'
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(value => !value)}
        >
          <span className='tools-settings-icon' aria-hidden='true'><Icon size={18} strokeWidth={2.25} /></span>
          <span className='tools-settings-identity'>
            <span className='tools-settings-name' title={tool.mcpToolName || tool.name}>{name}</span>
            {!expanded && <span className='tools-settings-description'>{tool.description}</span>}
          </span>
          {tool.isMcp && tool.mcpServerName && <span className='tools-settings-server'>{tool.mcpServerName}</span>}
          <span className='t-acc-chevron' aria-hidden='true'>
            <svg width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='currentColor' strokeWidth='2.25' strokeLinecap='round' strokeLinejoin='round'>
              <path d='M4 6.5L8 10.5L12 6.5' />
            </svg>
          </span>
        </button>
        <button
          type='button'
          className='tools-settings-switch'
          role='switch'
          aria-label={`Enable ${switchName}`}
          aria-checked={tool.enabled}
          aria-busy={updating}
          disabled={updating}
          title={updating ? 'Updating…' : `${tool.enabled ? 'Disable' : 'Enable'} ${switchName}`}
          onClick={onToggle}
        >
          <span className='tools-settings-switch-track' aria-hidden='true'><span /></span>
        </button>
      </div>
      <div className='t-acc-panel' id={id} aria-hidden={!expanded} inert={!expanded}>
        <div className='t-acc-panel-inner'>
          <div className='tools-settings-schema'>
            {expanded && tool.description && <p className='tools-settings-full-description' tabIndex={0}>{tool.description}</p>}
            <dl className='tools-settings-fields'>
              {properties.map(([key, property]) => (
                <div key={key} className='tools-settings-field'>
                  <dt>
                    <code>{key}</code>
                    {required.has(key) && <span className='tools-settings-required'>required</span>}
                    <span className='tools-settings-type'>{propertyType(property)}</span>
                  </dt>
                  <dd>
                    {property.description && <p>{property.description}</p>}
                    {(property.enum || property.default !== undefined) && (
                      <p className='tools-settings-constraints'>
                        {property.enum && <>Options: {property.enum.map(value => JSON.stringify(value)).join(', ')}</>}
                        {property.enum && property.default !== undefined && ' · '}
                        {property.default !== undefined && <>Default: {JSON.stringify(property.default)}</>}
                      </p>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {properties.length === 0 && <p className='tools-settings-no-fields'>No parameters.</p>}
            <details className='tools-settings-json'>
              <summary>Full schema</summary>
              <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  )
}
