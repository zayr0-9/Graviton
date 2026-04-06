import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

export type SettingsSectionThemeColors = {
  cardBg: string
  cardBorder: string
  accentBg: string
  accentText: string
  titleText: string
  bodyText: string
  codeBg: string
  codeText: string
  panelBorder: string
  innerCardBg: string
  innerCardBorder: string
  badgeBg: string
  badgeText: string
  buttonBg: string
  buttonBorder: string
  buttonText: string
  emptyStateBg: string
  emptyStateBorder: string
  listBg: string
  listBorder: string
  listItemTitleText: string
  listItemMetaText: string
  primaryButtonBg: string
  primaryButtonText: string
}

export const useSettingsSectionThemeColors = (): SettingsSectionThemeColors | null => {
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  return customThemeEnabled
    ? {
        cardBg: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        cardBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBorder, isDarkMode),
        accentBg: getThemeModeColor(customTheme.colors.settingsCustomThemesAccentBg, isDarkMode),
        accentText: getThemeModeColor(customTheme.colors.settingsCustomThemesAccentText, isDarkMode),
        titleText: getThemeModeColor(customTheme.colors.settingsCustomThemesTitleText, isDarkMode),
        bodyText: getThemeModeColor(customTheme.colors.settingsCustomThemesBodyText, isDarkMode),
        codeBg: getThemeModeColor(customTheme.colors.settingsCustomThemesCodeBg, isDarkMode),
        codeText: getThemeModeColor(customTheme.colors.settingsCustomThemesCodeText, isDarkMode),
        panelBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesPanelBorder, isDarkMode),
        innerCardBg: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
        innerCardBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBorder, isDarkMode),
        badgeBg: getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeBg, isDarkMode),
        badgeText: getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeText, isDarkMode),
        buttonBg: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
        buttonBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBorder, isDarkMode),
        buttonText: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
        emptyStateBg: getThemeModeColor(customTheme.colors.settingsCustomThemesEmptyStateBg, isDarkMode),
        emptyStateBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesEmptyStateBorder, isDarkMode),
        listBg: getThemeModeColor(customTheme.colors.settingsCustomThemesListBg, isDarkMode),
        listBorder: getThemeModeColor(customTheme.colors.settingsCustomThemesListBorder, isDarkMode),
        listItemTitleText: getThemeModeColor(customTheme.colors.settingsCustomThemesListItemTitleText, isDarkMode),
        listItemMetaText: getThemeModeColor(customTheme.colors.settingsCustomThemesListItemMetaText, isDarkMode),
        primaryButtonBg: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonBg, isDarkMode),
        primaryButtonText: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonText, isDarkMode),
      }
    : null
}
