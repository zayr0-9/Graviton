import { useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark'
export type ChatThemeRoleKey = 'user' | 'assistant' | 'system' | 'ex_agent' | 'unknown'
export type HeimdallNodeThemeKey = 'user' | 'assistant' | 'ex_agent'

export interface ThemeColorPair {
  light: string
  dark: string
}

export interface ChatMessageRoleTheme {
  containerBg: ThemeColorPair
  border: ThemeColorPair
  roleText: ThemeColorPair
}

export interface HeimdallNodeTheme {
  fill: ThemeColorPair
  stroke: ThemeColorPair
  visibleStroke: ThemeColorPair
}

export interface CustomChatTheme {
  version: 1
  name: string
  colors: {
    chatPanelBg: ThemeColorPair
    chatMessageListBg: ThemeColorPair
    heimdallPanelBg: ThemeColorPair
    conversationToolbarBg: ThemeColorPair
    settingsSolidColorSectionBg: ThemeColorPair
    appBackgroundColor: ThemeColorPair
    settingsPaneBodyBg: ThemeColorPair
    chatInputAreaBorder: ThemeColorPair
    chatProgressBarFill: ThemeColorPair
    actionPopoverBorder: ThemeColorPair
    sendButtonAnimationColor: ThemeColorPair
    streamingAnimationColor: ThemeColorPair
    composerToggleActiveBg: ThemeColorPair
    composerToggleActiveBorder: ThemeColorPair
    composerToggleActiveText: ThemeColorPair
    heimdallNotePillBg: ThemeColorPair
    heimdallNotePillText: ThemeColorPair
    heimdallNotePillBorder: ThemeColorPair
    heimdallNodeHoverModalBg: ThemeColorPair
    heimdallNodeHoverModalBorder: ThemeColorPair
    heimdallNodeHoverModalText: ThemeColorPair
    heimdallNodeHoverModalTitleText: ThemeColorPair
    heimdallNoteDialogBg: ThemeColorPair
    heimdallNoteDialogBorder: ThemeColorPair
    heimdallNoteDialogTitleText: ThemeColorPair
    heimdallNoteDialogButtonBg: ThemeColorPair
    heimdallNoteDialogButtonBorder: ThemeColorPair
    heimdallNoteDialogButtonText: ThemeColorPair
    heimdallNoteDialogCloseButtonText: ThemeColorPair
    ideContextPillBg: ThemeColorPair
    ideContextPillBorder: ThemeColorPair
    ideContextPillText: ThemeColorPair
    ideContextAddButtonBg: ThemeColorPair
    ideContextAddButtonBorder: ThemeColorPair
    ideContextAddButtonText: ThemeColorPair
    ideContextPreviewBg: ThemeColorPair
    ideContextPreviewBorder: ThemeColorPair
    ideContextPreviewFileText: ThemeColorPair
    ideContextPreviewCodeText: ThemeColorPair
    ideContextSelectedPillBg: ThemeColorPair
    ideContextSelectedPillBorder: ThemeColorPair
    ideContextSelectedPillText: ThemeColorPair
    ideContextClearButtonBorder: ThemeColorPair
    ideContextClearButtonText: ThemeColorPair
    ideContextAddedText: ThemeColorPair
    toolJobsModalBackdrop: ThemeColorPair
    toolJobsModalBg: ThemeColorPair
    toolJobsModalBorder: ThemeColorPair
    toolJobsPanelBg: ThemeColorPair
    toolJobsPanelBorder: ThemeColorPair
    toolJobsPrimaryText: ThemeColorPair
    toolJobsSecondaryText: ThemeColorPair
    toolJobsMutedText: ThemeColorPair
    toolJobsCodeBg: ThemeColorPair
    toolJobsCodeText: ThemeColorPair
    toolJobsErrorBg: ThemeColorPair
    toolJobsErrorBorder: ThemeColorPair
    toolJobsErrorText: ThemeColorPair
    toolJobsLiveBadgeBg: ThemeColorPair
    toolJobsLiveBadgeText: ThemeColorPair
    toolJobsLiveDot: ThemeColorPair
    toolJobsProgressTrack: ThemeColorPair
    toolJobsProgressPending: ThemeColorPair
    toolJobsProgressRunning: ThemeColorPair
    toolJobsProgressCompleted: ThemeColorPair
    toolJobsProgressFailed: ThemeColorPair
    toolJobsStatusPendingBg: ThemeColorPair
    toolJobsStatusPendingText: ThemeColorPair
    toolJobsStatusRunningBg: ThemeColorPair
    toolJobsStatusRunningText: ThemeColorPair
    toolJobsStatusCompletedBg: ThemeColorPair
    toolJobsStatusCompletedText: ThemeColorPair
    toolJobsStatusFailedBg: ThemeColorPair
    toolJobsStatusFailedText: ThemeColorPair
    toolJobsStatusCancelledBg: ThemeColorPair
    toolJobsStatusCancelledText: ThemeColorPair
    toolJobsStatusActiveWorkersBg: ThemeColorPair
    toolJobsStatusActiveWorkersText: ThemeColorPair
    toolPermissionDialogBg: ThemeColorPair
    toolPermissionDialogBorder: ThemeColorPair
    toolPermissionDialogTitleText: ThemeColorPair
    toolPermissionDialogToolNameText: ThemeColorPair
    toolPermissionDialogBadgeBg: ThemeColorPair
    toolPermissionDialogBadgeText: ThemeColorPair
    toolPermissionDialogCommandBg: ThemeColorPair
    toolPermissionDialogCommandLabelText: ThemeColorPair
    toolPermissionDialogCommandText: ThemeColorPair
    toolPermissionDialogDenyButtonBg: ThemeColorPair
    toolPermissionDialogDenyButtonBorder: ThemeColorPair
    toolPermissionDialogDenyButtonText: ThemeColorPair
    toolPermissionDialogAllowButtonBg: ThemeColorPair
    toolPermissionDialogAllowButtonBorder: ThemeColorPair
    toolPermissionDialogAllowButtonText: ThemeColorPair
    toolPermissionDialogAllowAllButtonBg: ThemeColorPair
    toolPermissionDialogAllowAllButtonBorder: ThemeColorPair
    toolPermissionDialogAllowAllButtonText: ThemeColorPair
    authModalBackdrop: ThemeColorPair
    authModalSurfaceBg: ThemeColorPair
    authModalTitleText: ThemeColorPair
    authModalBodyText: ThemeColorPair
    authModalPrimaryButtonBg: ThemeColorPair
    authModalPrimaryButtonBorder: ThemeColorPair
    authModalPrimaryButtonText: ThemeColorPair
    authModalSecondaryButtonBg: ThemeColorPair
    authModalSecondaryButtonBorder: ThemeColorPair
    authModalSecondaryButtonText: ThemeColorPair
    authModalDangerButtonBg: ThemeColorPair
    authModalDangerButtonBorder: ThemeColorPair
    authModalDangerButtonText: ThemeColorPair
    htmlToolsModalSurfaceBg: ThemeColorPair
    htmlToolsModalSurfaceBorder: ThemeColorPair
    htmlToolsModalPanelMutedBg: ThemeColorPair
    htmlToolsModalButtonBg: ThemeColorPair
    htmlToolsModalButtonBorder: ThemeColorPair
    htmlToolsModalButtonText: ThemeColorPair
    htmlToolsModalButtonActiveBg: ThemeColorPair
    htmlToolsModalButtonActiveBorder: ThemeColorPair
    htmlToolsModalButtonActiveText: ThemeColorPair
    markdownCodeBlockBg: ThemeColorPair
    markdownCodeBlockBorder: ThemeColorPair
    markdownCodeBlockText: ThemeColorPair
    markdownInlineCodeBg: ThemeColorPair
    markdownInlineCodeText: ThemeColorPair
    messageRoles: Record<ChatThemeRoleKey, ChatMessageRoleTheme>
    heimdallNodes: Record<HeimdallNodeThemeKey, HeimdallNodeTheme>
  }
}

export const CHAT_CUSTOM_THEME_STORAGE_KEY = 'chat:customTheme'
export const CHAT_CUSTOM_THEME_ENABLED_STORAGE_KEY = 'chat:customThemeEnabled'
export const CHAT_CUSTOM_THEME_CHANGE_EVENT = 'chatCustomThemeChange'

const MESSAGE_ROLE_KEYS: ChatThemeRoleKey[] = ['user', 'assistant', 'system', 'ex_agent', 'unknown']
const HEIMDALL_NODE_KEYS: HeimdallNodeThemeKey[] = ['user', 'assistant', 'ex_agent']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const pickString = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value : fallback)

const readColorPair = (value: unknown, fallback: ThemeColorPair): ThemeColorPair => {
  if (!isRecord(value)) {
    return { ...fallback }
  }

  return {
    light: pickString(value.light, fallback.light),
    dark: pickString(value.dark, fallback.dark),
  }
}

export const createDefaultCustomChatTheme = (): CustomChatTheme => ({
  version: 1,
  name: 'Custom Theme',
  colors: {
    chatPanelBg: {
      light: 'oklch(98.5% 0 0)',
      dark: 'oklch(20.5% 0 0)',
    },
    chatMessageListBg: {
      light: 'oklch(98.5% 0 0)',
      dark: 'oklch(20.5% 0 0)',
    },
    heimdallPanelBg: {
      light: '#fafafa',
      dark: '#0a0a0a',
    },
    conversationToolbarBg: {
      light: 'rgba(255, 255, 255, 0.8)',
      dark: 'rgba(23, 23, 23, 0.8)',
    },
    settingsSolidColorSectionBg: {
      light: 'rgba(250, 250, 250, 0.7)',
      dark: 'rgba(24, 24, 27, 0.6)',
    },
    appBackgroundColor: {
      light: '#F7F9FB',
      dark: '#050505',
    },
    settingsPaneBodyBg: {
      light: 'oklch(97% 0 0)',
      dark: 'oklch(18% 0 0)',
    },
    chatInputAreaBorder: {
      light: 'rgba(194, 65, 12, 0.7)',
      dark: 'rgba(194, 65, 12, 0.7)',
    },
    chatProgressBarFill: {
      light: '#3b82f6',
      dark: '#60a5fa',
    },
    actionPopoverBorder: {
      light: '#dbeafe',
      dark: 'rgba(194, 65, 12, 0.4)',
    },
    sendButtonAnimationColor: {
      light: '#ffffff',
      dark: '#ffffff',
    },
    streamingAnimationColor: {
      light: '#ef4444',
      dark: '#ffffff',
    },
    composerToggleActiveBg: {
      light: '#fff7ed',
      dark: 'rgba(124, 45, 18, 0.2)',
    },
    composerToggleActiveBorder: {
      light: '#fdba74',
      dark: 'rgba(194, 65, 12, 0.5)',
    },
    composerToggleActiveText: {
      light: '#c2410c',
      dark: '#fb923c',
    },
    heimdallNotePillBg: {
      light: '#3b82f6',
      dark: '#f59e0b',
    },
    heimdallNotePillText: {
      light: '#ffffff',
      dark: '#0c0a09',
    },
    heimdallNotePillBorder: {
      light: 'rgba(0,0,0,0.18)',
      dark: 'rgba(0,0,0,0.18)',
    },
    heimdallNodeHoverModalBg: {
      light: '#fafafa',
      dark: '#262626',
    },
    heimdallNodeHoverModalBorder: {
      light: '#e7e5e4',
      dark: '#404040',
    },
    heimdallNodeHoverModalText: {
      light: '#292524',
      dark: '#e7e5e4',
    },
    heimdallNodeHoverModalTitleText: {
      light: '#292524',
      dark: '#e7e5e4',
    },
    heimdallNoteDialogBg: {
      light: '#fafafa',
      dark: '#09090b',
    },
    heimdallNoteDialogBorder: {
      light: '#e7e5e4',
      dark: '#404040',
    },
    heimdallNoteDialogTitleText: {
      light: '#292524',
      dark: '#e7e5e4',
    },
    heimdallNoteDialogButtonBg: {
      light: 'transparent',
      dark: 'transparent',
    },
    heimdallNoteDialogButtonBorder: {
      light: '#d6d3d1',
      dark: '#57534e',
    },
    heimdallNoteDialogButtonText: {
      light: '#57534e',
      dark: '#d6d3d1',
    },
    heimdallNoteDialogCloseButtonText: {
      light: '#a8a29e',
      dark: '#a8a29e',
    },
    ideContextPillBg: {
      light: 'rgba(219, 234, 254, 0.8)',
      dark: 'rgba(23, 23, 23, 0.4)',
    },
    ideContextPillBorder: {
      light: 'rgba(96, 165, 250, 0.6)',
      dark: 'rgba(249, 115, 22, 0.6)',
    },
    ideContextPillText: {
      light: '#111827',
      dark: '#e5e7eb',
    },
    ideContextAddButtonBg: {
      light: 'rgba(219, 234, 254, 0.8)',
      dark: 'rgba(38, 38, 38, 0.6)',
    },
    ideContextAddButtonBorder: {
      light: 'rgba(96, 165, 250, 0.6)',
      dark: 'rgba(251, 146, 60, 0.7)',
    },
    ideContextAddButtonText: {
      light: '#111827',
      dark: '#ffedd5',
    },
    ideContextPreviewBg: {
      light: 'rgba(245, 245, 245, 0.95)',
      dark: 'rgba(10, 10, 10, 0.95)',
    },
    ideContextPreviewBorder: {
      light: 'rgba(249, 115, 22, 0.35)',
      dark: 'rgba(249, 115, 22, 0.4)',
    },
    ideContextPreviewFileText: {
      light: '#7c2d12',
      dark: '#fed7aa',
    },
    ideContextPreviewCodeText: {
      light: '#7c2d12',
      dark: '#ffedd5',
    },
    ideContextSelectedPillBg: {
      light: 'rgba(255, 255, 255, 0.85)',
      dark: 'rgba(38, 38, 38, 0.7)',
    },
    ideContextSelectedPillBorder: {
      light: 'rgba(249, 115, 22, 0.35)',
      dark: 'rgba(249, 115, 22, 0.4)',
    },
    ideContextSelectedPillText: {
      light: '#111827',
      dark: '#ffedd5',
    },
    ideContextClearButtonBorder: {
      light: 'rgba(163, 163, 163, 0.7)',
      dark: 'rgba(249, 115, 22, 0.4)',
    },
    ideContextClearButtonText: {
      light: '#404040',
      dark: '#ffedd5',
    },
    ideContextAddedText: {
      light: '#1d4ed8',
      dark: '#fdba74',
    },
    toolJobsModalBackdrop: {
      light: 'rgba(0, 0, 0, 0.6)',
      dark: 'rgba(0, 0, 0, 0.6)',
    },
    toolJobsModalBg: {
      light: '#ffffff',
      dark: 'oklch(20.5% 0 0)',
    },
    toolJobsModalBorder: {
      light: '#e5e5e5',
      dark: '#262626',
    },
    toolJobsPanelBg: {
      light: 'rgba(250, 250, 250, 0.8)',
      dark: 'rgba(23, 23, 23, 0.6)',
    },
    toolJobsPanelBorder: {
      light: '#e5e5e5',
      dark: '#262626',
    },
    toolJobsPrimaryText: {
      light: '#171717',
      dark: '#fafafa',
    },
    toolJobsSecondaryText: {
      light: '#525252',
      dark: '#a3a3a3',
    },
    toolJobsMutedText: {
      light: '#737373',
      dark: '#a3a3a3',
    },
    toolJobsCodeBg: {
      light: '#f5f5f5',
      dark: '#262626',
    },
    toolJobsCodeText: {
      light: '#262626',
      dark: '#e5e5e5',
    },
    toolJobsErrorBg: {
      light: 'rgba(255, 241, 242, 0.85)',
      dark: 'rgba(127, 29, 29, 0.2)',
    },
    toolJobsErrorBorder: {
      light: '#fecdd3',
      dark: '#9f1239',
    },
    toolJobsErrorText: {
      light: '#be123c',
      dark: '#fda4af',
    },
    toolJobsLiveBadgeBg: {
      light: 'rgba(209, 250, 229, 1)',
      dark: 'rgba(6, 78, 59, 0.3)',
    },
    toolJobsLiveBadgeText: {
      light: '#047857',
      dark: '#a7f3d0',
    },
    toolJobsLiveDot: {
      light: '#10b981',
      dark: '#34d399',
    },
    toolJobsProgressTrack: {
      light: '#e5e5e5',
      dark: '#262626',
    },
    toolJobsProgressPending: {
      light: '#f59e0b',
      dark: '#f59e0b',
    },
    toolJobsProgressRunning: {
      light: '#3b82f6',
      dark: '#60a5fa',
    },
    toolJobsProgressCompleted: {
      light: '#10b981',
      dark: '#34d399',
    },
    toolJobsProgressFailed: {
      light: '#f43f5e',
      dark: '#fb7185',
    },
    toolJobsStatusPendingBg: {
      light: '#fef3c7',
      dark: 'rgba(120, 53, 15, 0.35)',
    },
    toolJobsStatusPendingText: {
      light: '#b45309',
      dark: '#fde68a',
    },
    toolJobsStatusRunningBg: {
      light: '#dbeafe',
      dark: 'rgba(30, 58, 138, 0.35)',
    },
    toolJobsStatusRunningText: {
      light: '#1d4ed8',
      dark: '#bfdbfe',
    },
    toolJobsStatusCompletedBg: {
      light: '#d1fae5',
      dark: 'rgba(6, 78, 59, 0.35)',
    },
    toolJobsStatusCompletedText: {
      light: '#047857',
      dark: '#a7f3d0',
    },
    toolJobsStatusFailedBg: {
      light: '#ffe4e6',
      dark: 'rgba(136, 19, 55, 0.35)',
    },
    toolJobsStatusFailedText: {
      light: '#be123c',
      dark: '#fecdd3',
    },
    toolJobsStatusCancelledBg: {
      light: '#e5e5e5',
      dark: '#262626',
    },
    toolJobsStatusCancelledText: {
      light: '#404040',
      dark: '#e5e5e5',
    },
    toolJobsStatusActiveWorkersBg: {
      light: '#dbeafe',
      dark: 'rgba(30, 58, 138, 0.35)',
    },
    toolJobsStatusActiveWorkersText: {
      light: '#1d4ed8',
      dark: '#bfdbfe',
    },
    toolPermissionDialogBg: {
      light: 'rgba(245, 245, 245, 0.85)',
      dark: '#171717',
    },
    toolPermissionDialogBorder: {
      light: 'rgba(229, 229, 229, 0.9)',
      dark: '#404040',
    },
    toolPermissionDialogTitleText: {
      light: '#262626',
      dark: '#f5f5f5',
    },
    toolPermissionDialogToolNameText: {
      light: '#2563eb',
      dark: '#fb923c',
    },
    toolPermissionDialogBadgeBg: {
      light: '#e5e5e5',
      dark: '#262626',
    },
    toolPermissionDialogBadgeText: {
      light: '#737373',
      dark: '#a3a3a3',
    },
    toolPermissionDialogCommandBg: {
      light: '#f5f5f5',
      dark: '#000000',
    },
    toolPermissionDialogCommandLabelText: {
      light: '#525252',
      dark: '#737373',
    },
    toolPermissionDialogCommandText: {
      light: '#1d4ed8',
      dark: '#d4d4d8',
    },
    toolPermissionDialogDenyButtonBg: {
      light: '#dc2626',
      dark: 'rgba(127, 29, 29, 0.9)',
    },
    toolPermissionDialogDenyButtonBorder: {
      light: '#b91c1c',
      dark: 'rgba(159, 18, 57, 0.8)',
    },
    toolPermissionDialogDenyButtonText: {
      light: '#e5e7eb',
      dark: '#e5e7eb',
    },
    toolPermissionDialogAllowButtonBg: {
      light: '#e5e5e5',
      dark: 'rgba(38, 38, 38, 0.95)',
    },
    toolPermissionDialogAllowButtonBorder: {
      light: '#d4d4d4',
      dark: '#525252',
    },
    toolPermissionDialogAllowButtonText: {
      light: '#262626',
      dark: '#f5f5f5',
    },
    toolPermissionDialogAllowAllButtonBg: {
      light: '#e5e5e5',
      dark: 'rgba(38, 38, 38, 0.95)',
    },
    toolPermissionDialogAllowAllButtonBorder: {
      light: '#d4d4d4',
      dark: '#525252',
    },
    toolPermissionDialogAllowAllButtonText: {
      light: '#1e40af',
      dark: '#fdba74',
    },
    authModalBackdrop: {
      light: 'rgba(0, 0, 0, 0.5)',
      dark: 'rgba(0, 0, 0, 0.5)',
    },
    authModalSurfaceBg: {
      light: '#ffffff',
      dark: '#09090b',
    },
    authModalTitleText: {
      light: '#171717',
      dark: '#f5f5f5',
    },
    authModalBodyText: {
      light: '#525252',
      dark: '#d4d4d8',
    },
    authModalPrimaryButtonBg: {
      light: '#059669',
      dark: '#059669',
    },
    authModalPrimaryButtonBorder: {
      light: '#047857',
      dark: '#047857',
    },
    authModalPrimaryButtonText: {
      light: '#ffffff',
      dark: '#ffffff',
    },
    authModalSecondaryButtonBg: {
      light: 'transparent',
      dark: 'transparent',
    },
    authModalSecondaryButtonBorder: {
      light: '#d4d4d8',
      dark: '#3f3f46',
    },
    authModalSecondaryButtonText: {
      light: '#404040',
      dark: '#d4d4d8',
    },
    authModalDangerButtonBg: {
      light: '#dc2626',
      dark: '#dc2626',
    },
    authModalDangerButtonBorder: {
      light: '#b91c1c',
      dark: '#b91c1c',
    },
    authModalDangerButtonText: {
      light: '#ffffff',
      dark: '#ffffff',
    },
    htmlToolsModalSurfaceBg: {
      light: 'rgba(255, 255, 255, 0.98)',
      dark: 'rgba(15, 15, 15, 0.98)',
    },
    htmlToolsModalSurfaceBorder: {
      light: '#e5e5e5',
      dark: 'rgba(255, 255, 255, 0.06)',
    },
    htmlToolsModalPanelMutedBg: {
      light: '#fafafa',
      dark: 'rgba(0, 0, 0, 0.2)',
    },
    htmlToolsModalButtonBg: {
      light: '#f5f5f5',
      dark: 'rgba(255, 255, 255, 0.02)',
    },
    htmlToolsModalButtonBorder: {
      light: '#e5e5e5',
      dark: 'rgba(255, 255, 255, 0.05)',
    },
    htmlToolsModalButtonText: {
      light: '#525252',
      dark: '#a3a3a3',
    },
    htmlToolsModalButtonActiveBg: {
      light: '#e5e5e5',
      dark: 'rgba(255, 255, 255, 0.08)',
    },
    htmlToolsModalButtonActiveBorder: {
      light: '#d4d4d4',
      dark: 'rgba(255, 255, 255, 0.1)',
    },
    htmlToolsModalButtonActiveText: {
      light: '#171717',
      dark: '#ffffff',
    },
    markdownCodeBlockBg: {
      light: '#f3f4f6',
      dark: '#171717',
    },
    markdownCodeBlockBorder: {
      light: 'rgba(0, 0, 0, 0.08)',
      dark: 'rgba(255, 255, 255, 0.08)',
    },
    markdownCodeBlockText: {
      light: '#111827',
      dark: '#f3f4f6',
    },
    markdownInlineCodeBg: {
      light: '#e5e7eb',
      dark: '#262626',
    },
    markdownInlineCodeText: {
      light: '#111827',
      dark: '#f5f5f5',
    },
    messageRoles: {
      user: {
        containerBg: { light: '#fafafa', dark: '#171717' },
        border: { light: 'transparent', dark: 'transparent' },
        roleText: { light: '#3730a3', dark: '#f5f3ff' },
      },
      assistant: {
        containerBg: { light: 'transparent', dark: 'transparent' },
        border: { light: 'transparent', dark: 'transparent' },
        roleText: { light: '#3f6212', dark: '#fef3c7' },
      },
      system: {
        containerBg: { light: 'transparent', dark: 'transparent' },
        border: { light: 'transparent', dark: 'transparent' },
        roleText: { light: '#c084fc', dark: '#c084fc' },
      },
      ex_agent: {
        containerBg: { light: 'transparent', dark: 'transparent' },
        border: { light: 'transparent', dark: 'transparent' },
        roleText: { light: '#c2410c', dark: '#fb923c' },
      },
      unknown: {
        containerBg: { light: 'transparent', dark: 'transparent' },
        border: { light: 'transparent', dark: 'transparent' },
        roleText: { light: '#9ca3af', dark: '#9ca3af' },
      },
    },
    heimdallNodes: {
      user: {
        fill: { light: '#f5f5f5', dark: '#171717' },
        stroke: { light: '#d4d4d4', dark: '#262626' },
        visibleStroke: { light: '#34d399', dark: '#f97316' },
      },
      assistant: {
        fill: { light: '#f1f5f9', dark: '#171717' },
        stroke: { light: '#e5e5e5', dark: '#262626' },
        visibleStroke: { light: '#34d399', dark: '#f97316' },
      },
      ex_agent: {
        fill: { light: '#f8fafc', dark: '#0a0a0a' },
        stroke: { light: '#ea580c', dark: '#ea580c' },
        visibleStroke: { light: '#34d399', dark: '#ea580c' },
      },
    },
  },
})

export const sanitizeCustomTheme = (value: unknown): CustomChatTheme => {
  const defaults = createDefaultCustomChatTheme()

  if (!isRecord(value)) {
    return defaults
  }

  const rawColors = isRecord(value.colors) ? value.colors : {}
  const rawRoleThemes = isRecord(rawColors.messageRoles) ? rawColors.messageRoles : {}
  const rawNodeThemes = isRecord(rawColors.heimdallNodes) ? rawColors.heimdallNodes : {}

  const messageRoles = MESSAGE_ROLE_KEYS.reduce(
    (acc, role) => {
      const fallback = defaults.colors.messageRoles[role]
      const rawRoleTheme = isRecord(rawRoleThemes[role]) ? rawRoleThemes[role] : {}

      acc[role] = {
        containerBg: readColorPair(rawRoleTheme.containerBg, fallback.containerBg),
        border: readColorPair(rawRoleTheme.border, fallback.border),
        roleText: readColorPair(rawRoleTheme.roleText, fallback.roleText),
      }

      return acc
    },
    {} as Record<ChatThemeRoleKey, ChatMessageRoleTheme>
  )

  const heimdallNodes = HEIMDALL_NODE_KEYS.reduce(
    (acc, sender) => {
      const fallback = defaults.colors.heimdallNodes[sender]
      const rawNodeTheme = isRecord(rawNodeThemes[sender]) ? rawNodeThemes[sender] : {}

      acc[sender] = {
        fill: readColorPair(rawNodeTheme.fill, fallback.fill),
        stroke: readColorPair(rawNodeTheme.stroke, fallback.stroke),
        visibleStroke: readColorPair(rawNodeTheme.visibleStroke, fallback.visibleStroke),
      }

      return acc
    },
    {} as Record<HeimdallNodeThemeKey, HeimdallNodeTheme>
  )

  return {
    version: 1,
    name: pickString(value.name, defaults.name),
    colors: {
      chatPanelBg: readColorPair(rawColors.chatPanelBg, defaults.colors.chatPanelBg),
      chatMessageListBg: readColorPair(rawColors.chatMessageListBg, defaults.colors.chatMessageListBg),
      heimdallPanelBg: readColorPair(rawColors.heimdallPanelBg, defaults.colors.heimdallPanelBg),
      conversationToolbarBg: readColorPair(rawColors.conversationToolbarBg, defaults.colors.conversationToolbarBg),
      settingsSolidColorSectionBg: readColorPair(
        rawColors.settingsSolidColorSectionBg,
        defaults.colors.settingsSolidColorSectionBg
      ),
      appBackgroundColor: readColorPair(rawColors.appBackgroundColor, defaults.colors.appBackgroundColor),
      settingsPaneBodyBg: readColorPair(rawColors.settingsPaneBodyBg, defaults.colors.settingsPaneBodyBg),
      chatInputAreaBorder: readColorPair(rawColors.chatInputAreaBorder, defaults.colors.chatInputAreaBorder),
      chatProgressBarFill: readColorPair(rawColors.chatProgressBarFill, defaults.colors.chatProgressBarFill),
      actionPopoverBorder: readColorPair(rawColors.actionPopoverBorder, defaults.colors.actionPopoverBorder),
      sendButtonAnimationColor: readColorPair(
        rawColors.sendButtonAnimationColor,
        defaults.colors.sendButtonAnimationColor
      ),
      streamingAnimationColor: readColorPair(rawColors.streamingAnimationColor, defaults.colors.streamingAnimationColor),
      composerToggleActiveBg: readColorPair(rawColors.composerToggleActiveBg, defaults.colors.composerToggleActiveBg),
      composerToggleActiveBorder: readColorPair(
        rawColors.composerToggleActiveBorder,
        defaults.colors.composerToggleActiveBorder
      ),
      composerToggleActiveText: readColorPair(
        rawColors.composerToggleActiveText,
        defaults.colors.composerToggleActiveText
      ),
      heimdallNotePillBg: readColorPair(rawColors.heimdallNotePillBg, defaults.colors.heimdallNotePillBg),
      heimdallNotePillText: readColorPair(rawColors.heimdallNotePillText, defaults.colors.heimdallNotePillText),
      heimdallNotePillBorder: readColorPair(rawColors.heimdallNotePillBorder, defaults.colors.heimdallNotePillBorder),
      heimdallNodeHoverModalBg: readColorPair(
        rawColors.heimdallNodeHoverModalBg,
        defaults.colors.heimdallNodeHoverModalBg
      ),
      heimdallNodeHoverModalBorder: readColorPair(
        rawColors.heimdallNodeHoverModalBorder,
        defaults.colors.heimdallNodeHoverModalBorder
      ),
      heimdallNodeHoverModalText: readColorPair(
        rawColors.heimdallNodeHoverModalText,
        defaults.colors.heimdallNodeHoverModalText
      ),
      heimdallNodeHoverModalTitleText: readColorPair(
        rawColors.heimdallNodeHoverModalTitleText,
        defaults.colors.heimdallNodeHoverModalTitleText
      ),
      heimdallNoteDialogBg: readColorPair(rawColors.heimdallNoteDialogBg, defaults.colors.heimdallNoteDialogBg),
      heimdallNoteDialogBorder: readColorPair(
        rawColors.heimdallNoteDialogBorder,
        defaults.colors.heimdallNoteDialogBorder
      ),
      heimdallNoteDialogTitleText: readColorPair(
        rawColors.heimdallNoteDialogTitleText,
        defaults.colors.heimdallNoteDialogTitleText
      ),
      heimdallNoteDialogButtonBg: readColorPair(
        rawColors.heimdallNoteDialogButtonBg,
        defaults.colors.heimdallNoteDialogButtonBg
      ),
      heimdallNoteDialogButtonBorder: readColorPair(
        rawColors.heimdallNoteDialogButtonBorder,
        defaults.colors.heimdallNoteDialogButtonBorder
      ),
      heimdallNoteDialogButtonText: readColorPair(
        rawColors.heimdallNoteDialogButtonText,
        defaults.colors.heimdallNoteDialogButtonText
      ),
      heimdallNoteDialogCloseButtonText: readColorPair(
        rawColors.heimdallNoteDialogCloseButtonText,
        defaults.colors.heimdallNoteDialogCloseButtonText
      ),
      ideContextPillBg: readColorPair(rawColors.ideContextPillBg, defaults.colors.ideContextPillBg),
      ideContextPillBorder: readColorPair(rawColors.ideContextPillBorder, defaults.colors.ideContextPillBorder),
      ideContextPillText: readColorPair(rawColors.ideContextPillText, defaults.colors.ideContextPillText),
      ideContextAddButtonBg: readColorPair(rawColors.ideContextAddButtonBg, defaults.colors.ideContextAddButtonBg),
      ideContextAddButtonBorder: readColorPair(
        rawColors.ideContextAddButtonBorder,
        defaults.colors.ideContextAddButtonBorder
      ),
      ideContextAddButtonText: readColorPair(
        rawColors.ideContextAddButtonText,
        defaults.colors.ideContextAddButtonText
      ),
      ideContextPreviewBg: readColorPair(rawColors.ideContextPreviewBg, defaults.colors.ideContextPreviewBg),
      ideContextPreviewBorder: readColorPair(rawColors.ideContextPreviewBorder, defaults.colors.ideContextPreviewBorder),
      ideContextPreviewFileText: readColorPair(
        rawColors.ideContextPreviewFileText,
        defaults.colors.ideContextPreviewFileText
      ),
      ideContextPreviewCodeText: readColorPair(
        rawColors.ideContextPreviewCodeText,
        defaults.colors.ideContextPreviewCodeText
      ),
      ideContextSelectedPillBg: readColorPair(
        rawColors.ideContextSelectedPillBg,
        defaults.colors.ideContextSelectedPillBg
      ),
      ideContextSelectedPillBorder: readColorPair(
        rawColors.ideContextSelectedPillBorder,
        defaults.colors.ideContextSelectedPillBorder
      ),
      ideContextSelectedPillText: readColorPair(
        rawColors.ideContextSelectedPillText,
        defaults.colors.ideContextSelectedPillText
      ),
      ideContextClearButtonBorder: readColorPair(
        rawColors.ideContextClearButtonBorder,
        defaults.colors.ideContextClearButtonBorder
      ),
      ideContextClearButtonText: readColorPair(
        rawColors.ideContextClearButtonText,
        defaults.colors.ideContextClearButtonText
      ),
      ideContextAddedText: readColorPair(rawColors.ideContextAddedText, defaults.colors.ideContextAddedText),
      toolJobsModalBackdrop: readColorPair(rawColors.toolJobsModalBackdrop, defaults.colors.toolJobsModalBackdrop),
      toolJobsModalBg: readColorPair(rawColors.toolJobsModalBg, defaults.colors.toolJobsModalBg),
      toolJobsModalBorder: readColorPair(rawColors.toolJobsModalBorder, defaults.colors.toolJobsModalBorder),
      toolJobsPanelBg: readColorPair(rawColors.toolJobsPanelBg, defaults.colors.toolJobsPanelBg),
      toolJobsPanelBorder: readColorPair(rawColors.toolJobsPanelBorder, defaults.colors.toolJobsPanelBorder),
      toolJobsPrimaryText: readColorPair(rawColors.toolJobsPrimaryText, defaults.colors.toolJobsPrimaryText),
      toolJobsSecondaryText: readColorPair(rawColors.toolJobsSecondaryText, defaults.colors.toolJobsSecondaryText),
      toolJobsMutedText: readColorPair(rawColors.toolJobsMutedText, defaults.colors.toolJobsMutedText),
      toolJobsCodeBg: readColorPair(rawColors.toolJobsCodeBg, defaults.colors.toolJobsCodeBg),
      toolJobsCodeText: readColorPair(rawColors.toolJobsCodeText, defaults.colors.toolJobsCodeText),
      toolJobsErrorBg: readColorPair(rawColors.toolJobsErrorBg, defaults.colors.toolJobsErrorBg),
      toolJobsErrorBorder: readColorPair(rawColors.toolJobsErrorBorder, defaults.colors.toolJobsErrorBorder),
      toolJobsErrorText: readColorPair(rawColors.toolJobsErrorText, defaults.colors.toolJobsErrorText),
      toolJobsLiveBadgeBg: readColorPair(rawColors.toolJobsLiveBadgeBg, defaults.colors.toolJobsLiveBadgeBg),
      toolJobsLiveBadgeText: readColorPair(rawColors.toolJobsLiveBadgeText, defaults.colors.toolJobsLiveBadgeText),
      toolJobsLiveDot: readColorPair(rawColors.toolJobsLiveDot, defaults.colors.toolJobsLiveDot),
      toolJobsProgressTrack: readColorPair(rawColors.toolJobsProgressTrack, defaults.colors.toolJobsProgressTrack),
      toolJobsProgressPending: readColorPair(
        rawColors.toolJobsProgressPending,
        defaults.colors.toolJobsProgressPending
      ),
      toolJobsProgressRunning: readColorPair(
        rawColors.toolJobsProgressRunning,
        defaults.colors.toolJobsProgressRunning
      ),
      toolJobsProgressCompleted: readColorPair(
        rawColors.toolJobsProgressCompleted,
        defaults.colors.toolJobsProgressCompleted
      ),
      toolJobsProgressFailed: readColorPair(rawColors.toolJobsProgressFailed, defaults.colors.toolJobsProgressFailed),
      toolJobsStatusPendingBg: readColorPair(rawColors.toolJobsStatusPendingBg, defaults.colors.toolJobsStatusPendingBg),
      toolJobsStatusPendingText: readColorPair(
        rawColors.toolJobsStatusPendingText,
        defaults.colors.toolJobsStatusPendingText
      ),
      toolJobsStatusRunningBg: readColorPair(rawColors.toolJobsStatusRunningBg, defaults.colors.toolJobsStatusRunningBg),
      toolJobsStatusRunningText: readColorPair(
        rawColors.toolJobsStatusRunningText,
        defaults.colors.toolJobsStatusRunningText
      ),
      toolJobsStatusCompletedBg: readColorPair(
        rawColors.toolJobsStatusCompletedBg,
        defaults.colors.toolJobsStatusCompletedBg
      ),
      toolJobsStatusCompletedText: readColorPair(
        rawColors.toolJobsStatusCompletedText,
        defaults.colors.toolJobsStatusCompletedText
      ),
      toolJobsStatusFailedBg: readColorPair(rawColors.toolJobsStatusFailedBg, defaults.colors.toolJobsStatusFailedBg),
      toolJobsStatusFailedText: readColorPair(
        rawColors.toolJobsStatusFailedText,
        defaults.colors.toolJobsStatusFailedText
      ),
      toolJobsStatusCancelledBg: readColorPair(
        rawColors.toolJobsStatusCancelledBg,
        defaults.colors.toolJobsStatusCancelledBg
      ),
      toolJobsStatusCancelledText: readColorPair(
        rawColors.toolJobsStatusCancelledText,
        defaults.colors.toolJobsStatusCancelledText
      ),
      toolJobsStatusActiveWorkersBg: readColorPair(
        rawColors.toolJobsStatusActiveWorkersBg,
        defaults.colors.toolJobsStatusActiveWorkersBg
      ),
      toolJobsStatusActiveWorkersText: readColorPair(
        rawColors.toolJobsStatusActiveWorkersText,
        defaults.colors.toolJobsStatusActiveWorkersText
      ),
      toolPermissionDialogBg: readColorPair(
        rawColors.toolPermissionDialogBg,
        defaults.colors.toolPermissionDialogBg
      ),
      toolPermissionDialogBorder: readColorPair(
        rawColors.toolPermissionDialogBorder,
        defaults.colors.toolPermissionDialogBorder
      ),
      toolPermissionDialogTitleText: readColorPair(
        rawColors.toolPermissionDialogTitleText,
        defaults.colors.toolPermissionDialogTitleText
      ),
      toolPermissionDialogToolNameText: readColorPair(
        rawColors.toolPermissionDialogToolNameText,
        defaults.colors.toolPermissionDialogToolNameText
      ),
      toolPermissionDialogBadgeBg: readColorPair(
        rawColors.toolPermissionDialogBadgeBg,
        defaults.colors.toolPermissionDialogBadgeBg
      ),
      toolPermissionDialogBadgeText: readColorPair(
        rawColors.toolPermissionDialogBadgeText,
        defaults.colors.toolPermissionDialogBadgeText
      ),
      toolPermissionDialogCommandBg: readColorPair(
        rawColors.toolPermissionDialogCommandBg,
        defaults.colors.toolPermissionDialogCommandBg
      ),
      toolPermissionDialogCommandLabelText: readColorPair(
        rawColors.toolPermissionDialogCommandLabelText,
        defaults.colors.toolPermissionDialogCommandLabelText
      ),
      toolPermissionDialogCommandText: readColorPair(
        rawColors.toolPermissionDialogCommandText,
        defaults.colors.toolPermissionDialogCommandText
      ),
      toolPermissionDialogDenyButtonBg: readColorPair(
        rawColors.toolPermissionDialogDenyButtonBg,
        defaults.colors.toolPermissionDialogDenyButtonBg
      ),
      toolPermissionDialogDenyButtonBorder: readColorPair(
        rawColors.toolPermissionDialogDenyButtonBorder,
        defaults.colors.toolPermissionDialogDenyButtonBorder
      ),
      toolPermissionDialogDenyButtonText: readColorPair(
        rawColors.toolPermissionDialogDenyButtonText,
        defaults.colors.toolPermissionDialogDenyButtonText
      ),
      toolPermissionDialogAllowButtonBg: readColorPair(
        rawColors.toolPermissionDialogAllowButtonBg,
        defaults.colors.toolPermissionDialogAllowButtonBg
      ),
      toolPermissionDialogAllowButtonBorder: readColorPair(
        rawColors.toolPermissionDialogAllowButtonBorder,
        defaults.colors.toolPermissionDialogAllowButtonBorder
      ),
      toolPermissionDialogAllowButtonText: readColorPair(
        rawColors.toolPermissionDialogAllowButtonText,
        defaults.colors.toolPermissionDialogAllowButtonText
      ),
      toolPermissionDialogAllowAllButtonBg: readColorPair(
        rawColors.toolPermissionDialogAllowAllButtonBg,
        defaults.colors.toolPermissionDialogAllowAllButtonBg
      ),
      toolPermissionDialogAllowAllButtonBorder: readColorPair(
        rawColors.toolPermissionDialogAllowAllButtonBorder,
        defaults.colors.toolPermissionDialogAllowAllButtonBorder
      ),
      toolPermissionDialogAllowAllButtonText: readColorPair(
        rawColors.toolPermissionDialogAllowAllButtonText,
        defaults.colors.toolPermissionDialogAllowAllButtonText
      ),
      authModalBackdrop: readColorPair(rawColors.authModalBackdrop, defaults.colors.authModalBackdrop),
      authModalSurfaceBg: readColorPair(rawColors.authModalSurfaceBg, defaults.colors.authModalSurfaceBg),
      authModalTitleText: readColorPair(rawColors.authModalTitleText, defaults.colors.authModalTitleText),
      authModalBodyText: readColorPair(rawColors.authModalBodyText, defaults.colors.authModalBodyText),
      authModalPrimaryButtonBg: readColorPair(
        rawColors.authModalPrimaryButtonBg,
        defaults.colors.authModalPrimaryButtonBg
      ),
      authModalPrimaryButtonBorder: readColorPair(
        rawColors.authModalPrimaryButtonBorder,
        defaults.colors.authModalPrimaryButtonBorder
      ),
      authModalPrimaryButtonText: readColorPair(
        rawColors.authModalPrimaryButtonText,
        defaults.colors.authModalPrimaryButtonText
      ),
      authModalSecondaryButtonBg: readColorPair(
        rawColors.authModalSecondaryButtonBg,
        defaults.colors.authModalSecondaryButtonBg
      ),
      authModalSecondaryButtonBorder: readColorPair(
        rawColors.authModalSecondaryButtonBorder,
        defaults.colors.authModalSecondaryButtonBorder
      ),
      authModalSecondaryButtonText: readColorPair(
        rawColors.authModalSecondaryButtonText,
        defaults.colors.authModalSecondaryButtonText
      ),
      authModalDangerButtonBg: readColorPair(
        rawColors.authModalDangerButtonBg,
        defaults.colors.authModalDangerButtonBg
      ),
      authModalDangerButtonBorder: readColorPair(
        rawColors.authModalDangerButtonBorder,
        defaults.colors.authModalDangerButtonBorder
      ),
      authModalDangerButtonText: readColorPair(
        rawColors.authModalDangerButtonText,
        defaults.colors.authModalDangerButtonText
      ),
      htmlToolsModalSurfaceBg: readColorPair(
        rawColors.htmlToolsModalSurfaceBg,
        defaults.colors.htmlToolsModalSurfaceBg
      ),
      htmlToolsModalSurfaceBorder: readColorPair(
        rawColors.htmlToolsModalSurfaceBorder,
        defaults.colors.htmlToolsModalSurfaceBorder
      ),
      htmlToolsModalPanelMutedBg: readColorPair(
        rawColors.htmlToolsModalPanelMutedBg,
        defaults.colors.htmlToolsModalPanelMutedBg
      ),
      htmlToolsModalButtonBg: readColorPair(rawColors.htmlToolsModalButtonBg, defaults.colors.htmlToolsModalButtonBg),
      htmlToolsModalButtonBorder: readColorPair(
        rawColors.htmlToolsModalButtonBorder,
        defaults.colors.htmlToolsModalButtonBorder
      ),
      htmlToolsModalButtonText: readColorPair(
        rawColors.htmlToolsModalButtonText,
        defaults.colors.htmlToolsModalButtonText
      ),
      htmlToolsModalButtonActiveBg: readColorPair(
        rawColors.htmlToolsModalButtonActiveBg,
        defaults.colors.htmlToolsModalButtonActiveBg
      ),
      htmlToolsModalButtonActiveBorder: readColorPair(
        rawColors.htmlToolsModalButtonActiveBorder,
        defaults.colors.htmlToolsModalButtonActiveBorder
      ),
      htmlToolsModalButtonActiveText: readColorPair(
        rawColors.htmlToolsModalButtonActiveText,
        defaults.colors.htmlToolsModalButtonActiveText
      ),
      markdownCodeBlockBg: readColorPair(rawColors.markdownCodeBlockBg, defaults.colors.markdownCodeBlockBg),
      markdownCodeBlockBorder: readColorPair(
        rawColors.markdownCodeBlockBorder,
        defaults.colors.markdownCodeBlockBorder
      ),
      markdownCodeBlockText: readColorPair(rawColors.markdownCodeBlockText, defaults.colors.markdownCodeBlockText),
      markdownInlineCodeBg: readColorPair(rawColors.markdownInlineCodeBg, defaults.colors.markdownInlineCodeBg),
      markdownInlineCodeText: readColorPair(
        rawColors.markdownInlineCodeText,
        defaults.colors.markdownInlineCodeText
      ),
      messageRoles,
      heimdallNodes,
    },
  }
}

const emitCustomThemeChange = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(CHAT_CUSTOM_THEME_CHANGE_EVENT))
}

export const getStoredCustomChatTheme = (): CustomChatTheme => {
  if (typeof window === 'undefined') {
    return createDefaultCustomChatTheme()
  }

  try {
    const stored = window.localStorage.getItem(CHAT_CUSTOM_THEME_STORAGE_KEY)
    if (!stored) {
      return createDefaultCustomChatTheme()
    }

    const parsed = JSON.parse(stored)
    return sanitizeCustomTheme(parsed)
  } catch {
    return createDefaultCustomChatTheme()
  }
}

export const saveCustomChatTheme = (theme: CustomChatTheme): void => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CHAT_CUSTOM_THEME_STORAGE_KEY, JSON.stringify(theme))
    emitCustomThemeChange()
  } catch {
    // Ignore localStorage write errors
  }
}

export const getCustomChatThemeEnabled = (): boolean => {
  if (typeof window === 'undefined') return false

  try {
    return window.localStorage.getItem(CHAT_CUSTOM_THEME_ENABLED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export const setCustomChatThemeEnabled = (enabled: boolean): void => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CHAT_CUSTOM_THEME_ENABLED_STORAGE_KEY, String(enabled))
    emitCustomThemeChange()
  } catch {
    // Ignore localStorage write errors
  }
}

export const resetCustomChatTheme = (): void => {
  saveCustomChatTheme(createDefaultCustomChatTheme())
}

export const getThemeModeColor = (pair: ThemeColorPair, isDarkMode: boolean): string =>
  isDarkMode ? pair.dark : pair.light

export const resolveRoleThemeKey = (role: string): ChatThemeRoleKey => {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system'
    case 'ex_agent':
      return 'ex_agent'
    default:
      return 'unknown'
  }
}

export const resolveHeimdallNodeThemeKey = (sender: string): HeimdallNodeThemeKey => {
  switch (sender) {
    case 'user':
      return 'user'
    case 'ex_agent':
      return 'ex_agent'
    default:
      return 'assistant'
  }
}

export const useHtmlDarkMode = (): boolean => {
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    if (typeof document === 'undefined') return

    const checkDarkMode = () => {
      setIsDarkMode(document.documentElement.classList.contains('dark'))
    }

    checkDarkMode()

    const observer = new MutationObserver(checkDarkMode)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    return () => observer.disconnect()
  }, [])

  return isDarkMode
}

export const useCustomChatTheme = () => {
  const [theme, setTheme] = useState<CustomChatTheme>(() => getStoredCustomChatTheme())
  const [enabled, setEnabled] = useState<boolean>(() => getCustomChatThemeEnabled())

  useEffect(() => {
    if (typeof window === 'undefined') return

    const syncFromStorage = () => {
      setTheme(getStoredCustomChatTheme())
      setEnabled(getCustomChatThemeEnabled())
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.key === CHAT_CUSTOM_THEME_STORAGE_KEY || event.key === CHAT_CUSTOM_THEME_ENABLED_STORAGE_KEY) {
        syncFromStorage()
      }
    }

    window.addEventListener(CHAT_CUSTOM_THEME_CHANGE_EVENT, syncFromStorage)
    window.addEventListener('storage', handleStorage)

    return () => {
      window.removeEventListener(CHAT_CUSTOM_THEME_CHANGE_EVENT, syncFromStorage)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  return { theme, enabled }
}
