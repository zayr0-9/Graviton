import type { BaseModel } from '../../../../shared/types'

export const MODEL_SHORTCUT_SLOTS_STORAGE_KEY = 'chat:modelShortcutSlots'
export const MODEL_SHORTCUT_SLOTS_CHANGE_EVENT = 'chatModelShortcutSlotsChange'

export type ModelShortcutSlot = {
  provider: string
  model: BaseModel
}

export type ModelShortcutSlots = Partial<Record<number, ModelShortcutSlot>>

const isValidSlotNumber = (slot: number): boolean => Number.isInteger(slot) && slot >= 1 && slot <= 9

const isModelShortcutSlot = (value: unknown): value is ModelShortcutSlot => {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ModelShortcutSlot>
  return (
    typeof candidate.provider === 'string' &&
    candidate.provider.trim().length > 0 &&
    Boolean(candidate.model) &&
    typeof candidate.model?.name === 'string' &&
    candidate.model.name.trim().length > 0
  )
}

export const loadModelShortcutSlots = (): ModelShortcutSlots => {
  try {
    const raw = window.localStorage.getItem(MODEL_SHORTCUT_SLOTS_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}

    const slots: ModelShortcutSlots = {}
    for (let slot = 1; slot <= 9; slot += 1) {
      const value = parsed[String(slot)]
      if (isModelShortcutSlot(value)) slots[slot] = value
    }
    return slots
  } catch {
    return {}
  }
}

export const saveModelShortcutSlot = (
  slot: number,
  assignment: ModelShortcutSlot | null
): ModelShortcutSlots => {
  if (!isValidSlotNumber(slot)) return loadModelShortcutSlots()

  const slots = loadModelShortcutSlots()
  if (assignment && isModelShortcutSlot(assignment)) {
    slots[slot] = assignment
  } else {
    delete slots[slot]
  }

  try {
    window.localStorage.setItem(MODEL_SHORTCUT_SLOTS_STORAGE_KEY, JSON.stringify(slots))
    window.dispatchEvent(new CustomEvent(MODEL_SHORTCUT_SLOTS_CHANGE_EVENT, { detail: slots }))
  } catch {
    // Keep shortcuts non-fatal when storage is unavailable.
  }

  return slots
}

export const getMarkdownFenceForText = (text: string): string => {
  const longestBacktickRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length))
  return '`'.repeat(Math.max(3, longestBacktickRun + 1))
}

export const wrapPastedTextInMarkdownFence = (text: string): string => {
  const fence = getMarkdownFenceForText(text)
  return `${fence}\n${text}\n${fence}`
}
