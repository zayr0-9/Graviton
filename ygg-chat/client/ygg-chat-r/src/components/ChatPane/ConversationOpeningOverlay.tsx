/** Pane-local loading surface; never portals or takes focus from navigation. */
export function ConversationOpeningOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null

  return (
    <div className='absolute inset-0 z-30 flex items-center justify-center p-4' data-conversation-opening-overlay='true'>
      <div
        role='status'
        aria-live='polite'
        aria-atomic='true'
        className='flex max-w-full items-center gap-3 rounded-2xl border border-neutral-200 bg-neutral-50 px-6 py-5 text-sm font-medium text-neutral-800 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'
      >
        <span aria-hidden='true' className='h-5 w-5 shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin' />
        <span>Opening conversation…</span>
      </div>
    </div>
  )
}
