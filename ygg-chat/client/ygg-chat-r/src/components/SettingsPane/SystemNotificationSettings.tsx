import { Bell, Check, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { getSystemNotificationsApi } from '../../features/chats/systemRunNotifications'
import {
  readSystemNotificationPrefs,
  writeSystemNotificationPrefs,
  type SystemNotificationWhen,
} from '../../features/ui/systemNotificationPrefs'
import type { SettingsSectionThemeColors } from './settingsSectionTheme'

const iconProps = { size: 18, strokeWidth: 2.25 }
const toggleClass =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/70 text-stone-600 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-white hover:text-stone-950 active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:bg-white/5 dark:text-stone-200 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-orange-400/60'

const WHEN_OPTIONS: { value: SystemNotificationWhen; label: string }[] = [
  { value: 'unfocused', label: "Only when Graviton isn't focused" },
  { value: 'always', label: 'Always' },
]

type TestStatus = 'idle' | 'sent' | 'blocked'

/**
 * Settings → System notifications: OS notifications when a main Chat or branch run
 * finishes. Electron only; renders nothing in the browser shared UI.
 */
export const SystemNotificationSettings = ({ sectionThemeColors: colors }: {
  sectionThemeColors?: SettingsSectionThemeColors | null
}) => {
  const [prefs, setPrefs] = useState(readSystemNotificationPrefs)
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const api = getSystemNotificationsApi()

  const update = useCallback((patch: Parameters<typeof writeSystemNotificationPrefs>[0]) => {
    setPrefs(writeSystemNotificationPrefs(patch))
  }, [])

  const sendTest = useCallback(() => {
    if (!api) return
    void api.show({
      id: `test:${Date.now()}`,
      kind: 'primary',
      title: 'Graviton',
      body: 'Test notification: run completion alerts are working.',
      conversationId: 'test',
      projectId: null,
      messageId: 'test',
      lineageId: null,
    }, { force: true })
      .then(result => setTestStatus(result.shown ? 'sent' : 'blocked'))
      .catch(() => setTestStatus('blocked'))
  }, [api])

  if (!api) return null

  return (
    <section className='overflow-hidden rounded-2xl bg-neutral-50/70 dark:bg-neutral-900/10'
      style={colors ? { backgroundColor: colors.cardBg, borderColor: colors.cardBorder } : undefined}>
      <div className='flex items-start justify-between gap-3 px-3 py-3'>
        <div className='flex min-w-0 items-start gap-3'>
          <div className='mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'
            style={colors ? { backgroundColor: colors.accentBg, color: colors.accentText } : undefined}>
            <Bell {...iconProps} />
          </div>
          <div className='min-w-0 pr-3'>
            <p id='system-notifications-label' className='text-sm font-medium text-stone-700 dark:text-neutral-100'
              style={colors ? { color: colors.titleText } : undefined}>
              System notifications
            </p>
            <p className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-100'
              style={colors ? { color: colors.bodyText } : undefined}>
              Show an OS notification when a chat or branch run finishes. Click it to open the run.
            </p>
          </div>
        </div>
        <button type='button' className={toggleClass} aria-labelledby='system-notifications-label'
          aria-pressed={prefs.enabled} onClick={() => update({ enabled: !prefs.enabled })}
          title={prefs.enabled ? 'Turn off system notifications' : 'Turn on system notifications'}
          style={colors ? { backgroundColor: colors.buttonBg, color: colors.buttonText } : undefined}>
          {prefs.enabled
            ? <Check {...iconProps} style={colors ? { color: colors.primaryButtonBg } : undefined} />
            : <X {...iconProps} />}
        </button>
      </div>

      <div className='flex flex-wrap items-center gap-2 px-3 pb-3 pl-16'>
        <div role='radiogroup' aria-label='When to notify' className='flex flex-wrap items-center gap-2'>
          {WHEN_OPTIONS.map(option => {
            const selected = prefs.when === option.value
            return (
              <button
                key={option.value}
                type='button'
                role='radio'
                aria-checked={selected}
                disabled={!prefs.enabled}
                onClick={() => update({ when: option.value })}
                className={`rounded-2xl px-3 py-1.5 text-xs font-medium transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-violet-500/40 ${
                  selected
                    ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700'
                }`}
                style={colors
                  ? selected
                    ? { backgroundColor: colors.primaryButtonBg, color: colors.primaryButtonText }
                    : { backgroundColor: colors.buttonBg, color: colors.buttonText }
                  : undefined}
              >
                {option.label}
              </button>
            )
          })}
        </div>
        <button type='button' onClick={sendTest}
          className='rounded-2xl bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-600 transition-all duration-150 hover:bg-neutral-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700'
          style={colors ? { backgroundColor: colors.buttonBg, color: colors.buttonText } : undefined}>
          Send test
        </button>
        <span role='status' className='text-xs text-neutral-500 dark:text-neutral-300'
          style={colors ? { color: colors.bodyText } : undefined}>
          {testStatus === 'sent' ? 'Sent. If nothing appeared, allow Graviton in your OS notification settings.'
            : testStatus === 'blocked' ? 'Notifications are not supported on this system.' : ''}
        </span>
      </div>
    </section>
  )
}
