import { VIDEO_BACKGROUND_CHANGE_EVENT } from './videoBackgroundStorage'

export const MATRIX_PRESETS = [
  { value: 'classic', label: 'Classic', columns: 80 },
  { value: 'resurrections', label: 'Resurrections', columns: 70 },
  { value: 'operator', label: 'Operator', columns: 108 },
] as const

export interface MatrixBackgroundSettings {
  preset: typeof MATRIX_PRESETS[number]['value']
  fps: 15 | 30 | 60
  speed: number
  columns: number
}

export const DEFAULT_MATRIX_SETTINGS: MatrixBackgroundSettings = {
  preset: 'classic', fps: 30, speed: 1, columns: MATRIX_PRESETS[0].columns,
}
const STORAGE_KEY = 'graviton_matrix_background'

export const normalizeMatrixSettings = (value: unknown): MatrixBackgroundSettings => {
  const input = value && typeof value === 'object' ? value as Partial<MatrixBackgroundSettings> : {}
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  return {
    preset: MATRIX_PRESETS.some(preset => preset.value === input.preset) ? input.preset! : DEFAULT_MATRIX_SETTINGS.preset,
    fps: input.fps === 15 || input.fps === 60 ? input.fps : 30,
    speed: clamp(input.speed, DEFAULT_MATRIX_SETTINGS.speed, 0.25, 2),
    columns: Math.round(clamp(input.columns, DEFAULT_MATRIX_SETTINGS.columns, 20, 120)),
  }
}

export const loadMatrixSettings = (): MatrixBackgroundSettings => {
  try {
    return normalizeMatrixSettings(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'))
  } catch {
    return { ...DEFAULT_MATRIX_SETTINGS }
  }
}

export const saveMatrixSettings = (settings: MatrixBackgroundSettings) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeMatrixSettings(settings)))
  window.dispatchEvent(new Event(VIDEO_BACKGROUND_CHANGE_EVENT))
}

export type MatrixRuntimeStatus = 'idle' | 'loading' | 'ready' | 'retrying' | 'error'
export const MATRIX_STATUS_EVENT = 'graviton:matrix-state'
let runtimeStatus: MatrixRuntimeStatus = 'idle'
export const loadMatrixRuntimeStatus = () => runtimeStatus
export const publishMatrixRuntimeStatus = (status: MatrixRuntimeStatus) => {
  runtimeStatus = status
  window.dispatchEvent(new Event(MATRIX_STATUS_EVENT))
}
