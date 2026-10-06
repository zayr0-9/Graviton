export type TitleBarHistory = ReadonlyMap<number, string>
export type TitleBarHistoryAction = 'PUSH' | 'REPLACE' | 'POP'

// In Electron, / redirects to /login, so it is not a useful arrow destination either.
const EXCLUDED_PATHS = new Set(['/', '/login', '/logging'])

export const recordTitleBarLocation = (
  history: TitleBarHistory,
  index: number,
  pathname: string,
  action: TitleBarHistoryAction
): TitleBarHistory => {
  const next = new Map(history)
  if (action === 'PUSH') {
    // A new visit after going back discards the browser's forward branch.
    for (const entryIndex of next.keys()) {
      if (entryIndex >= index) next.delete(entryIndex)
    }
  }
  next.set(index, pathname)
  return next
}

export const getTitleBarHistoryDelta = (
  history: TitleBarHistory,
  index: number,
  direction: -1 | 1
): number | null => {
  let target: number | null = null
  for (const [entryIndex, pathname] of history) {
    if ((entryIndex - index) * direction <= 0) continue
    // Match the same case-insensitive, trailing-slash-tolerant routes as React Router.
    if (EXCLUDED_PATHS.has(pathname.replace(/\/+$/, '').toLowerCase() || '/')) continue
    if (target === null || (entryIndex - target) * direction < 0) target = entryIndex
  }
  return target === null ? null : target - index
}
