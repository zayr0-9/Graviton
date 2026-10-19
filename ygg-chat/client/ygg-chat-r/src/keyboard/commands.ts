export type KeyBinding = {
  key: string
  primary?: boolean
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
}

type CommandDefinition = {
  label: string
  bindings: KeyBinding[]
  macBindings?: KeyBinding[]
  allowInInput?: boolean
  repeat?: boolean
}

export const commands = {
  'navigation.back': {
    label: 'Go back', bindings: [{ key: 'ArrowLeft', alt: true }],
    macBindings: [{ key: '[', primary: true }], allowInInput: true,
  },
  'navigation.forward': {
    label: 'Go forward', bindings: [{ key: 'ArrowRight', alt: true }],
    macBindings: [{ key: ']', primary: true }], allowInInput: true,
  },
  'heimdall.focus': {
    label: 'Focus conversation tree', bindings: [{ key: 'e', primary: true, shift: true }], allowInInput: true,
  },
  'heimdall.parent': { label: 'Parent message', bindings: [{ key: 'ArrowUp' }], repeat: true },
  'heimdall.child': { label: 'Child message', bindings: [{ key: 'ArrowDown' }], repeat: true },
  'heimdall.previousSibling': { label: 'Open previous branch', bindings: [{ key: 'ArrowLeft' }], repeat: true },
  'heimdall.nextSibling': { label: 'Open next branch', bindings: [{ key: 'ArrowRight' }], repeat: true },
  'heimdall.activate': { label: 'Open branch', bindings: [{ key: 'Enter' }] },
  'heimdall.select': { label: 'Select message for actions', bindings: [{ key: ' ' }] },
  'heimdall.actions': { label: 'Message actions', bindings: [{ key: 'F10', shift: true }, { key: 'ContextMenu' }] },
} satisfies Record<string, CommandDefinition>

export type CommandId = keyof typeof commands
export const getCommand = (id: CommandId): CommandDefinition => commands[id]
export const isMacKeyboard = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const matchesBinding = (event: KeyboardEvent, binding: KeyBinding, mac: boolean): boolean =>
  event.key.toLowerCase() === binding.key.toLowerCase() &&
  event.metaKey === (Boolean(binding.meta) || (Boolean(binding.primary) && mac)) &&
  event.ctrlKey === (Boolean(binding.ctrl) || (Boolean(binding.primary) && !mac)) &&
  event.altKey === Boolean(binding.alt) && event.shiftKey === Boolean(binding.shift)

export type ShortcutOverrides = Partial<Record<CommandId, KeyBinding[]>>
export const commandIds = Object.keys(commands) as CommandId[]

export const getBindings = (id: CommandId, mac: boolean, overrides: ShortcutOverrides = {}): KeyBinding[] => {
  const command = getCommand(id)
  return overrides[id] ?? (mac ? command.macBindings ?? command.bindings : command.bindings)
}

export const formatBinding = (binding: KeyBinding, mac = isMacKeyboard()): string => {
  const key = ({ ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ' ': 'Space' } as Record<string, string>)[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  return [binding.meta || (binding.primary && mac) ? '⌘' : '', binding.ctrl || (binding.primary && !mac) ? 'Ctrl' : '', binding.alt ? (mac ? '⌥' : 'Alt') : '', binding.shift ? (mac ? '⇧' : 'Shift') : '', key].filter(Boolean).join(mac ? ' ' : '+')
}

export const formatShortcut = (id: CommandId, mac = isMacKeyboard(), overrides: ShortcutOverrides = {}): string =>
  getBindings(id, mac, overrides).map(binding => formatBinding(binding, mac)).join(' / ') || 'Not assigned'
