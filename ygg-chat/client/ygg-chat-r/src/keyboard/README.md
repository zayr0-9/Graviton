# Keyboard commands

The renderer mounts `KeyboardProvider` once inside the router in `App.tsx`.
`commands.ts` is the catalog of command IDs, labels, platform bindings, input policy,
and repeat policy. `useCommands` registers live feature-owned handlers and removes
them on unmount. Do not copy feature state into the registry or add another window
listener for a new application command.

`NavigationCommands` owns one `useTitleBarHistory` instance. Both title-bar buttons
and shortcuts use it, including excluded destinations and pending-navigation guards.

## Initial bindings

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Back / forward | Cmd+[ / Cmd+] | Alt+Left / Alt+Right |
| Show and focus conversation tree | Cmd+Shift+E | Ctrl+Shift+E |
| Parent / child (tree focused) | Up / Down | Up / Down |
| Switch to previous / next branch on the current row | Left / Right | Left / Right |
| Open focused node's branch | Enter | Enter |
| Toggle message action selection | Space | Space |
| Open message actions | Shift+F10 | Shift+F10 or Context Menu |

Tab enters/leaves the graph as one focus stop. Up/Down explore parent/child nodes;
Enter opens the focused branch. Left/Right move across the current visible depth in
visual order, including nodes with different parents, and open that branch immediately
without Enter. Movement stops at the row edges; it does not wrap. Action selection
remains separate. Navigation uses the complete filtered tree, not viewport-culling
results. Activation uses canonical message paths, so filtered scaffolding is not
dropped. Re-activating an on-path node keeps its current branch and issues the usual
message-focus intent. The keyboard cursor uses a solid, theme-aware focus ring.

## Scope and lifecycle

- A handler without `scope` is application-wide for as long as its owner is mounted.
- A scoped handler owns keys only when its exact element is the event target. Child
  inputs, toolbar buttons, and overlays retain their normal keyboard behavior.
- The shared listener runs in bubble phase and respects `defaultPrevented` and IME
  composition. Matching chords require exact modifiers.
- Inputs, Monaco and terminals suppress commands unless the catalog opts them in.
- Visible semantic modal dialogs block background commands. Legacy overlays can
  call `useCommandBlocker(open)`; blockers compose and are removed on unmount.
- History chords are consumed even at endpoints to avoid falling through to native
  browser navigation. Repeats are consumed without executing unless opted in.
- Call `formatShortcut(id)` for labels/tooltips rather than duplicating key strings.

This is a window-local renderer system, not Electron `globalShortcut`. Embedded
iframes/webviews have separate event contexts and are not bridged in this pass.
Existing Chat mode/model/settings shortcuts are not migrated here. Pane cycling and
a command palette remain outside scope.

## User bindings

Chat Settings → Shortcuts opens `KeyboardShortcutsModal`. Each catalog command can
be recorded, cleared, or reset. Edits remain a draft until Save; Cancel/Escape discard
them. Escape cancels an active recording before closing the modal. Tab remains focus
traversal. The modal traps focus, restores its trigger, and blocks background commands
(including the legacy Chat capture handler) while recording.

`shortcutPreferences.ts` validates captures, reports duplicate bindings, reserves
known legacy Chat/editing/window chords, and saves overrides under
`keyboard:bindings:v1` in localStorage. An empty array disables a command; an absent
entry uses platform defaults. Same-window change notifications and storage events
update routing and shortcut labels without restarting. Storage failures remain in
the editor as visible errors. OS-reserved combinations may still be intercepted
before reaching the app; these cannot be overridden by a renderer preference.

## Validation

- `npm run test:renderer -- src/keyboard/commandRegistry.test.ts src/components/Heimdall/heimdallKeyboard.test.ts`
- `node scripts/test-chat-selection-electron.cjs` exercises the real provider,
  StrictMode registration, live callbacks/availability, blockers, and shared history.
- `npm run build:electron`

Manual Electron checks: focus a hidden tree via its shortcut, browse across multiple
roots/forks, open a node with Enter, toggle/select messages and open actions, verify
text editing in notes/search and settings, and check large culled/streaming trees in
light/dark/custom themes. Screen-reader behavior requires a manual accessibility pass.
