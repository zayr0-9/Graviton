import React, { useCallback, useMemo, useRef, useState } from 'react'
import {
  type ChatThemeRoleKey,
  type CustomChatTheme,
  createDefaultCustomChatTheme,
  type HeimdallNodeThemeKey,
  sanitizeCustomTheme,
  saveCustomChatTheme,
  setCustomChatThemeEnabled,
  useCustomChatTheme,
} from './themeConfig'

const ROLE_LABELS: Record<ChatThemeRoleKey, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  ex_agent: 'Claude Code',
  unknown: 'Unknown',
}

const NODE_LABELS: Record<HeimdallNodeThemeKey, string> = {
  user: 'User nodes',
  assistant: 'Assistant nodes',
  ex_agent: 'Claude Code nodes',
}

const ROLE_KEYS: ChatThemeRoleKey[] = ['user', 'assistant', 'system', 'ex_agent', 'unknown']
const NODE_KEYS: HeimdallNodeThemeKey[] = ['user', 'assistant', 'ex_agent']

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

type RgbaColor = {
  r: number
  g: number
  b: number
  a: number
}

const toHex2 = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')

const rgbToHex = (r: number, g: number, b: number) => `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`

const parseHexColor = (value: string): RgbaColor | null => {
  const hex = value.trim().replace('#', '')

  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: 1,
    }
  }

  if (hex.length === 4) {
    return {
      r: parseInt(hex[0] + hex[0], 16),
      g: parseInt(hex[1] + hex[1], 16),
      b: parseInt(hex[2] + hex[2], 16),
      a: clamp(parseInt(hex[3] + hex[3], 16) / 255, 0, 1),
    }
  }

  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    }
  }

  if (hex.length === 8) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: clamp(parseInt(hex.slice(6, 8), 16) / 255, 0, 1),
    }
  }

  return null
}

const parseRgbFunctionColor = (value: string): RgbaColor | null => {
  const match = value
    .trim()
    .match(
      /^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d*(?:\.\d+)?))?\s*\)$/i
    )

  if (!match) return null

  const r = clamp(Number(match[1]), 0, 255)
  const g = clamp(Number(match[2]), 0, 255)
  const b = clamp(Number(match[3]), 0, 255)
  const a = clamp(match[4] == null || match[4] === '' ? 1 : Number(match[4]), 0, 1)

  if ([r, g, b, a].some(num => Number.isNaN(num))) {
    return null
  }

  return { r, g, b, a }
}

const parseColorValue = (value: string): RgbaColor | null => {
  const trimmed = value.trim().toLowerCase()

  if (!trimmed) return null
  if (trimmed === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 }
  }

  if (trimmed.startsWith('#')) {
    return parseHexColor(trimmed)
  }

  if (trimmed.startsWith('rgb')) {
    return parseRgbFunctionColor(trimmed)
  }

  return null
}

const toCssRgba = ({ r, g, b, a }: RgbaColor) => {
  const alpha = Math.round(clamp(a, 0, 1) * 100) / 100
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`
}

type ModeColorInputProps = {
  modeLabel: string
  value: string
  onChange: (nextValue: string) => void
}

const ModeColorInput: React.FC<ModeColorInputProps> = ({ modeLabel, value, onChange }) => {
  const parsed = parseColorValue(value) ?? { r: 0, g: 0, b: 0, a: 1 }
  const pickerValue = rgbToHex(parsed.r, parsed.g, parsed.b)
  const alphaPercent = Math.round(parsed.a * 100)

  return (
    <div className='space-y-2'>
      <span className='text-[11px] uppercase tracking-[0.09em] text-neutral-500 dark:text-neutral-400'>
        {modeLabel}
      </span>

      <div className='flex items-center gap-2'>
        <div
          className='h-8 w-8 rounded border border-neutral-300 dark:border-neutral-600'
          style={{
            backgroundImage:
              'linear-gradient(45deg, rgba(0,0,0,0.08) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.08) 75%, rgba(0,0,0,0.08)), linear-gradient(45deg, rgba(0,0,0,0.08) 25%, transparent 25%, transparent 75%, rgba(0,0,0,0.08) 75%, rgba(0,0,0,0.08))',
            backgroundPosition: '0 0, 6px 6px',
            backgroundSize: '12px 12px',
          }}
        >
          <div className='h-full w-full rounded' style={{ backgroundColor: toCssRgba(parsed) }} />
        </div>
        <input
          type='color'
          value={pickerValue}
          onChange={e => {
            const rgb = parseHexColor(e.target.value)
            if (!rgb) return
            onChange(toCssRgba({ ...rgb, a: parsed.a }))
          }}
          className='h-8 w-10 cursor-pointer rounded border border-neutral-300 dark:border-neutral-600 bg-transparent'
          title={`${modeLabel} color`}
        />
        <input
          type='text'
          value={value}
          onChange={e => onChange(e.target.value)}
          className='flex-1 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-2 py-1 text-xs font-mono text-neutral-700 dark:text-neutral-200'
        />
      </div>

      <div className='flex items-center gap-2'>
        <span className='text-[11px] text-neutral-500 dark:text-neutral-400 w-10'>Alpha</span>
        <input
          type='range'
          min={0}
          max={100}
          step={1}
          value={alphaPercent}
          onChange={e => {
            const nextAlpha = clamp(Number(e.target.value), 0, 100) / 100
            onChange(toCssRgba({ ...parsed, a: nextAlpha }))
          }}
          className='flex-1 h-2 bg-neutral-200 dark:bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500'
        />
        <span className='text-[11px] font-mono text-neutral-500 dark:text-neutral-400 w-9 text-right'>
          {alphaPercent}%
        </span>
      </div>
    </div>
  )
}

type PairEditorProps = {
  label: string
  value: { light: string; dark: string }
  onChange: (mode: 'light' | 'dark', nextValue: string) => void
}

const PairEditor: React.FC<PairEditorProps> = ({ label, value, onChange }) => {
  return (
    <div className='rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 space-y-2'>
      <p className='text-sm font-medium text-neutral-700 dark:text-neutral-200'>{label}</p>
      <div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
        <ModeColorInput modeLabel='Light' value={value.light} onChange={next => onChange('light', next)} />
        <ModeColorInput modeLabel='Dark' value={value.dark} onChange={next => onChange('dark', next)} />
      </div>
    </div>
  )
}

export const ThemeManager: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(false)
  const [status, setStatusState] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const { theme, enabled } = useCustomChatTheme()

  const setStatus = useCallback((text: string, tone: 'success' | 'error' = 'success') => {
    setStatusState({ text, tone })
    window.setTimeout(() => {
      setStatusState(prev => (prev?.text === text ? null : prev))
    }, 2500)
  }, [])

  const updateTheme = useCallback(
    (updater: (current: CustomChatTheme) => CustomChatTheme) => {
      const nextTheme = updater(theme)
      saveCustomChatTheme(nextTheme)
      // UX: as soon as a user edits theme values, immediately enable custom theme.
      if (!enabled) {
        setCustomChatThemeEnabled(true)
      }
    },
    [enabled, theme]
  )

  const handleThemeNameChange = useCallback(
    (nextName: string) => {
      updateTheme(current => ({
        ...current,
        name: nextName,
      }))
    },
    [updateTheme]
  )

  const handleCombinedChatSurfaceChange = useCallback(
    (mode: 'light' | 'dark', nextValue: string) => {
      updateTheme(current => ({
        ...current,
        colors: {
          ...current.colors,
          chatPanelBg: {
            ...current.colors.chatPanelBg,
            [mode]: nextValue,
          },
          chatMessageListBg: {
            ...current.colors.chatMessageListBg,
            [mode]: nextValue,
          },
        },
      }))
    },
    [updateTheme]
  )

  const handleChatSurfaceChange = useCallback(
    (
      key:
        | 'heimdallPanelBg'
        | 'conversationToolbarBg'
        | 'settingsSolidColorSectionBg'
        | 'appBackgroundColor'
        | 'settingsPaneBodyBg'
        | 'settingsCustomThemesCardBg'
        | 'settingsCustomThemesCardBorder'
        | 'settingsCustomThemesAccentBg'
        | 'settingsCustomThemesAccentText'
        | 'settingsCustomThemesTitleText'
        | 'settingsCustomThemesBodyText'
        | 'settingsCustomThemesCodeBg'
        | 'settingsCustomThemesCodeText'
        | 'settingsCustomThemesPanelBorder'
        | 'settingsCustomThemesInnerCardBg'
        | 'settingsCustomThemesInnerCardBorder'
        | 'settingsCustomThemesBadgeBg'
        | 'settingsCustomThemesBadgeText'
        | 'settingsCustomThemesButtonBg'
        | 'settingsCustomThemesButtonBorder'
        | 'settingsCustomThemesButtonText'
        | 'settingsCustomThemesEmptyStateBg'
        | 'settingsCustomThemesEmptyStateBorder'
        | 'settingsCustomThemesListBg'
        | 'settingsCustomThemesListBorder'
        | 'settingsCustomThemesListItemTitleText'
        | 'settingsCustomThemesListItemMetaText'
        | 'settingsCustomThemesPrimaryButtonBg'
        | 'settingsCustomThemesPrimaryButtonText'
        | 'chatInputAreaBorder'
        | 'chatProgressBarFill'
        | 'actionPopoverBorder'
        | 'sendButtonAnimationColor'
        | 'streamingAnimationColor'
        | 'composerToggleActiveBg'
        | 'composerToggleActiveBorder'
        | 'composerToggleActiveText'
        | 'heimdallNotePillBg'
        | 'heimdallNotePillText'
        | 'heimdallNotePillBorder'
        | 'heimdallNodeHoverModalBg'
        | 'heimdallNodeHoverModalBorder'
        | 'heimdallNodeHoverModalText'
        | 'heimdallNodeHoverModalTitleText'
        | 'heimdallNoteDialogBg'
        | 'heimdallNoteDialogBorder'
        | 'heimdallNoteDialogTitleText'
        | 'heimdallNoteDialogButtonBg'
        | 'heimdallNoteDialogButtonBorder'
        | 'heimdallNoteDialogButtonText'
        | 'heimdallNoteDialogCloseButtonText'
        | 'ideContextPillBg'
        | 'ideContextPillBorder'
        | 'ideContextPillText'
        | 'ideContextAddButtonBg'
        | 'ideContextAddButtonBorder'
        | 'ideContextAddButtonText'
        | 'ideContextPreviewBg'
        | 'ideContextPreviewBorder'
        | 'ideContextPreviewFileText'
        | 'ideContextPreviewCodeText'
        | 'ideContextSelectedPillBg'
        | 'ideContextSelectedPillBorder'
        | 'ideContextSelectedPillText'
        | 'ideContextClearButtonBorder'
        | 'ideContextClearButtonText'
        | 'ideContextAddedText'
        | 'toolJobsModalBackdrop'
        | 'toolJobsModalBg'
        | 'toolJobsModalBorder'
        | 'toolJobsPanelBg'
        | 'toolJobsPanelBorder'
        | 'toolJobsPrimaryText'
        | 'toolJobsSecondaryText'
        | 'toolJobsMutedText'
        | 'toolJobsCodeBg'
        | 'toolJobsCodeText'
        | 'toolJobsErrorBg'
        | 'toolJobsErrorBorder'
        | 'toolJobsErrorText'
        | 'toolJobsLiveBadgeBg'
        | 'toolJobsLiveBadgeText'
        | 'toolJobsLiveDot'
        | 'toolJobsProgressTrack'
        | 'toolJobsProgressPending'
        | 'toolJobsProgressRunning'
        | 'toolJobsProgressCompleted'
        | 'toolJobsProgressFailed'
        | 'toolJobsStatusPendingBg'
        | 'toolJobsStatusPendingText'
        | 'toolJobsStatusRunningBg'
        | 'toolJobsStatusRunningText'
        | 'toolJobsStatusCompletedBg'
        | 'toolJobsStatusCompletedText'
        | 'toolJobsStatusFailedBg'
        | 'toolJobsStatusFailedText'
        | 'toolJobsStatusCancelledBg'
        | 'toolJobsStatusCancelledText'
        | 'toolJobsStatusActiveWorkersBg'
        | 'toolJobsStatusActiveWorkersText'
        | 'toolPermissionDialogBg'
        | 'toolPermissionDialogBorder'
        | 'toolPermissionDialogTitleText'
        | 'toolPermissionDialogToolNameText'
        | 'toolPermissionDialogBadgeBg'
        | 'toolPermissionDialogBadgeText'
        | 'toolPermissionDialogCommandBg'
        | 'toolPermissionDialogCommandLabelText'
        | 'toolPermissionDialogCommandText'
        | 'toolPermissionDialogDenyButtonBg'
        | 'toolPermissionDialogDenyButtonBorder'
        | 'toolPermissionDialogDenyButtonText'
        | 'toolPermissionDialogAllowButtonBg'
        | 'toolPermissionDialogAllowButtonBorder'
        | 'toolPermissionDialogAllowButtonText'
        | 'toolPermissionDialogAllowAllButtonBg'
        | 'toolPermissionDialogAllowAllButtonBorder'
        | 'toolPermissionDialogAllowAllButtonText'
        | 'authModalBackdrop'
        | 'authModalSurfaceBg'
        | 'authModalTitleText'
        | 'authModalBodyText'
        | 'authModalPrimaryButtonBg'
        | 'authModalPrimaryButtonBorder'
        | 'authModalPrimaryButtonText'
        | 'authModalSecondaryButtonBg'
        | 'authModalSecondaryButtonBorder'
        | 'authModalSecondaryButtonText'
        | 'authModalDangerButtonBg'
        | 'authModalDangerButtonBorder'
        | 'authModalDangerButtonText'
        | 'htmlToolsModalSurfaceBg'
        | 'htmlToolsModalSurfaceBorder'
        | 'htmlToolsModalPanelMutedBg'
        | 'htmlToolsModalButtonBg'
        | 'htmlToolsModalButtonBorder'
        | 'htmlToolsModalButtonText'
        | 'htmlToolsModalButtonActiveBg'
        | 'htmlToolsModalButtonActiveBorder'
        | 'htmlToolsModalButtonActiveText'
        | 'markdownCodeBlockBg'
        | 'markdownCodeBlockBorder'
        | 'markdownCodeBlockText'
        | 'markdownInlineCodeBg'
        | 'markdownInlineCodeText',
      mode: 'light' | 'dark',
      nextValue: string
    ) => {
      updateTheme(current => ({
        ...current,
        colors: {
          ...current.colors,
          [key]: {
            ...current.colors[key],
            [mode]: nextValue,
          },
        },
      }))
    },
    [updateTheme]
  )

  const handleRoleColorChange = useCallback(
    (role: ChatThemeRoleKey, key: 'containerBg' | 'border' | 'roleText', mode: 'light' | 'dark', nextValue: string) => {
      updateTheme(current => ({
        ...current,
        colors: {
          ...current.colors,
          messageRoles: {
            ...current.colors.messageRoles,
            [role]: {
              ...current.colors.messageRoles[role],
              [key]: {
                ...current.colors.messageRoles[role][key],
                [mode]: nextValue,
              },
            },
          },
        },
      }))
    },
    [updateTheme]
  )

  const handleNodeColorChange = useCallback(
    (
      sender: HeimdallNodeThemeKey,
      key: 'fill' | 'stroke' | 'visibleStroke',
      mode: 'light' | 'dark',
      nextValue: string
    ) => {
      updateTheme(current => ({
        ...current,
        colors: {
          ...current.colors,
          heimdallNodes: {
            ...current.colors.heimdallNodes,
            [sender]: {
              ...current.colors.heimdallNodes[sender],
              [key]: {
                ...current.colors.heimdallNodes[sender][key],
                [mode]: nextValue,
              },
            },
          },
        },
      }))
    },
    [updateTheme]
  )

  const applyImportedTheme = useCallback(
    (rawTheme: string, sourceLabel: string) => {
      try {
        const parsed = JSON.parse(rawTheme)
        const nextTheme = sanitizeCustomTheme(parsed)
        saveCustomChatTheme(nextTheme)
        setCustomChatThemeEnabled(true)
        setStatus(`Theme loaded from ${sourceLabel}`)
      } catch (error) {
        setStatus(
          error instanceof Error ? `Failed to import theme: ${error.message}` : 'Failed to import theme',
          'error'
        )
      }
    },
    [setStatus]
  )

  const handleImportFromDisk = useCallback(async () => {
    try {
      const electronApi = window.electronAPI
      if (electronApi?.dialog?.openFile && electronApi?.fs?.readFile) {
        const result = await electronApi.dialog.openFile({
          title: 'Import Theme JSON',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        })

        if (!result?.success || !result.filePath) {
          return
        }

        const readResult = await electronApi.fs.readFile(result.filePath, 'utf8')
        if (typeof readResult === 'string') {
          applyImportedTheme(readResult, result.filePath)
          return
        }

        if (!readResult?.success || typeof readResult.content !== 'string') {
          throw new Error(readResult?.error || 'Unable to read selected theme file')
        }

        applyImportedTheme(readResult.content, result.filePath)
        return
      }

      importInputRef.current?.click()
    } catch (error) {
      setStatus(
        error instanceof Error ? `Failed to open theme file: ${error.message}` : 'Failed to open theme file',
        'error'
      )
    }
  }, [applyImportedTheme, setStatus])

  const handleImportInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return

      try {
        const rawTheme = await file.text()
        applyImportedTheme(rawTheme, file.name)
      } catch (error) {
        setStatus(
          error instanceof Error ? `Failed to read theme file: ${error.message}` : 'Failed to read theme file',
          'error'
        )
      }
    },
    [applyImportedTheme, setStatus]
  )

  const handleExport = useCallback(() => {
    const safeName = (theme.name || 'custom-theme').trim().replace(/[^a-z0-9-_]+/gi, '-') || 'custom-theme'
    const payload = JSON.stringify(theme, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeName.toLowerCase()}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    setStatus('Theme exported as JSON')
  }, [setStatus, theme])

  const handleReset = useCallback(() => {
    const confirmed = window.confirm('Reset custom theme colors to defaults?')
    if (!confirmed) return
    saveCustomChatTheme(createDefaultCustomChatTheme())
    setStatus('Theme reset to defaults')
  }, [setStatus])

  const summary = useMemo(() => (enabled ? theme.name || 'Custom Theme' : 'Disabled'), [enabled, theme.name])

  return (
    <div className='space-y-2'>
      <button
        type='button'
        onClick={() => setIsExpanded(prev => !prev)}
        className='w-full flex items-center justify-between py-2 text-left'
      >
        <span className='text-[16px] font-medium text-stone-700 dark:text-stone-200'>Advanced Custom Theme</span>
        <div className='flex items-center gap-2'>
          <span className='text-xs text-neutral-500 dark:text-neutral-400'>{summary}</span>
          <i className={`bx ${isExpanded ? 'bx-chevron-up' : 'bx-chevron-down'} text-lg text-neutral-500`}></i>
        </div>
      </button>

      {isExpanded && (
        <div className='space-y-4 pl-1 pt-1'>
          <div className='space-y-2'>
            <label className='text-xs font-medium text-neutral-600 dark:text-neutral-400'>Theme name</label>
            <input
              type='text'
              value={theme.name}
              onChange={e => handleThemeNameChange(e.target.value)}
              className='w-full rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-100'
              placeholder='My Custom Theme'
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Chat surfaces</h4>
            <PairEditor
              label='Chat panel + message list background'
              value={theme.colors.chatPanelBg}
              onChange={handleCombinedChatSurfaceChange}
            />
            <PairEditor
              label='Heimdall background'
              value={theme.colors.heimdallPanelBg}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallPanelBg', mode, value)}
            />
            <PairEditor
              label='Conversation toolbar bubble'
              value={theme.colors.conversationToolbarBg}
              onChange={(mode, value) => handleChatSurfaceChange('conversationToolbarBg', mode, value)}
            />
            <PairEditor
              label='Settings solid-color section background'
              value={theme.colors.settingsSolidColorSectionBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsSolidColorSectionBg', mode, value)}
            />
            <PairEditor
              label='App solid background colors (Settings > Solid Color Background)'
              value={theme.colors.appBackgroundColor}
              onChange={(mode, value) => handleChatSurfaceChange('appBackgroundColor', mode, value)}
            />
            <PairEditor
              label='Settings pane full body background'
              value={theme.colors.settingsPaneBodyBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsPaneBodyBg', mode, value)}
            />
            <h4 className='pt-2 text-sm font-semibold text-stone-700 dark:text-stone-200'>Saved custom themes panel</h4>
            <PairEditor
              label='Panel card background'
              value={theme.colors.settingsCustomThemesCardBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesCardBg', mode, value)}
            />
            <PairEditor
              label='Panel card border'
              value={theme.colors.settingsCustomThemesCardBorder}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesCardBorder', mode, value)}
            />
            <PairEditor
              label='Panel accent icon background'
              value={theme.colors.settingsCustomThemesAccentBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesAccentBg', mode, value)}
            />
            <PairEditor
              label='Panel accent icon text'
              value={theme.colors.settingsCustomThemesAccentText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesAccentText', mode, value)}
            />
            <PairEditor
              label='Panel title text'
              value={theme.colors.settingsCustomThemesTitleText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesTitleText', mode, value)}
            />
            <PairEditor
              label='Panel body text'
              value={theme.colors.settingsCustomThemesBodyText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesBodyText', mode, value)}
            />
            <PairEditor
              label='Panel code badge background'
              value={theme.colors.settingsCustomThemesCodeBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesCodeBg', mode, value)}
            />
            <PairEditor
              label='Panel code badge text'
              value={theme.colors.settingsCustomThemesCodeText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesCodeText', mode, value)}
            />
            <PairEditor
              label='Expanded panel divider border'
              value={theme.colors.settingsCustomThemesPanelBorder}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesPanelBorder', mode, value)}
            />
            <PairEditor
              label='Enable theme card background'
              value={theme.colors.settingsCustomThemesInnerCardBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesInnerCardBg', mode, value)}
            />
            <PairEditor
              label='Enable theme card border'
              value={theme.colors.settingsCustomThemesInnerCardBorder}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesInnerCardBorder', mode, value)}
            />
            <PairEditor
              label='Badge background'
              value={theme.colors.settingsCustomThemesBadgeBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesBadgeBg', mode, value)}
            />
            <PairEditor
              label='Badge text'
              value={theme.colors.settingsCustomThemesBadgeText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesBadgeText', mode, value)}
            />
            <PairEditor
              label='Secondary button background'
              value={theme.colors.settingsCustomThemesButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesButtonBg', mode, value)}
            />
            <PairEditor
              label='Secondary button border'
              value={theme.colors.settingsCustomThemesButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesButtonBorder', mode, value)}
            />
            <PairEditor
              label='Secondary button text'
              value={theme.colors.settingsCustomThemesButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesButtonText', mode, value)}
            />
            <PairEditor
              label='Empty state background'
              value={theme.colors.settingsCustomThemesEmptyStateBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesEmptyStateBg', mode, value)}
            />
            <PairEditor
              label='Empty state border'
              value={theme.colors.settingsCustomThemesEmptyStateBorder}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesEmptyStateBorder', mode, value)}
            />
            <PairEditor
              label='Saved themes list background'
              value={theme.colors.settingsCustomThemesListBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesListBg', mode, value)}
            />
            <PairEditor
              label='Saved themes list border'
              value={theme.colors.settingsCustomThemesListBorder}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesListBorder', mode, value)}
            />
            <PairEditor
              label='Saved theme title text'
              value={theme.colors.settingsCustomThemesListItemTitleText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesListItemTitleText', mode, value)}
            />
            <PairEditor
              label='Saved theme meta text'
              value={theme.colors.settingsCustomThemesListItemMetaText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesListItemMetaText', mode, value)}
            />
            <PairEditor
              label='Primary apply button background'
              value={theme.colors.settingsCustomThemesPrimaryButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesPrimaryButtonBg', mode, value)}
            />
            <PairEditor
              label='Primary apply button text'
              value={theme.colors.settingsCustomThemesPrimaryButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('settingsCustomThemesPrimaryButtonText', mode, value)}
            />
            <PairEditor
              label='Chat input area border'
              value={theme.colors.chatInputAreaBorder}
              onChange={(mode, value) => handleChatSurfaceChange('chatInputAreaBorder', mode, value)}
            />
            <PairEditor
              label='Chat progress bar fill'
              value={theme.colors.chatProgressBarFill}
              onChange={(mode, value) => handleChatSurfaceChange('chatProgressBarFill', mode, value)}
            />
            <PairEditor
              label='Action popover border'
              value={theme.colors.actionPopoverBorder}
              onChange={(mode, value) => handleChatSurfaceChange('actionPopoverBorder', mode, value)}
            />
            <PairEditor
              label='Send button loading animation color'
              value={theme.colors.sendButtonAnimationColor}
              onChange={(mode, value) => handleChatSurfaceChange('sendButtonAnimationColor', mode, value)}
            />
            <PairEditor
              label='Streaming loading animation color'
              value={theme.colors.streamingAnimationColor}
              onChange={(mode, value) => handleChatSurfaceChange('streamingAnimationColor', mode, value)}
            />
            <PairEditor
              label='Composer active toggle background (Allow all / Agent)'
              value={theme.colors.composerToggleActiveBg}
              onChange={(mode, value) => handleChatSurfaceChange('composerToggleActiveBg', mode, value)}
            />
            <PairEditor
              label='Composer active toggle border (Allow all / Agent)'
              value={theme.colors.composerToggleActiveBorder}
              onChange={(mode, value) => handleChatSurfaceChange('composerToggleActiveBorder', mode, value)}
            />
            <PairEditor
              label='Composer active toggle text (Allow all / Agent)'
              value={theme.colors.composerToggleActiveText}
              onChange={(mode, value) => handleChatSurfaceChange('composerToggleActiveText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>
              Markdown code blocks + inline code
            </h4>
            <PairEditor
              label='Code block surface background'
              value={theme.colors.markdownCodeBlockBg}
              onChange={(mode, value) => handleChatSurfaceChange('markdownCodeBlockBg', mode, value)}
            />
            <PairEditor
              label='Code block border'
              value={theme.colors.markdownCodeBlockBorder}
              onChange={(mode, value) => handleChatSurfaceChange('markdownCodeBlockBorder', mode, value)}
            />
            <PairEditor
              label='Code block plain text'
              value={theme.colors.markdownCodeBlockText}
              onChange={(mode, value) => handleChatSurfaceChange('markdownCodeBlockText', mode, value)}
            />
            <PairEditor
              label='Inline code background'
              value={theme.colors.markdownInlineCodeBg}
              onChange={(mode, value) => handleChatSurfaceChange('markdownInlineCodeBg', mode, value)}
            />
            <PairEditor
              label='Inline code text'
              value={theme.colors.markdownInlineCodeText}
              onChange={(mode, value) => handleChatSurfaceChange('markdownInlineCodeText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Heimdall node + note modals</h4>
            <PairEditor
              label='Node hover modal background'
              value={theme.colors.heimdallNodeHoverModalBg}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNodeHoverModalBg', mode, value)}
            />
            <PairEditor
              label='Node hover modal border'
              value={theme.colors.heimdallNodeHoverModalBorder}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNodeHoverModalBorder', mode, value)}
            />
            <PairEditor
              label='Node hover modal body text'
              value={theme.colors.heimdallNodeHoverModalText}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNodeHoverModalText', mode, value)}
            />
            <PairEditor
              label='Node hover modal title text'
              value={theme.colors.heimdallNodeHoverModalTitleText}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNodeHoverModalTitleText', mode, value)}
            />
            <PairEditor
              label='Edit note modal background'
              value={theme.colors.heimdallNoteDialogBg}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogBg', mode, value)}
            />
            <PairEditor
              label='Edit note modal border'
              value={theme.colors.heimdallNoteDialogBorder}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogBorder', mode, value)}
            />
            <PairEditor
              label='Edit note modal title text'
              value={theme.colors.heimdallNoteDialogTitleText}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogTitleText', mode, value)}
            />
            <PairEditor
              label='Edit note modal button background'
              value={theme.colors.heimdallNoteDialogButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogButtonBg', mode, value)}
            />
            <PairEditor
              label='Edit note modal button border'
              value={theme.colors.heimdallNoteDialogButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogButtonBorder', mode, value)}
            />
            <PairEditor
              label='Edit note modal button text'
              value={theme.colors.heimdallNoteDialogButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogButtonText', mode, value)}
            />
            <PairEditor
              label='Edit note modal close icon color'
              value={theme.colors.heimdallNoteDialogCloseButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNoteDialogCloseButtonText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>IDE context pills (Input)</h4>
            <PairEditor
              label='Detected context pill background'
              value={theme.colors.ideContextPillBg}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPillBg', mode, value)}
            />
            <PairEditor
              label='Detected context pill border'
              value={theme.colors.ideContextPillBorder}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPillBorder', mode, value)}
            />
            <PairEditor
              label='Detected context pill text'
              value={theme.colors.ideContextPillText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPillText', mode, value)}
            />
            <PairEditor
              label='Add-context button background'
              value={theme.colors.ideContextAddButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextAddButtonBg', mode, value)}
            />
            <PairEditor
              label='Add-context button border'
              value={theme.colors.ideContextAddButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextAddButtonBorder', mode, value)}
            />
            <PairEditor
              label='Add-context button text'
              value={theme.colors.ideContextAddButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextAddButtonText', mode, value)}
            />
            <PairEditor
              label='Hover preview modal background'
              value={theme.colors.ideContextPreviewBg}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPreviewBg', mode, value)}
            />
            <PairEditor
              label='Hover preview modal border'
              value={theme.colors.ideContextPreviewBorder}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPreviewBorder', mode, value)}
            />
            <PairEditor
              label='Hover preview file/location text'
              value={theme.colors.ideContextPreviewFileText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPreviewFileText', mode, value)}
            />
            <PairEditor
              label='Hover preview code text'
              value={theme.colors.ideContextPreviewCodeText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextPreviewCodeText', mode, value)}
            />
            <PairEditor
              label='Selected context pill background'
              value={theme.colors.ideContextSelectedPillBg}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextSelectedPillBg', mode, value)}
            />
            <PairEditor
              label='Selected context pill border'
              value={theme.colors.ideContextSelectedPillBorder}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextSelectedPillBorder', mode, value)}
            />
            <PairEditor
              label='Selected context pill text'
              value={theme.colors.ideContextSelectedPillText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextSelectedPillText', mode, value)}
            />
            <PairEditor
              label='Clear button border'
              value={theme.colors.ideContextClearButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextClearButtonBorder', mode, value)}
            />
            <PairEditor
              label='Clear button text'
              value={theme.colors.ideContextClearButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextClearButtonText', mode, value)}
            />
            <PairEditor
              label='"Context added" text color'
              value={theme.colors.ideContextAddedText}
              onChange={(mode, value) => handleChatSurfaceChange('ideContextAddedText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Tool Jobs modal</h4>
            <PairEditor
              label='Modal backdrop'
              value={theme.colors.toolJobsModalBackdrop}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsModalBackdrop', mode, value)}
            />
            <PairEditor
              label='Modal surface background'
              value={theme.colors.toolJobsModalBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsModalBg', mode, value)}
            />
            <PairEditor
              label='Modal surface border'
              value={theme.colors.toolJobsModalBorder}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsModalBorder', mode, value)}
            />
            <PairEditor
              label='Panel/card background'
              value={theme.colors.toolJobsPanelBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsPanelBg', mode, value)}
            />
            <PairEditor
              label='Panel/card border'
              value={theme.colors.toolJobsPanelBorder}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsPanelBorder', mode, value)}
            />
            <PairEditor
              label='Primary text'
              value={theme.colors.toolJobsPrimaryText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsPrimaryText', mode, value)}
            />
            <PairEditor
              label='Secondary text'
              value={theme.colors.toolJobsSecondaryText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsSecondaryText', mode, value)}
            />
            <PairEditor
              label='Muted/meta text'
              value={theme.colors.toolJobsMutedText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsMutedText', mode, value)}
            />
            <PairEditor
              label='Code block background'
              value={theme.colors.toolJobsCodeBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsCodeBg', mode, value)}
            />
            <PairEditor
              label='Code block text'
              value={theme.colors.toolJobsCodeText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsCodeText', mode, value)}
            />
            <PairEditor
              label='Error section background'
              value={theme.colors.toolJobsErrorBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsErrorBg', mode, value)}
            />
            <PairEditor
              label='Error section border'
              value={theme.colors.toolJobsErrorBorder}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsErrorBorder', mode, value)}
            />
            <PairEditor
              label='Error text'
              value={theme.colors.toolJobsErrorText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsErrorText', mode, value)}
            />
            <PairEditor
              label='Live badge background'
              value={theme.colors.toolJobsLiveBadgeBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsLiveBadgeBg', mode, value)}
            />
            <PairEditor
              label='Live badge text'
              value={theme.colors.toolJobsLiveBadgeText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsLiveBadgeText', mode, value)}
            />
            <PairEditor
              label='Live badge dot'
              value={theme.colors.toolJobsLiveDot}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsLiveDot', mode, value)}
            />
            <PairEditor
              label='Progress track'
              value={theme.colors.toolJobsProgressTrack}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsProgressTrack', mode, value)}
            />
            <PairEditor
              label='Progress pending color'
              value={theme.colors.toolJobsProgressPending}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsProgressPending', mode, value)}
            />
            <PairEditor
              label='Progress running color'
              value={theme.colors.toolJobsProgressRunning}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsProgressRunning', mode, value)}
            />
            <PairEditor
              label='Progress completed color'
              value={theme.colors.toolJobsProgressCompleted}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsProgressCompleted', mode, value)}
            />
            <PairEditor
              label='Progress failed color'
              value={theme.colors.toolJobsProgressFailed}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsProgressFailed', mode, value)}
            />
            <PairEditor
              label='Status pending badge background'
              value={theme.colors.toolJobsStatusPendingBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusPendingBg', mode, value)}
            />
            <PairEditor
              label='Status pending badge text'
              value={theme.colors.toolJobsStatusPendingText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusPendingText', mode, value)}
            />
            <PairEditor
              label='Status running badge background'
              value={theme.colors.toolJobsStatusRunningBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusRunningBg', mode, value)}
            />
            <PairEditor
              label='Status running badge text'
              value={theme.colors.toolJobsStatusRunningText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusRunningText', mode, value)}
            />
            <PairEditor
              label='Status completed badge background'
              value={theme.colors.toolJobsStatusCompletedBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusCompletedBg', mode, value)}
            />
            <PairEditor
              label='Status completed badge text'
              value={theme.colors.toolJobsStatusCompletedText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusCompletedText', mode, value)}
            />
            <PairEditor
              label='Status failed badge background'
              value={theme.colors.toolJobsStatusFailedBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusFailedBg', mode, value)}
            />
            <PairEditor
              label='Status failed badge text'
              value={theme.colors.toolJobsStatusFailedText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusFailedText', mode, value)}
            />
            <PairEditor
              label='Status cancelled badge background'
              value={theme.colors.toolJobsStatusCancelledBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusCancelledBg', mode, value)}
            />
            <PairEditor
              label='Status cancelled badge text'
              value={theme.colors.toolJobsStatusCancelledText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusCancelledText', mode, value)}
            />
            <PairEditor
              label='Status active workers badge background'
              value={theme.colors.toolJobsStatusActiveWorkersBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusActiveWorkersBg', mode, value)}
            />
            <PairEditor
              label='Status active workers badge text'
              value={theme.colors.toolJobsStatusActiveWorkersText}
              onChange={(mode, value) => handleChatSurfaceChange('toolJobsStatusActiveWorkersText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Tool permission prompt</h4>
            <PairEditor
              label='Dialog background'
              value={theme.colors.toolPermissionDialogBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogBg', mode, value)}
            />
            <PairEditor
              label='Dialog border'
              value={theme.colors.toolPermissionDialogBorder}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogBorder', mode, value)}
            />
            <PairEditor
              label='Title text'
              value={theme.colors.toolPermissionDialogTitleText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogTitleText', mode, value)}
            />
            <PairEditor
              label='Tool name text'
              value={theme.colors.toolPermissionDialogToolNameText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogToolNameText', mode, value)}
            />
            <PairEditor
              label='Tool badge background'
              value={theme.colors.toolPermissionDialogBadgeBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogBadgeBg', mode, value)}
            />
            <PairEditor
              label='Tool badge text'
              value={theme.colors.toolPermissionDialogBadgeText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogBadgeText', mode, value)}
            />
            <PairEditor
              label='Command preview background'
              value={theme.colors.toolPermissionDialogCommandBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogCommandBg', mode, value)}
            />
            <PairEditor
              label='Command label text'
              value={theme.colors.toolPermissionDialogCommandLabelText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogCommandLabelText', mode, value)}
            />
            <PairEditor
              label='Command text'
              value={theme.colors.toolPermissionDialogCommandText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogCommandText', mode, value)}
            />
            <PairEditor
              label='Deny button background'
              value={theme.colors.toolPermissionDialogDenyButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogDenyButtonBg', mode, value)}
            />
            <PairEditor
              label='Deny button border'
              value={theme.colors.toolPermissionDialogDenyButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogDenyButtonBorder', mode, value)}
            />
            <PairEditor
              label='Deny button text'
              value={theme.colors.toolPermissionDialogDenyButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogDenyButtonText', mode, value)}
            />
            <PairEditor
              label='Allow once button background'
              value={theme.colors.toolPermissionDialogAllowButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogAllowButtonBg', mode, value)}
            />
            <PairEditor
              label='Allow once button border'
              value={theme.colors.toolPermissionDialogAllowButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogAllowButtonBorder', mode, value)}
            />
            <PairEditor
              label='Allow once button text'
              value={theme.colors.toolPermissionDialogAllowButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogAllowButtonText', mode, value)}
            />
            <PairEditor
              label='Always allow button background'
              value={theme.colors.toolPermissionDialogAllowAllButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogAllowAllButtonBg', mode, value)}
            />
            <PairEditor
              label='Always allow button border'
              value={theme.colors.toolPermissionDialogAllowAllButtonBorder}
              onChange={(mode, value) =>
                handleChatSurfaceChange('toolPermissionDialogAllowAllButtonBorder', mode, value)
              }
            />
            <PairEditor
              label='Always allow button text'
              value={theme.colors.toolPermissionDialogAllowAllButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('toolPermissionDialogAllowAllButtonText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Auth modals (Chat)</h4>
            <PairEditor
              label='Modal backdrop'
              value={theme.colors.authModalBackdrop}
              onChange={(mode, value) => handleChatSurfaceChange('authModalBackdrop', mode, value)}
            />
            <PairEditor
              label='Modal surface background'
              value={theme.colors.authModalSurfaceBg}
              onChange={(mode, value) => handleChatSurfaceChange('authModalSurfaceBg', mode, value)}
            />
            <PairEditor
              label='Modal title text'
              value={theme.colors.authModalTitleText}
              onChange={(mode, value) => handleChatSurfaceChange('authModalTitleText', mode, value)}
            />
            <PairEditor
              label='Modal body text'
              value={theme.colors.authModalBodyText}
              onChange={(mode, value) => handleChatSurfaceChange('authModalBodyText', mode, value)}
            />
            <PairEditor
              label='Primary button background'
              value={theme.colors.authModalPrimaryButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('authModalPrimaryButtonBg', mode, value)}
            />
            <PairEditor
              label='Primary button border'
              value={theme.colors.authModalPrimaryButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('authModalPrimaryButtonBorder', mode, value)}
            />
            <PairEditor
              label='Primary button text'
              value={theme.colors.authModalPrimaryButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('authModalPrimaryButtonText', mode, value)}
            />
            <PairEditor
              label='Secondary button background'
              value={theme.colors.authModalSecondaryButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('authModalSecondaryButtonBg', mode, value)}
            />
            <PairEditor
              label='Secondary button border'
              value={theme.colors.authModalSecondaryButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('authModalSecondaryButtonBorder', mode, value)}
            />
            <PairEditor
              label='Secondary button text'
              value={theme.colors.authModalSecondaryButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('authModalSecondaryButtonText', mode, value)}
            />
            <PairEditor
              label='Danger button background'
              value={theme.colors.authModalDangerButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('authModalDangerButtonBg', mode, value)}
            />
            <PairEditor
              label='Danger button border'
              value={theme.colors.authModalDangerButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('authModalDangerButtonBorder', mode, value)}
            />
            <PairEditor
              label='Danger button text'
              value={theme.colors.authModalDangerButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('authModalDangerButtonText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>
              Task Manager modal (HTML tools)
            </h4>
            <PairEditor
              label='Modal surface background'
              value={theme.colors.htmlToolsModalSurfaceBg}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalSurfaceBg', mode, value)}
            />
            <PairEditor
              label='Modal border'
              value={theme.colors.htmlToolsModalSurfaceBorder}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalSurfaceBorder', mode, value)}
            />
            <PairEditor
              label='Muted panel background'
              value={theme.colors.htmlToolsModalPanelMutedBg}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalPanelMutedBg', mode, value)}
            />
            <PairEditor
              label='Button background'
              value={theme.colors.htmlToolsModalButtonBg}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalButtonBg', mode, value)}
            />
            <PairEditor
              label='Button border'
              value={theme.colors.htmlToolsModalButtonBorder}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalButtonBorder', mode, value)}
            />
            <PairEditor
              label='Button text'
              value={theme.colors.htmlToolsModalButtonText}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalButtonText', mode, value)}
            />
            <PairEditor
              label='Active button background'
              value={theme.colors.htmlToolsModalButtonActiveBg}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalButtonActiveBg', mode, value)}
            />
            <PairEditor
              label='Active button border'
              value={theme.colors.htmlToolsModalButtonActiveBorder}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalButtonActiveBorder', mode, value)}
            />
            <PairEditor
              label='Active button text'
              value={theme.colors.htmlToolsModalButtonActiveText}
              onChange={(mode, value) => handleChatSurfaceChange('htmlToolsModalButtonActiveText', mode, value)}
            />
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Message role colors</h4>
            {ROLE_KEYS.map(role => (
              <div key={role} className='rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 space-y-3'>
                <p className='text-sm font-medium text-stone-700 dark:text-stone-200'>{ROLE_LABELS[role]}</p>
                <PairEditor
                  label='Container background'
                  value={theme.colors.messageRoles[role].containerBg}
                  onChange={(mode, value) => handleRoleColorChange(role, 'containerBg', mode, value)}
                />
                <PairEditor
                  label='Border color'
                  value={theme.colors.messageRoles[role].border}
                  onChange={(mode, value) => handleRoleColorChange(role, 'border', mode, value)}
                />
                <PairEditor
                  label='Role text color'
                  value={theme.colors.messageRoles[role].roleText}
                  onChange={(mode, value) => handleRoleColorChange(role, 'roleText', mode, value)}
                />
              </div>
            ))}
          </div>

          <div className='space-y-3'>
            <h4 className='text-sm font-semibold text-stone-700 dark:text-stone-200'>Heimdall node colors</h4>
            <PairEditor
              label='Heimdall note pill background'
              value={theme.colors.heimdallNotePillBg}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNotePillBg', mode, value)}
            />
            <PairEditor
              label='Heimdall note pill text'
              value={theme.colors.heimdallNotePillText}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNotePillText', mode, value)}
            />
            <PairEditor
              label='Heimdall note pill border'
              value={theme.colors.heimdallNotePillBorder}
              onChange={(mode, value) => handleChatSurfaceChange('heimdallNotePillBorder', mode, value)}
            />
            {NODE_KEYS.map(sender => (
              <div key={sender} className='rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 space-y-3'>
                <p className='text-sm font-medium text-stone-700 dark:text-stone-200'>{NODE_LABELS[sender]}</p>
                <PairEditor
                  label='Node fill'
                  value={theme.colors.heimdallNodes[sender].fill}
                  onChange={(mode, value) => handleNodeColorChange(sender, 'fill', mode, value)}
                />
                <PairEditor
                  label='Node stroke'
                  value={theme.colors.heimdallNodes[sender].stroke}
                  onChange={(mode, value) => handleNodeColorChange(sender, 'stroke', mode, value)}
                />
                <PairEditor
                  label='Visible node stroke'
                  value={theme.colors.heimdallNodes[sender].visibleStroke}
                  onChange={(mode, value) => handleNodeColorChange(sender, 'visibleStroke', mode, value)}
                />
              </div>
            ))}
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <input
              ref={importInputRef}
              type='file'
              accept='application/json,.json'
              className='hidden'
              onChange={handleImportInputChange}
            />
            <button
              type='button'
              onClick={handleImportFromDisk}
              className='px-3 py-2 rounded-lg text-sm bg-emerald-500 text-white hover:bg-emerald-600 transition-colors'
            >
              Import Theme JSON
            </button>
            <button
              type='button'
              onClick={handleExport}
              className='px-3 py-2 rounded-lg text-sm bg-blue-500 text-white hover:bg-blue-600 transition-colors'
            >
              Export Theme JSON
            </button>
            <button
              type='button'
              onClick={handleReset}
              className='px-3 py-2 rounded-lg text-sm border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors'
            >
              Reset to defaults
            </button>
            {status && (
              <span
                className={`text-xs ${
                  status.tone === 'error'
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {status.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
