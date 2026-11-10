export const OPEN_HOST_FILE = 'graviton:open-host-file'

export function hostPathFromFileUrl(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'file:') return null
    let pathname = decodeURIComponent(url.pathname)
    if (url.hostname && url.hostname !== 'localhost') return `//${url.hostname}${pathname}`
    if (/^\/[a-z]:\//i.test(pathname)) pathname = pathname.slice(1)
    return pathname || null
  } catch { return null }
}
