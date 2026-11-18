import { useEffect, useState } from 'react'
import { meterScopes, meterStyles, normalizeMeterTicks, type MeterScope, type MeterStyle } from '../features/chats/characterMeter'

const key = 'chat:characterMeter'
export interface MeterPreferences { style: MeterStyle; scope: MeterScope; tickLimit: number }
export function loadMeterPreferences(): MeterPreferences {
  let value: Partial<MeterPreferences> = {}
  try { value = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {} } catch { /* Default when storage is unavailable. */ }
  return {
    tickLimit: normalizeMeterTicks(value.tickLimit),
    style: Object.prototype.hasOwnProperty.call(meterStyles, value.style) ? value.style : 'off',
    scope: Object.prototype.hasOwnProperty.call(meterScopes, value.scope) ? value.scope : 'all',
  }
}
export function saveMeterPreferences(prefs: MeterPreferences) {
  try { localStorage.setItem(key, JSON.stringify(prefs)) } catch { /* Apply for this window. */ }
  window.dispatchEvent(new CustomEvent(key, { detail: prefs }))
}
export function useMeterPreferences() {
  const [prefs, setPrefs] = useState(loadMeterPreferences)
  useEffect(() => {
    const local = (e: Event) => {
      const detail = (e as CustomEvent<MeterPreferences>).detail
      setPrefs({ ...detail, tickLimit: normalizeMeterTicks(detail?.tickLimit) })
    }
    const external = (e: StorageEvent) => { if (e.key === key || e.key === null) setPrefs(loadMeterPreferences()) }
    window.addEventListener(key, local)
    window.addEventListener('storage', external)
    return () => { window.removeEventListener(key, local); window.removeEventListener('storage', external) }
  }, [])
  return prefs
}
