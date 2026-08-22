# Mobile shadcn-style integration status

## Phase 0 — baseline safety
- Preserved all existing API contracts and chat orchestration behavior.
- Kept SSE/event handling unchanged.
- Conversation cwd persistence path unchanged (`PATCH /api/app/conversations/:id`).

## Phase 1 — foundation
- Added `components.json` scaffold.
- Added `tailwind.config.ts` scaffold.
- Added `postcss.config.js` scaffold.
- Added `src/lib/utils.ts` (`cn` helper).

## Phase 2 — primitive UI layer
- Added local primitives in `src/components/ui/`:
  - `button.tsx`
  - `input.tsx`
  - `textarea.tsx`
  - `select.tsx`
  - `badge.tsx`
  - `card.tsx`

## Phase 3 — component migration
- Migrated key component controls to primitives while keeping behavior:
  - `MobileHeader.tsx`
  - `ProfilePicker.tsx`
  - `Composer.tsx`
  - `ToolTogglePanel.tsx`
  - `ProjectConversationTree.tsx`
  - `MessageBubble.tsx`
  - `MessageTreeDrawer.tsx`
  - `App.tsx` (project launcher, cwd controls, branch toolbar)

## Phase 4 — theme hardening
- Refactored `assets/mobile.css` to semantic light/dark tokens.
- Replaced hardcoded dark values on interactive surfaces with token-driven styles.
- Tokenized message list, overlays, tree canvas, and tree node/edge colors.

## Phase 5 — parity verification
- Rebuilt bundle with `npm run build:electron:main` after migration.
- Build succeeded and mobile bundle regenerated (`assets/mobile-app.js`).

## Phase 6 — cleanup/docs
- Updated `electron/headlessServer/README.md` with migration notes.
