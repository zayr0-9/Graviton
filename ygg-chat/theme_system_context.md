# Theme System Context (Custom Chat Theme)

This document explains how the custom theme system works end-to-end, where state lives, which files matter, and exactly what to update when extending it.

## 1) Quick mental model

The theme system has **two persistence layers** and **one runtime layer**:

1. **Runtime/UI layer (React):**
   - `useCustomChatTheme()` reads current theme + enabled flag.
   - Components call `getThemeModeColor(pair, isDarkMode)` to pick light/dark value.

2. **Browser persistence (localStorage):**
   - Current active theme JSON is stored in `chat:customTheme`.
   - Enabled toggle is stored in `chat:customThemeEnabled`.

3. **File library persistence (.ygg/custom-themes):**
   - Managed by built-in tool `theme_manager` (Electron side).
   - Lets users/agents save/load named theme JSON files.

---

## 2) Core files and responsibilities

## 2.1 Frontend theme model + hooks
- `client/ygg-chat-r/src/components/ThemeManager/themeConfig.ts`

This is the frontend source for:
- Theme types (`CustomChatTheme`, `ThemeColorPair`, role/node subtypes)
- Default theme factory: `createDefaultCustomChatTheme()`
- Sanitization: `sanitizeCustomTheme()`
- Persistence helpers:
  - `getStoredCustomChatTheme()` / `saveCustomChatTheme()`
  - `getCustomChatThemeEnabled()` / `setCustomChatThemeEnabled()`
- Hooks:
  - `useCustomChatTheme()`
  - `useHtmlDarkMode()`

Important localStorage/event constants:
- `CHAT_CUSTOM_THEME_STORAGE_KEY = 'chat:customTheme'`
- `CHAT_CUSTOM_THEME_ENABLED_STORAGE_KEY = 'chat:customThemeEnabled'`
- `CHAT_CUSTOM_THEME_CHANGE_EVENT = 'chatCustomThemeChange'`

`useCustomChatTheme()` sync strategy:
- listens to custom event for same-window updates
- listens to `storage` for cross-tab/window updates

## 2.2 Theme editor UI
- `client/ygg-chat-r/src/components/ThemeManager/ThemeManager.tsx`

Provides UI to:
- Toggle enabled on/off
- Edit all color pairs
- Edit message role and Heimdall node colors
- Import/export JSON
- Reset defaults

Behavioral detail:
- Any edit auto-enables custom theme (`setCustomChatThemeEnabled(true)`).
- Import sanitizes before save.

## 2.3 Settings pane integration (saved theme library)
- `client/ygg-chat-r/src/components/SettingsPane/SettingsPane.tsx`

Adds:
- `<ThemeManager />` editor section
- “Saved custom themes” section that calls `theme_manager` tool via `localApi.post('/tools/execute', ...)`
  - list: `{ action: 'list' }`
  - read/apply: `{ action: 'read', name: themeId }`

Apply flow:
- Read file theme -> `saveCustomChatTheme(result.theme)` -> `setCustomChatThemeEnabled(true)`

## 2.4 Electron theme file tool (`theme_manager`)
- `client/ygg-chat-r/electron/tools/themeManager.ts`

Supports actions:
- `template`
- `list`
- `read`
- `save`
- `delete`

Filesystem behavior:
- Managed dir: `<userData>/.ygg/custom-themes`
- Bundled template dir copied into managed dir if missing files
- Env overrides supported:
  - `YGG_THEME_DIRECTORY`
  - `YGG_THEME_TEMPLATE_DIRECTORY`

Tool registration:
- `client/ygg-chat-r/electron/localServer.ts` registers `theme_manager` in built-in tools.
- Also exposed in shared tool schema:
  - `shared/builtinToolDefinitions.ts`

---

## 3) Where theme values are consumed

Current notable consumers:
- `src/containers/Chat.tsx`
  - chat panel background
  - conversation toolbar background
  - chat input border
  - progress bar fill
  - action popover border (for inline controls)
  - send button animation color
  - streaming animation color
  - composer active toggle styling (Allow all + Agent buttons)
- `src/components/ActionPopover/ActionPopover.tsx`
  - border colors
- `src/components/ChatMessage/ChatMessage.tsx`
  - per-role message styling (`messageRoles`)
  - markdown code block + inline code surfaces (`markdownCodeBlock*`, `markdownInlineCode*`)
- `src/components/Heimdall/Heimdall.tsx`
  - panel background
  - node colors (`heimdallNodes`)
  - note pill bg/text/border
  - node hover preview modal surface/text colors
  - edit-note modal surface/title/button/close colors
- `src/components/VideoBackground.tsx`
  - app solid background color
- `src/containers/Settings.tsx`
  - settings section background and solid color background editing behavior
- `src/components/SettingsPane/SettingsPane.tsx`
  - settings pane body background
- `src/components/HtmlToolsModal/HtmlToolsModal.tsx`
  - Task Manager modal surface, panel, and button colors
- `src/containers/Chat.tsx`
  - OpenRouter and OpenAI auth modal backdrop/surface/text/button colors
- `src/components/InputTextArea/InputTextArea.tsx`
  - IDE context detected pill, add button, selected context pills, clear button
  - IDE context hover preview modal background/border/file text/code text
- `src/components/ToolJobsModal/ToolJobsModal.tsx`
  - modal/backdrop/panel surfaces
  - status badges, progress bar track/fill colors
  - code blocks + error sections
- `src/components/ToolPermissionDialog/ToolPermissionDialog.tsx`
  - permission prompt surface + border
  - header/tool badge/command preview text and surface colors
  - deny / allow once / always allow button background, border, and text colors

---

## 4) Schema details and invariants

`CustomChatTheme` is `version: 1` with a fixed `colors` shape.

Sanitization is **lenient + fallback based**:
- Missing keys are filled from defaults.
- Invalid/empty strings fallback to defaults.
- Unknown extra keys are ignored.

Naming/id behavior when saving files:
- filename slug is normalized from `name` (or explicit `name` arg)
- `.json` extension enforced
- slugs are lowercase kebab-like and must contain alphanumeric chars

---

## 5) Critical maintenance rule (easy to miss)

The default/sanitize schema logic is duplicated in **two places**:

1. Frontend: `src/components/ThemeManager/themeConfig.ts`
2. Electron tool: `electron/tools/themeManager.ts`

When adding/changing theme fields, update both files in lockstep.
If they drift, imported/saved themes can behave differently between UI and tool operations.

---

## 6) Known gaps / gotchas

1. **`chatMessageListBg` is defined but currently not directly consumed in render paths**
   (ThemeManager currently edits it in tandem with `chatPanelBg`).

2. **Coverage is currently minimal for theme system behavior**
   - Existing test coverage is mainly `electron/tools/__tests__/themeManager.test.ts`
   - Frontend hook/state synchronization and component color application are mostly untested.

3. Theme updates rely on localStorage + DOM custom events; race conditions are possible if tests don’t assert event-driven sync.

4. Markdown syntax token colors (highlight.js token palette) are still largely CSS-driven (`index.css` + highlight.js theme). Current theme tokens cover markdown code surfaces/text, but not full per-token syntax palette yet.

---

## 7) How to add a new theme token safely

Example: add `sidebarBorderColor`.

1. Update frontend schema/types/default/sanitize:
   - `themeConfig.ts`
2. Update electron tool schema/default/sanitize:
   - `electron/tools/themeManager.ts`
3. Add UI editor control in `ThemeManager.tsx` (optional but typical).
4. Apply token in consuming component(s).
5. Ensure fallback behavior when theme disabled.
6. Add tests (frontend + electron tool).

---

## 8) Recommended coverage expansion plan

## 8.1 Frontend unit tests (new)
Target: `themeConfig.ts`
- `sanitizeCustomTheme()`
  - partial input fills defaults
  - invalid shapes fallback
  - role/node nested fallback behavior
- localStorage helpers
  - save/get round-trip
  - enabled toggle round-trip
- `useCustomChatTheme()`
  - reacts to `chatCustomThemeChange`
  - reacts to `storage` events

Target: `ThemeManager.tsx`
- editing a color updates stored theme
- editing auto-enables theme
- reset restores defaults
- import invalid JSON shows error status

## 8.2 Integration-level component tests (new)
- `Chat.tsx`: custom theme enabled applies expected style values for key surfaces
- `ChatMessage.tsx`: role-based colors apply from `messageRoles`
- `Heimdall.tsx`: node/pill colors use theme when enabled
- `SettingsPane.tsx`: saved theme list + apply flow with mocked `localApi`

## 8.3 Electron tool tests (expand existing)
`electron/tools/__tests__/themeManager.test.ts`
Add cases for:
- `template` action
- read non-existent returns `exists: false`
- delete non-existent returns `deleted: false`
- save with explicit `name` override
- malformed JSON file in list (fallback to filename display name)
- id normalization edge cases (`.json`, spaces, special chars)

---

## 9) Agent quick-start checklist for theme changes

1. Read:
   - `themeConfig.ts`
   - `ThemeManager.tsx`
   - `electron/tools/themeManager.ts`
2. Search all consumers:
   - `customTheme.colors.<token>` usages
3. Update both schema implementations.
4. Update editor + target component(s).
5. Add/adjust tests in frontend and electron tool.
6. Verify save/load/apply through `SettingsPane` saved themes section.
