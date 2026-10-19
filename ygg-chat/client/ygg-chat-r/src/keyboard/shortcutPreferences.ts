import { commandIds, getBindings, getCommand } from './commands'
import type { CommandId, KeyBinding, ShortcutOverrides } from './commands'

export const SHORTCUT_STORAGE_KEY = 'keyboard:bindings:v1'
export const SHORTCUT_CHANGE_EVENT = 'keyboardBindingsChange'
const modifierKeys = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph'])

const isBinding = (value: unknown): value is KeyBinding => {
  if (!value || typeof value !== 'object') return false
  const binding = value as KeyBinding
  return typeof binding.key === 'string' && binding.key.length > 0 && binding.key.length <= 40 &&
    !modifierKeys.has(binding.key) && !['Unidentified', 'Dead', 'Process', 'Escape', 'Tab'].includes(binding.key) &&
    ['primary', 'ctrl', 'meta', 'alt', 'shift'].every(name =>
      (binding as Record<string, unknown>)[name] === undefined || typeof (binding as Record<string, unknown>)[name] === 'boolean')
}

export const parseShortcutOverrides = (raw: string | null): ShortcutOverrides => {
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: ShortcutOverrides = {}
    for (const id of commandIds) {
      const value = parsed[id]
      if (Array.isArray(value) && value.length <= 2 && value.every(isBinding)) result[id] = value
    }
    return result
  } catch { return {} }
}

export const loadShortcutOverrides = (): ShortcutOverrides => {
  try { return parseShortcutOverrides(window.localStorage.getItem(SHORTCUT_STORAGE_KEY)) }
  catch { return {} }
}

/** Failure is visible to the editor; don't announce preferences that were not saved. */
export const saveShortcutOverrides = (overrides: ShortcutOverrides): void => {
  window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(overrides))
  window.dispatchEvent(new Event(SHORTCUT_CHANGE_EVENT))
}

export const subscribeShortcutOverrides = (listener: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SHORTCUT_STORAGE_KEY || event.key === null) listener()
  }
  window.addEventListener(SHORTCUT_CHANGE_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(SHORTCUT_CHANGE_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export type CaptureResult = { binding?: KeyBinding; error?: string }

/** Tab and Escape remain available for focus traversal/cancelling the recorder. */
export const captureShortcut = (event: KeyboardEvent, id: CommandId, mac: boolean): CaptureResult => {
  if (event.isComposing || event.repeat || modifierKeys.has(event.key)) return {}
  if (event.key === 'Tab' || event.key === 'Escape') return {}
  if (event.getModifierState?.('AltGraph') || ['Unidentified', 'Dead', 'Process'].includes(event.key)) {
    return { error: 'Choose a key without composition or AltGr.' }
  }
  const primary = mac ? event.metaKey : event.ctrlKey
  if (getCommand(id).allowInInput && !primary && !(event.altKey && event.key.startsWith('Arrow')) && !/^F\d+$/.test(event.key)) {
    return { error: 'App-wide shortcuts need Cmd/Ctrl, a function key, or Alt+arrow so typing stays available.' }
  }
  // Existing Chat capture shortcuts must not intercept a user-assigned chord.
  if (((event.code === 'KeyF' || event.key.toLowerCase() === 'f') && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) ||
      ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'Comma' || event.key === ',' || (!event.shiftKey && (/^Digit[1-9]$/.test(event.code) || /^[1-9]$/.test(event.key)))))) {
    return { error: 'This shortcut is already used by Chat settings, mode, or model controls.' }
  }
  if (primary && !event.altKey && !event.shiftKey && ['q', 'w', 'r', 't', 'n', 'l', 'c', 'v', 'x', 'a', 'z', 'y', 'f'].includes(event.key.toLowerCase())) {
    return { error: 'Choose a shortcut that does not replace standard editing or window controls.' }
  }
  const binding: KeyBinding = { key: event.key, primary }
  if (mac && event.ctrlKey) binding.ctrl = true
  if (!mac && event.metaKey) binding.meta = true
  if (event.altKey) binding.alt = true
  if (event.shiftKey) binding.shift = true
  return { binding }
}

const bindingSignature = (binding: KeyBinding, mac: boolean) => [
  binding.key.toLowerCase(), Boolean(binding.ctrl || (binding.primary && !mac)),
  Boolean(binding.meta || (binding.primary && mac)), Boolean(binding.alt), Boolean(binding.shift),
].join('|')

export const findShortcutConflict = (
  id: CommandId, binding: KeyBinding, overrides: ShortcutOverrides, mac: boolean
): CommandId | undefined => commandIds.find(other => other !== id &&
  getBindings(other, mac, overrides).some(existing => bindingSignature(existing, mac) === bindingSignature(binding, mac)))
