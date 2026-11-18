import { maxMeterTicks, meterScopes, meterStyles, type MeterScope, type MeterStyle } from '../../features/chats/characterMeter'
import { saveMeterPreferences, useMeterPreferences } from '../../helpers/characterMeterSettings'
import type { SettingsSectionThemeColors } from './settingsSectionTheme'

export function CharacterMeterSettings({ colors }: { colors?: SettingsSectionThemeColors | null }) {
  const prefs = useMeterPreferences()
  const control = 'rounded-lg px-2 py-1 text-sm bg-white text-stone-800 dark:bg-neutral-800 dark:text-stone-100'
  const style = colors ? { backgroundColor: colors.buttonBg, color: colors.buttonText } : undefined
  return <fieldset className='space-y-2 rounded-2xl p-3 text-sm text-stone-700 dark:text-stone-200'
    style={colors ? { backgroundColor: colors.cardBg, color: colors.bodyText } : undefined}>
    <legend className='font-medium'>Output character meter</legend>
    <label className='flex items-center justify-between gap-2'>Style
      <select className={control} style={style} value={prefs.style} onChange={e => saveMeterPreferences({ ...prefs, style: e.target.value as MeterStyle })}>
        {Object.entries(meterStyles).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
    {prefs.style !== 'off' && <label className='flex items-center justify-between gap-2'>Count
      <select className={control} style={style} value={prefs.scope} onChange={e => saveMeterPreferences({ ...prefs, scope: e.target.value as MeterScope })}>
        {Object.entries(meterScopes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>}
    {prefs.style !== 'off' && <label className='flex items-center justify-between gap-2'>
      Max characters animated per block
      <span className='flex items-center gap-2'>
        <input type='range' min={1} max={maxMeterTicks} step={1} value={prefs.tickLimit}
          className='w-24' style={colors ? { accentColor: colors.primaryButtonBg } : undefined}
          onChange={e => saveMeterPreferences({ ...prefs, tickLimit: e.currentTarget.valueAsNumber })} />
        <span aria-hidden='true' className='w-6 text-right tabular-nums'>{prefs.tickLimit}</span>
      </span>
    </label>}
  </fieldset>
}
