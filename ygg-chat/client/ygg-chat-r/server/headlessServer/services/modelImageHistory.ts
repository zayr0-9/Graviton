import { open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_HISTORY_IMAGE_BYTES = 64 * 1024 * 1024
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'])

function imageBytes(url: string): number {
  const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url)
  if (!match || !IMAGE_MIMES.has(match[1])) throw new Error('Attached images must be supported base64 images')
  const bytes = Buffer.byteLength(match[2], 'base64')
  if (!bytes || bytes > MAX_IMAGE_BYTES) throw new Error('Attached image exceeds the 20 MB limit')
  return bytes
}

export function assertModelImageBudget(history: any[]): void {
  let bytes = 0
  for (const row of history) {
    for (const url of new Set<string>(row.role === 'user' && Array.isArray(row.artifacts) ? row.artifacts : [])) {
      bytes += imageBytes(url)
      if (bytes > MAX_HISTORY_IMAGE_BYTES) throw new Error('Image history exceeds 64 MB. Start a new branch with fewer images.')
    }
  }
}

/** Model-only projection. SQLite/link tables stay authoritative; bytes never go back to DB/SSE. */
export function createModelImageHydrator(dbPath: string | undefined, statements: any) {
  const roots = dbPath && dbPath !== ':memory:'
    ? ['user_images', 'generated_images'].map(dir => path.join(path.dirname(dbPath), dir)) : []
  return async (history: any[], freshMessageId?: string | null, freshImages: any[] = []): Promise<any[]> => {
    let totalBytes = 0
    const cache = new Map<string, string>()
    const result: any[] = []
    for (const message of history) {
      if (message.role !== 'user') { result.push(message); continue }
      const submitted = String(message.id) === String(freshMessageId) ? freshImages : []
      const linked = message.id != null && statements.getAttachmentsByMessageId?.all
        ? statements.getAttachmentsByMessageId.all(message.id) : (message.attachments ?? [])
      const images = linked.filter((a: any) => String(a.mime_type ?? '').startsWith('image/'))
      const urls = new Set<string>()
      const accept = (url: string) => {
        if (urls.has(url)) return
        totalBytes += imageBytes(url)
        if (totalBytes > MAX_HISTORY_IMAGE_BYTES) throw new Error('Image history exceeds 64 MB. Start a new branch with fewer images.')
        urls.add(url)
      }
      for (const attachment of images) {
        let url = cache.get(attachment.id)
        if (!url) {
          try {
            const mime = String(attachment.mime_type).toLowerCase()
            if (!IMAGE_MIMES.has(mime) || !attachment.file_path) throw new Error('Unsupported or unavailable image')
            const filename = await realpath(attachment.file_path)
            const allowedRoots = await Promise.all(roots.map(root => realpath(root).catch(() => null)))
            if (!allowedRoots.some(root => {
              if (!root) return false
              const relative = path.relative(root, filename)
              return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
            })) throw new Error('Image is outside managed attachment storage')
            const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
            try {
              const stat = await file.stat()
              if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid image size')
              if (totalBytes + stat.size > MAX_HISTORY_IMAGE_BYTES) throw new Error('Image history exceeds the size limit')
              // Fixed-size read bounds memory even if the file grows after stat.
              const bytes = Buffer.alloc(stat.size + 1)
              let count = 0
              while (count < bytes.length) {
                const read = await file.read(bytes, count, bytes.length - count, count)
                if (!read.bytesRead) break
                count += read.bytesRead
              }
              if (count !== stat.size) throw new Error('Image changed while reading')
              const data = bytes.subarray(0, count)
              if (attachment.sha256 && createHash('sha256').update(data).digest('hex') !== attachment.sha256) {
                throw new Error('Image content changed')
              }
              url = `data:${mime};base64,${data.toString('base64')}`
            } finally { await file.close() }
          } catch {
            throw new Error(`Could not load attached image ${attachment.id}. Reattach it before sending.`)
          }
        }
        accept(url)
        cache.set(attachment.id, url)
      }
      // Compatibility for direct API clients that provide inline images without prepared IDs.
      for (const image of submitted) {
        const id = image?.attachmentId ?? image?.attachment_id
        if (!images.some((attachment: any) => attachment.id === id) && typeof image?.dataUrl === 'string') accept(image.dataUrl)
      }
      const unique = [...urls]
      result.push(unique.length ? { ...message,
        artifacts: unique,
        attachments: unique.map(dataUrl => ({ dataUrl })),
      } : message)
    }
    return result
  }
}
