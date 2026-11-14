// Image paste helpers for the chat composer.
//
// Desktop browsers fire `paste` on a textarea for any clipboard content, so Ctrl/Cmd+V with an
// image reaches `getPastedImageFiles`. On Android Chrome an image-only clipboard may never
// produce a paste event in a plain textarea (the selection menu and keyboard image chips target
// rich editors), so `readClipboardImageFiles` reads it directly through the async Clipboard API.
// That API exists only on secure origins (HTTPS or localhost).

interface PasteDataLike {
  items?: ArrayLike<{ kind?: string; type: string; getAsFile: () => File | null }> | null
  files?: ArrayLike<File> | null
}

/** Image files carried by a paste event. Some browsers fill only `files`, not `items`. */
export function getPastedImageFiles(data: PasteDataLike | null | undefined): File[] {
  if (!data) return []
  const fromItems = Array.from(data.items ?? [])
    .filter(item => item.kind !== 'string' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file)
  if (fromItems.length > 0) return fromItems
  return Array.from(data.files ?? []).filter(file => file.type.startsWith('image/'))
}

interface ClipboardItemLike {
  types: readonly string[]
  getType: (type: string) => Promise<Blob>
}

interface ClipboardReader {
  read: () => Promise<ClipboardItemLike[]>
}

const getClipboardReader = (): ClipboardReader | null => {
  if (typeof window === 'undefined' || !window.isSecureContext) return null
  const clipboard = (typeof navigator !== 'undefined' ? navigator.clipboard : undefined) as Partial<ClipboardReader> | undefined
  return typeof clipboard?.read === 'function' ? (clipboard as ClipboardReader) : null
}

/** True when the page may read images from the system clipboard (HTTPS or localhost). */
export const canReadClipboardImages = (): boolean => getClipboardReader() !== null

const extensionFor = (type: string): string => {
  const subtype = type.slice('image/'.length).split(/[+;]/)[0] || 'png'
  return subtype === 'jpeg' ? 'jpg' : subtype
}

/**
 * Images currently on the system clipboard. Call from a click handler: browsers require a user
 * gesture and may ask for permission. Rejects when the API is unavailable or permission is denied.
 */
export async function readClipboardImageFiles(
  reader: ClipboardReader | null = getClipboardReader(),
  now: () => number = Date.now
): Promise<File[]> {
  if (!reader) throw new Error('Clipboard image reading needs a secure (HTTPS) page')
  const items = await reader.read()
  const files: File[] = []
  for (const item of items) {
    const type = item.types.find(candidate => candidate.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    files.push(new File([blob], `pasted-image-${now()}-${files.length + 1}.${extensionFor(type)}`, { type }))
  }
  return files
}
