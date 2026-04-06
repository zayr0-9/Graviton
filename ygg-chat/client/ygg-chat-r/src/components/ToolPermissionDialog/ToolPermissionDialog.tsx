import React from 'react'
import { ToolCall } from '../../features/chats/chatTypes'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

interface ToolPermissionDialogProps {
  toolCall: ToolCall
  onGrant: () => void
  onDeny: () => void
  onAllowAll: () => void
}

export const ToolPermissionDialog: React.FC<ToolPermissionDialogProps> = ({
  toolCall,
  onGrant,
  onDeny,
  onAllowAll,
}) => {
  const formattedArgs = JSON.stringify(toolCall.arguments, null, 2)
  const bashDescription =
    toolCall.name === 'bash' && typeof toolCall.arguments?.description === 'string'
      ? toolCall.arguments.description.trim()
      : ''
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const dialogBgColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogBg, isDarkMode)
    : isDarkMode
      ? '#171717'
      : 'rgba(245, 245, 245, 0.85)'
  const dialogBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogBorder, isDarkMode)
    : isDarkMode
      ? '#404040'
      : 'rgba(229, 229, 229, 0.9)'
  const titleTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogTitleText, isDarkMode)
    : isDarkMode
      ? '#f5f5f5'
      : '#262626'
  const toolNameTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogToolNameText, isDarkMode)
    : isDarkMode
      ? '#fb923c'
      : '#2563eb'
  const badgeBgColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogBadgeBg, isDarkMode)
    : isDarkMode
      ? '#262626'
      : '#e5e5e5'
  const badgeTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogBadgeText, isDarkMode)
    : isDarkMode
      ? '#a3a3a3'
      : '#737373'
  const commandBgColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogCommandBg, isDarkMode)
    : isDarkMode
      ? '#000000'
      : '#f5f5f5'
  const commandLabelTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogCommandLabelText, isDarkMode)
    : isDarkMode
      ? '#737373'
      : '#525252'
  const commandTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogCommandText, isDarkMode)
    : isDarkMode
      ? '#d4d4d8'
      : '#1d4ed8'

  const denyButtonBgColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogDenyButtonBg, isDarkMode)
    : isDarkMode
      ? 'rgba(127, 29, 29, 0.9)'
      : '#dc2626'
  const denyButtonBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogDenyButtonBorder, isDarkMode)
    : isDarkMode
      ? 'rgba(159, 18, 57, 0.8)'
      : '#b91c1c'
  const denyButtonTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogDenyButtonText, isDarkMode)
    : '#e5e7eb'

  const allowButtonBgColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogAllowButtonBg, isDarkMode)
    : isDarkMode
      ? 'rgba(38, 38, 38, 0.95)'
      : '#e5e5e5'
  const allowButtonBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogAllowButtonBorder, isDarkMode)
    : isDarkMode
      ? '#525252'
      : '#d4d4d4'
  const allowButtonTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogAllowButtonText, isDarkMode)
    : isDarkMode
      ? '#f5f5f5'
      : '#262626'

  const allowAllButtonBgColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogAllowAllButtonBg, isDarkMode)
    : isDarkMode
      ? 'rgba(38, 38, 38, 0.95)'
      : '#e5e5e5'
  const allowAllButtonBorderColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogAllowAllButtonBorder, isDarkMode)
    : isDarkMode
      ? '#525252'
      : '#d4d4d4'
  const allowAllButtonTextColor = customThemeEnabled
    ? getThemeModeColor(customTheme.colors.toolPermissionDialogAllowAllButtonText, isDarkMode)
    : isDarkMode
      ? '#fdba74'
      : '#1e40af'

  return (
    <div
      className='mx-1 rounded-[16px] py-1 px-1.5 shadow-[0_3px_5px_0px_rgba(0,0,0,0.05)] dark:shadow-[0_7px_12px_0px_rgba(0,0,0,0.25)] backdrop-blur-sm animate-in slide-in-from-bottom-2 fade-in duration-200 border'
      style={{
        backgroundColor: dialogBgColor,
        borderColor: dialogBorderColor,
      }}
    >
      {/* Header */}
      <div className='flex items-center px-1'>
        <div className='min-w-0 flex flex-1 mb-1 items-center gap-2'>
          <h3 className='text-sm' style={{ color: titleTextColor }}>
            Permission requested
          </h3>
          <span
            className='truncate rounded-md text-[10px] px-2 py-0.5 leading-none mt-0.5 tracking-[0.08em]'
            style={{ color: toolNameTextColor, backgroundColor: badgeBgColor }}
          >
            {toolCall.name.replace(/_/g, ' ').toUpperCase()}
          </span>
          {bashDescription && (
            <span className='min-w-0 truncate text-[11px] mt-0.5' style={{ color: badgeTextColor }} title={bashDescription}>
              {bashDescription}
            </span>
          )}
        </div>

        <div
          className='rounded-md px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]'
          style={{
            backgroundColor: badgeBgColor,
            color: badgeTextColor,
          }}
        >
          tool
        </div>
      </div>

      {/* Terminal-style command preview */}
      <div
        className='relative mt-1 overflow-y-auto rounded-lg px-3 py-2 thin-scrollbar sm:max-h-8 md:max-h-10 lg:max-h-18 xl:max-h-28 2xl:max-h-32'
        style={{ backgroundColor: commandBgColor }}
      >
        <div
          className='pointer-events-none font-mono absolute right-0 top-2 text-[12px] uppercase tracking-[0.14em]'
          style={{ color: commandLabelTextColor }}
        >
          COMMAND
        </div>

        <pre className='whitespace-pre-wrap break-all text-[10px] leading-5 font-mono'>
          <span style={{ color: commandTextColor }}>{formattedArgs}</span>
        </pre>
      </div>

      {/* Actions */}
      <div className='mt-2 grid grid-cols-3 gap-2 rounded-xl bg-white/[0.02] p-1'>
        <button
          type='button'
          onClick={onDeny}
          className='rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all hover:brightness-95'
          style={{
            backgroundColor: denyButtonBgColor,
            borderColor: denyButtonBorderColor,
            color: denyButtonTextColor,
          }}
        >
          Deny
        </button>
        <button
          type='button'
          onClick={onGrant}
          className='rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all hover:brightness-95'
          style={{
            backgroundColor: allowButtonBgColor,
            borderColor: allowButtonBorderColor,
            color: allowButtonTextColor,
          }}
        >
          Allow Once
        </button>
        <button
          type='button'
          onClick={onAllowAll}
          className='rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-all hover:brightness-95'
          style={{
            backgroundColor: allowAllButtonBgColor,
            borderColor: allowAllButtonBorderColor,
            color: allowAllButtonTextColor,
          }}
        >
          Always Allow
        </button>
      </div>
    </div>
  )
}
