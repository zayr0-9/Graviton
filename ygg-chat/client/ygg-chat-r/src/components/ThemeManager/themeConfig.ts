import type { CSSProperties } from 'react'
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
  visibleFill: ThemeColorPair
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
    thinScrollbarThumb: ThemeColorPair
    thinScrollbarThumbHover: ThemeColorPair
    thinScrollbarTrack: ThemeColorPair
    thinScrollbarShadow: ThemeColorPair
    settingsPaneBodyBg: ThemeColorPair
    settingsCustomThemesCardBg: ThemeColorPair
    settingsCustomThemesCardBorder: ThemeColorPair
    settingsCustomThemesAccentBg: ThemeColorPair
    settingsCustomThemesAccentText: ThemeColorPair
    settingsCustomThemesTitleText: ThemeColorPair
    settingsCustomThemesBodyText: ThemeColorPair
    settingsCustomThemesCodeBg: ThemeColorPair
    settingsCustomThemesCodeText: ThemeColorPair
    settingsCustomThemesPanelBorder: ThemeColorPair
    settingsCustomThemesInnerCardBg: ThemeColorPair
    settingsCustomThemesInnerCardBorder: ThemeColorPair
    settingsCustomThemesBadgeBg: ThemeColorPair
    settingsCustomThemesBadgeText: ThemeColorPair
    settingsCustomThemesButtonBg: ThemeColorPair
    settingsCustomThemesButtonBorder: ThemeColorPair
    settingsCustomThemesButtonText: ThemeColorPair
    settingsCustomThemesEmptyStateBg: ThemeColorPair
    settingsCustomThemesEmptyStateBorder: ThemeColorPair
    settingsCustomThemesListBg: ThemeColorPair
    settingsCustomThemesListBorder: ThemeColorPair
    settingsCustomThemesListItemTitleText: ThemeColorPair
    settingsCustomThemesListItemMetaText: ThemeColorPair
    settingsCustomThemesPrimaryButtonBg: ThemeColorPair
    settingsCustomThemesPrimaryButtonText: ThemeColorPair
    chatInputAreaBorder: ThemeColorPair
    chatProgressBarFill: ThemeColorPair
    contextCardBg: ThemeColorPair
    contextCardHoverBg: ThemeColorPair
    contextCardTitleText: ThemeColorPair
    contextCardMetaText: ThemeColorPair
    contextCardPathText: ThemeColorPair
    contextCardMutedText: ThemeColorPair
    contextCardBadgeBg: ThemeColorPair
    contextCardBadgeText: ThemeColorPair
    contextCardCodeBg: ThemeColorPair
    contextCardCodeText: ThemeColorPair
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
    markdownText: ThemeColorPair
    markdownMutedText: ThemeColorPair
    markdownHeadingText: ThemeColorPair
    markdownLinkText: ThemeColorPair
    markdownLinkHoverText: ThemeColorPair
    markdownListMarkerText: ThemeColorPair
    markdownHrBorder: ThemeColorPair
    markdownBlockquoteBg: ThemeColorPair
    markdownBlockquoteBorder: ThemeColorPair
    markdownBlockquoteText: ThemeColorPair
    markdownTableBorder: ThemeColorPair
    markdownTableHeaderBg: ThemeColorPair
    markdownTableHeaderText: ThemeColorPair
    markdownTableRowBorder: ThemeColorPair
    markdownCodeBlockBg: ThemeColorPair
    markdownCodeBlockBorder: ThemeColorPair
    markdownCodeBlockText: ThemeColorPair
    markdownCodeBlockHeaderBg: ThemeColorPair
    markdownCodeBlockHeaderText: ThemeColorPair
    markdownCodeCopyButtonBg: ThemeColorPair
    markdownCodeCopyButtonBorder: ThemeColorPair
    markdownCodeCopyButtonText: ThemeColorPair
    markdownCodeCopyButtonHoverBg: ThemeColorPair
    markdownInlineCodeBg: ThemeColorPair
    markdownInlineCodeText: ThemeColorPair
    markdownInlineCodeBorder: ThemeColorPair
    markdownMathText: ThemeColorPair
    markdownSyntaxBase: ThemeColorPair
    markdownSyntaxComment: ThemeColorPair
    markdownSyntaxKeyword: ThemeColorPair
    markdownSyntaxString: ThemeColorPair
    markdownSyntaxNumber: ThemeColorPair
    markdownSyntaxType: ThemeColorPair
    markdownSyntaxFunction: ThemeColorPair
    markdownSyntaxVariable: ThemeColorPair
    markdownSyntaxOperator: ThemeColorPair
    markdownSyntaxPunctuation: ThemeColorPair
    markdownSyntaxMeta: ThemeColorPair
    markdownSyntaxDeletion: ThemeColorPair
    markdownSyntaxAddition: ThemeColorPair
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
    thinScrollbarThumb: {
      light: 'transparent',
      dark: 'transparent',
    },
    thinScrollbarThumbHover: {
      light: '#c5c5c5',
      dark: '#262626',
    },
    thinScrollbarTrack: {
      light: 'transparent',
      dark: 'transparent',
    },
    thinScrollbarShadow: {
      light: 'rgba(90, 90, 90, 0.02)',
      dark: 'rgba(90, 90, 90, 0.02)',
    },
    settingsPaneBodyBg: {
      light: 'oklch(97% 0 0)',
      dark: 'oklch(18% 0 0)',
    },
    settingsCustomThemesCardBg: {
      light: 'rgba(255, 255, 255, 0.7)',
      dark: 'rgba(23, 23, 23, 0.2)',
    },
    settingsCustomThemesCardBorder: {
      light: 'rgba(229, 229, 229, 0.9)',
      dark: 'rgba(64, 64, 64, 0.9)',
    },
    settingsCustomThemesAccentBg: {
      light: '#ede9fe',
      dark: 'rgba(139, 92, 246, 0.15)',
    },
    settingsCustomThemesAccentText: {
      light: '#7c3aed',
      dark: '#c4b5fd',
    },
    settingsCustomThemesTitleText: {
      light: '#44403c',
      dark: '#e7e5e4',
    },
    settingsCustomThemesBodyText: {
      light: '#737373',
      dark: '#a3a3a3',
    },
    settingsCustomThemesCodeBg: {
      light: 'rgba(229, 229, 229, 0.7)',
      dark: '#262626',
    },
    settingsCustomThemesCodeText: {
      light: '#525252',
      dark: '#d4d4d8',
    },
    settingsCustomThemesPanelBorder: {
      light: 'rgba(229, 229, 229, 0.8)',
      dark: 'rgba(64, 64, 64, 0.8)',
    },
    settingsCustomThemesInnerCardBg: {
      light: 'rgba(250, 250, 250, 0.8)',
      dark: 'rgba(23, 23, 23, 0.3)',
    },
    settingsCustomThemesInnerCardBorder: {
      light: '#e5e5e5',
      dark: '#404040',
    },
    settingsCustomThemesBadgeBg: {
      light: 'rgba(229, 229, 229, 0.8)',
      dark: '#262626',
    },
    settingsCustomThemesBadgeText: {
      light: '#737373',
      dark: '#a3a3a3',
    },
    settingsCustomThemesButtonBg: {
      light: '#ffffff',
      dark: 'rgba(38, 38, 38, 0.8)',
    },
    settingsCustomThemesButtonBorder: {
      light: '#d4d4d4',
      dark: '#525252',
    },
    settingsCustomThemesButtonText: {
      light: '#404040',
      dark: '#e5e5e5',
    },
    settingsCustomThemesEmptyStateBg: {
      light: 'rgba(250, 250, 250, 0.8)',
      dark: 'rgba(23, 23, 23, 0.3)',
    },
    settingsCustomThemesEmptyStateBorder: {
      light: '#d4d4d4',
      dark: '#404040',
    },
    settingsCustomThemesListBg: {
      light: 'rgba(250, 250, 250, 0.7)',
      dark: 'rgba(10, 10, 10, 0.3)',
    },
    settingsCustomThemesListBorder: {
      light: '#e5e5e5',
      dark: '#404040',
    },
    settingsCustomThemesListItemTitleText: {
      light: '#171717',
      dark: '#f5f5f5',
    },
    settingsCustomThemesListItemMetaText: {
      light: '#737373',
      dark: '#a3a3a3',
    },
    settingsCustomThemesPrimaryButtonBg: {
      light: '#3b82f6',
      dark: '#2563eb',
    },
    settingsCustomThemesPrimaryButtonText: {
      light: '#ffffff',
      dark: '#ffffff',
    },
    chatInputAreaBorder: {
      light: 'rgba(194, 65, 12, 0.7)',
      dark: 'rgba(194, 65, 12, 0.7)',
    },
    chatProgressBarFill: {
      light: '#3b82f6',
      dark: '#60a5fa',
    },
    contextCardBg: {
      light: '#ede9fe',
      dark: 'rgba(139, 92, 246, 0.15)',
    },
    contextCardHoverBg: {
      light: 'rgba(229, 229, 229, 0.8)',
      dark: '#262626',
    },
    contextCardTitleText: {
      light: '#7c3aed',
      dark: '#c4b5fd',
    },
    contextCardMetaText: {
      light: '#7c3aed',
      dark: '#c4b5fd',
    },
    contextCardPathText: {
      light: '#44403c',
      dark: '#e7e5e4',
    },
    contextCardMutedText: {
      light: '#737373',
      dark: '#a3a3a3',
    },
    contextCardBadgeBg: {
      light: 'rgba(229, 229, 229, 0.8)',
      dark: '#262626',
    },
    contextCardBadgeText: {
      light: '#7c3aed',
      dark: '#c4b5fd',
    },
    contextCardCodeBg: {
      light: 'rgba(229, 229, 229, 0.7)',
      dark: '#262626',
    },
    contextCardCodeText: {
      light: '#525252',
      dark: '#d4d4d8',
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
      light: '#3b82f6',
      dark: '#f97316',
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
    markdownText: {
      light: '#27272a',
      dark: '#e7e5e4',
    },
    markdownMutedText: {
      light: '#64748b',
      dark: '#a8a29e',
    },
    markdownHeadingText: {
      light: '#1f2937',
      dark: '#f5f5f4',
    },
    markdownLinkText: {
      light: '#2563eb',
      dark: '#f59e0b',
    },
    markdownLinkHoverText: {
      light: '#1d4ed8',
      dark: '#fbbf24',
    },
    markdownListMarkerText: {
      light: '#60a5fa',
      dark: '#d6d3d1',
    },
    markdownHrBorder: {
      light: 'rgba(100, 116, 139, 0.22)',
      dark: 'rgba(168, 162, 158, 0.22)',
    },
    markdownBlockquoteBg: {
      light: 'rgba(241, 245, 249, 0.9)',
      dark: 'rgba(41, 37, 36, 0.72)',
    },
    markdownBlockquoteBorder: {
      light: '#93c5fd',
      dark: '#f59e0b',
    },
    markdownBlockquoteText: {
      light: '#334155',
      dark: '#e7e5e4',
    },
    markdownTableBorder: {
      light: 'rgba(148, 163, 184, 0.32)',
      dark: 'rgba(120, 113, 108, 0.42)',
    },
    markdownTableHeaderBg: {
      light: 'rgba(248, 250, 252, 0.95)',
      dark: 'rgba(28, 25, 23, 0.86)',
    },
    markdownTableHeaderText: {
      light: '#1f2937',
      dark: '#f5f5f4',
    },
    markdownTableRowBorder: {
      light: 'rgba(203, 213, 225, 0.42)',
      dark: 'rgba(87, 83, 78, 0.42)',
    },
    markdownCodeBlockBg: {
      light: '#f8fafc',
      dark: '#171312',
    },
    markdownCodeBlockBorder: {
      light: 'rgba(148, 163, 184, 0.34)',
      dark: 'rgba(120, 113, 108, 0.42)',
    },
    markdownCodeBlockText: {
      light: '#1f2937',
      dark: '#f5f5f4',
    },
    markdownCodeBlockHeaderBg: {
      light: 'rgba(226, 232, 240, 0.72)',
      dark: 'rgba(41, 37, 36, 0.76)',
    },
    markdownCodeBlockHeaderText: {
      light: '#475569',
      dark: '#d6d3d1',
    },
    markdownCodeCopyButtonBg: {
      light: 'rgba(255, 255, 255, 0.88)',
      dark: 'rgba(68, 64, 60, 0.72)',
    },
    markdownCodeCopyButtonBorder: {
      light: 'rgba(148, 163, 184, 0.4)',
      dark: 'rgba(168, 162, 158, 0.24)',
    },
    markdownCodeCopyButtonText: {
      light: '#334155',
      dark: '#f5f5f4',
    },
    markdownCodeCopyButtonHoverBg: {
      light: 'rgba(219, 234, 254, 0.85)',
      dark: 'rgba(120, 53, 15, 0.34)',
    },
    markdownInlineCodeBg: {
      light: 'rgba(226, 232, 240, 0.85)',
      dark: 'rgba(68, 64, 60, 0.72)',
    },
    markdownInlineCodeText: {
      light: '#1d4ed8',
      dark: '#fbbf24',
    },
    markdownInlineCodeBorder: {
      light: 'rgba(148, 163, 184, 0.36)',
      dark: 'rgba(168, 162, 158, 0.24)',
    },
    markdownMathText: {
      light: '#2563eb',
      dark: '#f59e0b',
    },
    markdownSyntaxBase: {
      light: '#334155',
      dark: '#e7e5e4',
    },
    markdownSyntaxComment: {
      light: '#94a3b8',
      dark: '#78716c',
    },
    markdownSyntaxKeyword: {
      light: '#2563eb',
      dark: '#f59e0b',
    },
    markdownSyntaxString: {
      light: '#1e40af',
      dark: '#86efac',
    },
    markdownSyntaxNumber: {
      light: '#4f46e5',
      dark: '#c4b5fd',
    },
    markdownSyntaxType: {
      light: '#3b82f6',
      dark: '#fdba74',
    },
    markdownSyntaxFunction: {
      light: '#0284c7',
      dark: '#93c5fd',
    },
    markdownSyntaxVariable: {
      light: '#be123c',
      dark: '#fda4af',
    },
    markdownSyntaxOperator: {
      light: '#64748b',
      dark: '#d6d3d1',
    },
    markdownSyntaxPunctuation: {
      light: '#475569',
      dark: '#a8a29e',
    },
    markdownSyntaxMeta: {
      light: '#2563eb',
      dark: '#fbbf24',
    },
    markdownSyntaxDeletion: {
      light: '#dc2626',
      dark: '#f87171',
    },
    markdownSyntaxAddition: {
      light: '#2563eb',
      dark: '#86efac',
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
        visibleFill: { light: '#dbeafe', dark: 'rgba(249, 115, 22, 0.2)' },
        stroke: { light: '#d4d4d4', dark: '#262626' },
        visibleStroke: { light: '#34d399', dark: '#f97316' },
      },
      assistant: {
        fill: { light: '#f1f5f9', dark: '#171717' },
        visibleFill: { light: '#dbeafe', dark: 'rgba(249, 115, 22, 0.2)' },
        stroke: { light: '#e5e5e5', dark: '#262626' },
        visibleStroke: { light: '#34d399', dark: '#f97316' },
      },
      ex_agent: {
        fill: { light: '#f8fafc', dark: '#0a0a0a' },
        visibleFill: { light: '#dbeafe', dark: 'rgba(249, 115, 22, 0.2)' },
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
  // Loaded-context card colours: a saved theme written before these keys existed
  // derives them from its own palette, so the card matches the theme without edits.
  const contextCardFallbacks = {
    contextCardBg: readColorPair(rawColors.settingsCustomThemesAccentBg, defaults.colors.settingsCustomThemesAccentBg),
    contextCardHoverBg: readColorPair(rawColors.settingsCustomThemesBadgeBg, defaults.colors.settingsCustomThemesBadgeBg),
    contextCardTitleText: readColorPair(rawColors.settingsCustomThemesAccentText, defaults.colors.settingsCustomThemesAccentText),
    contextCardMetaText: readColorPair(rawColors.settingsCustomThemesAccentText, defaults.colors.settingsCustomThemesAccentText),
    contextCardPathText: readColorPair(rawColors.settingsCustomThemesTitleText, defaults.colors.settingsCustomThemesTitleText),
    contextCardMutedText: readColorPair(rawColors.settingsCustomThemesBodyText, defaults.colors.settingsCustomThemesBodyText),
    contextCardBadgeBg: readColorPair(rawColors.settingsCustomThemesBadgeBg, defaults.colors.settingsCustomThemesBadgeBg),
    contextCardBadgeText: readColorPair(rawColors.settingsCustomThemesAccentText, defaults.colors.settingsCustomThemesAccentText),
    contextCardCodeBg: readColorPair(rawColors.settingsCustomThemesCodeBg, defaults.colors.settingsCustomThemesCodeBg),
    contextCardCodeText: readColorPair(rawColors.settingsCustomThemesCodeText, defaults.colors.settingsCustomThemesCodeText),
  }

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
        visibleFill: readColorPair(rawNodeTheme.visibleFill, fallback.visibleFill),
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
      thinScrollbarThumb: readColorPair(rawColors.thinScrollbarThumb, defaults.colors.thinScrollbarThumb),
      thinScrollbarThumbHover: readColorPair(
        rawColors.thinScrollbarThumbHover,
        defaults.colors.thinScrollbarThumbHover
      ),
      thinScrollbarTrack: readColorPair(rawColors.thinScrollbarTrack, defaults.colors.thinScrollbarTrack),
      thinScrollbarShadow: readColorPair(rawColors.thinScrollbarShadow, defaults.colors.thinScrollbarShadow),
      settingsPaneBodyBg: readColorPair(rawColors.settingsPaneBodyBg, defaults.colors.settingsPaneBodyBg),
      settingsCustomThemesCardBg: readColorPair(
        rawColors.settingsCustomThemesCardBg,
        defaults.colors.settingsCustomThemesCardBg
      ),
      settingsCustomThemesCardBorder: readColorPair(
        rawColors.settingsCustomThemesCardBorder,
        defaults.colors.settingsCustomThemesCardBorder
      ),
      settingsCustomThemesAccentBg: readColorPair(
        rawColors.settingsCustomThemesAccentBg,
        defaults.colors.settingsCustomThemesAccentBg
      ),
      settingsCustomThemesAccentText: readColorPair(
        rawColors.settingsCustomThemesAccentText,
        defaults.colors.settingsCustomThemesAccentText
      ),
      settingsCustomThemesTitleText: readColorPair(
        rawColors.settingsCustomThemesTitleText,
        defaults.colors.settingsCustomThemesTitleText
      ),
      settingsCustomThemesBodyText: readColorPair(
        rawColors.settingsCustomThemesBodyText,
        defaults.colors.settingsCustomThemesBodyText
      ),
      settingsCustomThemesCodeBg: readColorPair(
        rawColors.settingsCustomThemesCodeBg,
        defaults.colors.settingsCustomThemesCodeBg
      ),
      settingsCustomThemesCodeText: readColorPair(
        rawColors.settingsCustomThemesCodeText,
        defaults.colors.settingsCustomThemesCodeText
      ),
      settingsCustomThemesPanelBorder: readColorPair(
        rawColors.settingsCustomThemesPanelBorder,
        defaults.colors.settingsCustomThemesPanelBorder
      ),
      settingsCustomThemesInnerCardBg: readColorPair(
        rawColors.settingsCustomThemesInnerCardBg,
        defaults.colors.settingsCustomThemesInnerCardBg
      ),
      settingsCustomThemesInnerCardBorder: readColorPair(
        rawColors.settingsCustomThemesInnerCardBorder,
        defaults.colors.settingsCustomThemesInnerCardBorder
      ),
      settingsCustomThemesBadgeBg: readColorPair(
        rawColors.settingsCustomThemesBadgeBg,
        defaults.colors.settingsCustomThemesBadgeBg
      ),
      settingsCustomThemesBadgeText: readColorPair(
        rawColors.settingsCustomThemesBadgeText,
        defaults.colors.settingsCustomThemesBadgeText
      ),
      settingsCustomThemesButtonBg: readColorPair(
        rawColors.settingsCustomThemesButtonBg,
        defaults.colors.settingsCustomThemesButtonBg
      ),
      settingsCustomThemesButtonBorder: readColorPair(
        rawColors.settingsCustomThemesButtonBorder,
        defaults.colors.settingsCustomThemesButtonBorder
      ),
      settingsCustomThemesButtonText: readColorPair(
        rawColors.settingsCustomThemesButtonText,
        defaults.colors.settingsCustomThemesButtonText
      ),
      settingsCustomThemesEmptyStateBg: readColorPair(
        rawColors.settingsCustomThemesEmptyStateBg,
        defaults.colors.settingsCustomThemesEmptyStateBg
      ),
      settingsCustomThemesEmptyStateBorder: readColorPair(
        rawColors.settingsCustomThemesEmptyStateBorder,
        defaults.colors.settingsCustomThemesEmptyStateBorder
      ),
      settingsCustomThemesListBg: readColorPair(
        rawColors.settingsCustomThemesListBg,
        defaults.colors.settingsCustomThemesListBg
      ),
      settingsCustomThemesListBorder: readColorPair(
        rawColors.settingsCustomThemesListBorder,
        defaults.colors.settingsCustomThemesListBorder
      ),
      settingsCustomThemesListItemTitleText: readColorPair(
        rawColors.settingsCustomThemesListItemTitleText,
        defaults.colors.settingsCustomThemesListItemTitleText
      ),
      settingsCustomThemesListItemMetaText: readColorPair(
        rawColors.settingsCustomThemesListItemMetaText,
        defaults.colors.settingsCustomThemesListItemMetaText
      ),
      settingsCustomThemesPrimaryButtonBg: readColorPair(
        rawColors.settingsCustomThemesPrimaryButtonBg,
        defaults.colors.settingsCustomThemesPrimaryButtonBg
      ),
      settingsCustomThemesPrimaryButtonText: readColorPair(
        rawColors.settingsCustomThemesPrimaryButtonText,
        defaults.colors.settingsCustomThemesPrimaryButtonText
      ),
      chatInputAreaBorder: readColorPair(rawColors.chatInputAreaBorder, defaults.colors.chatInputAreaBorder),
      chatProgressBarFill: readColorPair(rawColors.chatProgressBarFill, defaults.colors.chatProgressBarFill),
      contextCardBg: readColorPair(rawColors.contextCardBg, contextCardFallbacks.contextCardBg),
      contextCardHoverBg: readColorPair(rawColors.contextCardHoverBg, contextCardFallbacks.contextCardHoverBg),
      contextCardTitleText: readColorPair(rawColors.contextCardTitleText, contextCardFallbacks.contextCardTitleText),
      contextCardMetaText: readColorPair(rawColors.contextCardMetaText, contextCardFallbacks.contextCardMetaText),
      contextCardPathText: readColorPair(rawColors.contextCardPathText, contextCardFallbacks.contextCardPathText),
      contextCardMutedText: readColorPair(rawColors.contextCardMutedText, contextCardFallbacks.contextCardMutedText),
      contextCardBadgeBg: readColorPair(rawColors.contextCardBadgeBg, contextCardFallbacks.contextCardBadgeBg),
      contextCardBadgeText: readColorPair(rawColors.contextCardBadgeText, contextCardFallbacks.contextCardBadgeText),
      contextCardCodeBg: readColorPair(rawColors.contextCardCodeBg, contextCardFallbacks.contextCardCodeBg),
      contextCardCodeText: readColorPair(rawColors.contextCardCodeText, contextCardFallbacks.contextCardCodeText),
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
      markdownText: readColorPair(rawColors.markdownText, defaults.colors.markdownText),
      markdownMutedText: readColorPair(rawColors.markdownMutedText, defaults.colors.markdownMutedText),
      markdownHeadingText: readColorPair(rawColors.markdownHeadingText, defaults.colors.markdownHeadingText),
      markdownLinkText: readColorPair(rawColors.markdownLinkText, defaults.colors.markdownLinkText),
      markdownLinkHoverText: readColorPair(
        rawColors.markdownLinkHoverText,
        defaults.colors.markdownLinkHoverText
      ),
      markdownListMarkerText: readColorPair(
        rawColors.markdownListMarkerText,
        defaults.colors.markdownListMarkerText
      ),
      markdownHrBorder: readColorPair(rawColors.markdownHrBorder, defaults.colors.markdownHrBorder),
      markdownBlockquoteBg: readColorPair(rawColors.markdownBlockquoteBg, defaults.colors.markdownBlockquoteBg),
      markdownBlockquoteBorder: readColorPair(
        rawColors.markdownBlockquoteBorder,
        defaults.colors.markdownBlockquoteBorder
      ),
      markdownBlockquoteText: readColorPair(
        rawColors.markdownBlockquoteText,
        defaults.colors.markdownBlockquoteText
      ),
      markdownTableBorder: readColorPair(rawColors.markdownTableBorder, defaults.colors.markdownTableBorder),
      markdownTableHeaderBg: readColorPair(
        rawColors.markdownTableHeaderBg,
        defaults.colors.markdownTableHeaderBg
      ),
      markdownTableHeaderText: readColorPair(
        rawColors.markdownTableHeaderText,
        defaults.colors.markdownTableHeaderText
      ),
      markdownTableRowBorder: readColorPair(
        rawColors.markdownTableRowBorder,
        defaults.colors.markdownTableRowBorder
      ),
      markdownCodeBlockBg: readColorPair(rawColors.markdownCodeBlockBg, defaults.colors.markdownCodeBlockBg),
      markdownCodeBlockBorder: readColorPair(
        rawColors.markdownCodeBlockBorder,
        defaults.colors.markdownCodeBlockBorder
      ),
      markdownCodeBlockText: readColorPair(rawColors.markdownCodeBlockText, defaults.colors.markdownCodeBlockText),
      markdownCodeBlockHeaderBg: readColorPair(
        rawColors.markdownCodeBlockHeaderBg,
        defaults.colors.markdownCodeBlockHeaderBg
      ),
      markdownCodeBlockHeaderText: readColorPair(
        rawColors.markdownCodeBlockHeaderText,
        defaults.colors.markdownCodeBlockHeaderText
      ),
      markdownCodeCopyButtonBg: readColorPair(
        rawColors.markdownCodeCopyButtonBg,
        defaults.colors.markdownCodeCopyButtonBg
      ),
      markdownCodeCopyButtonBorder: readColorPair(
        rawColors.markdownCodeCopyButtonBorder,
        defaults.colors.markdownCodeCopyButtonBorder
      ),
      markdownCodeCopyButtonText: readColorPair(
        rawColors.markdownCodeCopyButtonText,
        defaults.colors.markdownCodeCopyButtonText
      ),
      markdownCodeCopyButtonHoverBg: readColorPair(
        rawColors.markdownCodeCopyButtonHoverBg,
        defaults.colors.markdownCodeCopyButtonHoverBg
      ),
      markdownInlineCodeBg: readColorPair(rawColors.markdownInlineCodeBg, defaults.colors.markdownInlineCodeBg),
      markdownInlineCodeText: readColorPair(
        rawColors.markdownInlineCodeText,
        defaults.colors.markdownInlineCodeText
      ),
      markdownInlineCodeBorder: readColorPair(
        rawColors.markdownInlineCodeBorder,
        defaults.colors.markdownInlineCodeBorder
      ),
      markdownMathText: readColorPair(rawColors.markdownMathText, defaults.colors.markdownMathText),
      markdownSyntaxBase: readColorPair(rawColors.markdownSyntaxBase, defaults.colors.markdownSyntaxBase),
      markdownSyntaxComment: readColorPair(rawColors.markdownSyntaxComment, defaults.colors.markdownSyntaxComment),
      markdownSyntaxKeyword: readColorPair(rawColors.markdownSyntaxKeyword, defaults.colors.markdownSyntaxKeyword),
      markdownSyntaxString: readColorPair(rawColors.markdownSyntaxString, defaults.colors.markdownSyntaxString),
      markdownSyntaxNumber: readColorPair(rawColors.markdownSyntaxNumber, defaults.colors.markdownSyntaxNumber),
      markdownSyntaxType: readColorPair(rawColors.markdownSyntaxType, defaults.colors.markdownSyntaxType),
      markdownSyntaxFunction: readColorPair(rawColors.markdownSyntaxFunction, defaults.colors.markdownSyntaxFunction),
      markdownSyntaxVariable: readColorPair(rawColors.markdownSyntaxVariable, defaults.colors.markdownSyntaxVariable),
      markdownSyntaxOperator: readColorPair(rawColors.markdownSyntaxOperator, defaults.colors.markdownSyntaxOperator),
      markdownSyntaxPunctuation: readColorPair(
        rawColors.markdownSyntaxPunctuation,
        defaults.colors.markdownSyntaxPunctuation
      ),
      markdownSyntaxMeta: readColorPair(rawColors.markdownSyntaxMeta, defaults.colors.markdownSyntaxMeta),
      markdownSyntaxDeletion: readColorPair(rawColors.markdownSyntaxDeletion, defaults.colors.markdownSyntaxDeletion),
      markdownSyntaxAddition: readColorPair(rawColors.markdownSyntaxAddition, defaults.colors.markdownSyntaxAddition),
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

type MarkdownThemeCssVariable =
  | '--thin-scrollbar-thumb'
  | '--thin-scrollbar-thumb-hover'
  | '--thin-scrollbar-track'
  | '--thin-scrollbar-shadow'
  | '--chat-md-text'
  | '--chat-md-muted-text'
  | '--chat-md-heading-text'
  | '--chat-md-link-text'
  | '--chat-md-link-hover-text'
  | '--chat-md-list-marker-text'
  | '--chat-md-hr-border'
  | '--chat-md-blockquote-bg'
  | '--chat-md-blockquote-border'
  | '--chat-md-blockquote-text'
  | '--chat-md-table-border'
  | '--chat-md-table-header-bg'
  | '--chat-md-table-header-text'
  | '--chat-md-table-row-border'
  | '--chat-md-code-block-bg'
  | '--chat-md-code-block-border'
  | '--chat-md-code-block-text'
  | '--chat-md-code-block-header-bg'
  | '--chat-md-code-block-header-text'
  | '--chat-md-code-copy-button-bg'
  | '--chat-md-code-copy-button-border'
  | '--chat-md-code-copy-button-text'
  | '--chat-md-code-copy-button-hover-bg'
  | '--chat-md-inline-code-bg'
  | '--chat-md-inline-code-text'
  | '--chat-md-inline-code-border'
  | '--chat-md-math-text'
  | '--chat-md-syntax-base'
  | '--chat-md-syntax-comment'
  | '--chat-md-syntax-keyword'
  | '--chat-md-syntax-string'
  | '--chat-md-syntax-number'
  | '--chat-md-syntax-type'
  | '--chat-md-syntax-function'
  | '--chat-md-syntax-variable'
  | '--chat-md-syntax-operator'
  | '--chat-md-syntax-punctuation'
  | '--chat-md-syntax-meta'
  | '--chat-md-syntax-deletion'
  | '--chat-md-syntax-addition'

export type MarkdownThemeCssProperties = CSSProperties & Partial<Record<MarkdownThemeCssVariable, string>>

export const getMarkdownThemeVars = (theme: CustomChatTheme, isDarkMode: boolean): MarkdownThemeCssProperties => {
  const colors = theme.colors
  return {
    '--thin-scrollbar-thumb': getThemeModeColor(colors.thinScrollbarThumb, isDarkMode),
    '--thin-scrollbar-thumb-hover': getThemeModeColor(colors.thinScrollbarThumbHover, isDarkMode),
    '--thin-scrollbar-track': getThemeModeColor(colors.thinScrollbarTrack, isDarkMode),
    '--thin-scrollbar-shadow': getThemeModeColor(colors.thinScrollbarShadow, isDarkMode),
    '--chat-md-text': getThemeModeColor(colors.markdownText, isDarkMode),
    '--chat-md-muted-text': getThemeModeColor(colors.markdownMutedText, isDarkMode),
    '--chat-md-heading-text': getThemeModeColor(colors.markdownHeadingText, isDarkMode),
    '--chat-md-link-text': getThemeModeColor(colors.markdownLinkText, isDarkMode),
    '--chat-md-link-hover-text': getThemeModeColor(colors.markdownLinkHoverText, isDarkMode),
    '--chat-md-list-marker-text': getThemeModeColor(colors.markdownListMarkerText, isDarkMode),
    '--chat-md-hr-border': getThemeModeColor(colors.markdownHrBorder, isDarkMode),
    '--chat-md-blockquote-bg': getThemeModeColor(colors.markdownBlockquoteBg, isDarkMode),
    '--chat-md-blockquote-border': getThemeModeColor(colors.markdownBlockquoteBorder, isDarkMode),
    '--chat-md-blockquote-text': getThemeModeColor(colors.markdownBlockquoteText, isDarkMode),
    '--chat-md-table-border': getThemeModeColor(colors.markdownTableBorder, isDarkMode),
    '--chat-md-table-header-bg': getThemeModeColor(colors.markdownTableHeaderBg, isDarkMode),
    '--chat-md-table-header-text': getThemeModeColor(colors.markdownTableHeaderText, isDarkMode),
    '--chat-md-table-row-border': getThemeModeColor(colors.markdownTableRowBorder, isDarkMode),
    '--chat-md-code-block-bg': getThemeModeColor(colors.markdownCodeBlockBg, isDarkMode),
    '--chat-md-code-block-border': getThemeModeColor(colors.markdownCodeBlockBorder, isDarkMode),
    '--chat-md-code-block-text': getThemeModeColor(colors.markdownCodeBlockText, isDarkMode),
    '--chat-md-code-block-header-bg': getThemeModeColor(colors.markdownCodeBlockHeaderBg, isDarkMode),
    '--chat-md-code-block-header-text': getThemeModeColor(colors.markdownCodeBlockHeaderText, isDarkMode),
    '--chat-md-code-copy-button-bg': getThemeModeColor(colors.markdownCodeCopyButtonBg, isDarkMode),
    '--chat-md-code-copy-button-border': getThemeModeColor(colors.markdownCodeCopyButtonBorder, isDarkMode),
    '--chat-md-code-copy-button-text': getThemeModeColor(colors.markdownCodeCopyButtonText, isDarkMode),
    '--chat-md-code-copy-button-hover-bg': getThemeModeColor(colors.markdownCodeCopyButtonHoverBg, isDarkMode),
    '--chat-md-inline-code-bg': getThemeModeColor(colors.markdownInlineCodeBg, isDarkMode),
    '--chat-md-inline-code-text': getThemeModeColor(colors.markdownInlineCodeText, isDarkMode),
    '--chat-md-inline-code-border': getThemeModeColor(colors.markdownInlineCodeBorder, isDarkMode),
    '--chat-md-math-text': getThemeModeColor(colors.markdownMathText, isDarkMode),
    '--chat-md-syntax-base': getThemeModeColor(colors.markdownSyntaxBase, isDarkMode),
    '--chat-md-syntax-comment': getThemeModeColor(colors.markdownSyntaxComment, isDarkMode),
    '--chat-md-syntax-keyword': getThemeModeColor(colors.markdownSyntaxKeyword, isDarkMode),
    '--chat-md-syntax-string': getThemeModeColor(colors.markdownSyntaxString, isDarkMode),
    '--chat-md-syntax-number': getThemeModeColor(colors.markdownSyntaxNumber, isDarkMode),
    '--chat-md-syntax-type': getThemeModeColor(colors.markdownSyntaxType, isDarkMode),
    '--chat-md-syntax-function': getThemeModeColor(colors.markdownSyntaxFunction, isDarkMode),
    '--chat-md-syntax-variable': getThemeModeColor(colors.markdownSyntaxVariable, isDarkMode),
    '--chat-md-syntax-operator': getThemeModeColor(colors.markdownSyntaxOperator, isDarkMode),
    '--chat-md-syntax-punctuation': getThemeModeColor(colors.markdownSyntaxPunctuation, isDarkMode),
    '--chat-md-syntax-meta': getThemeModeColor(colors.markdownSyntaxMeta, isDarkMode),
    '--chat-md-syntax-deletion': getThemeModeColor(colors.markdownSyntaxDeletion, isDarkMode),
    '--chat-md-syntax-addition': getThemeModeColor(colors.markdownSyntaxAddition, isDarkMode),
  }
}

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
