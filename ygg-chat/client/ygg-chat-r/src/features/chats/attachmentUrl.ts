export interface AttachmentUrlInput {
  urlOrPath?: string | null
  filePath?: string | null
  attachmentId?: string | null
  localOrigin: string
  localApiBase: string
}

const isAbsoluteFilesystemPath = (value: string): boolean =>
  value.startsWith('/') || /^[A-Za-z]:\//.test(value)

const isServerRelativePath = (value: string): boolean =>
  value.startsWith('/uploads') || value.startsWith('/data/')

const resolveLocalRoute = (value: string, localOrigin: string): string | null => {
  if (value.startsWith('/api/local/')) return `${localOrigin}${value}`
  if (value.startsWith('/local/')) return `${localOrigin}/api${value}`
  if (value.startsWith('api/local/')) return `${localOrigin}/${value}`
  if (value.startsWith('local/')) return `${localOrigin}/api/${value}`
  return null
}

/**
 * Resolve attachment metadata to a renderer-accessible URL without exposing a
 * server filesystem path. Everything resolves against the local Ygg host; the
 * retired hosted `/uploads` store has no local equivalent, so those paths are null.
 */
export function resolveAttachmentUrlFromOrigins({
  urlOrPath,
  filePath,
  attachmentId,
  localOrigin,
  localApiBase,
}: AttachmentUrlInput): string | null {
  if (attachmentId && filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/')
    if (isAbsoluteFilesystemPath(normalizedPath)) {
      return `${localApiBase}/local/attachments/${encodeURIComponent(attachmentId)}/file`
    }
  }

  if (urlOrPath) {
    if (/^https?:\/\//i.test(urlOrPath)) {
      try {
        const legacy = new URL(urlOrPath)
        // Rewrite only recognized host-local attachment routes, never arbitrary
        // external URLs or provider localhost endpoints.
        if (['localhost', '127.0.0.1', '[::1]'].includes(legacy.hostname) && /^\/api\/local\/attachments\/[^/]+\/file$/.test(legacy.pathname))
          return `${localOrigin}${legacy.pathname}${legacy.search}`
      } catch { return null }
      return urlOrPath
    }
    const localRoute = resolveLocalRoute(urlOrPath, localOrigin)
    if (localRoute) return localRoute
    if (urlOrPath.startsWith('/uploads')) return null
    if (urlOrPath.startsWith('/')) return `${localOrigin}${urlOrPath}`
  }

  if (!filePath) return null
  const normalizedPath = filePath.replace(/\\/g, '/')
  if (normalizedPath.startsWith('data/uploads/') || normalizedPath.startsWith('/uploads')) return null
  const localRoute = resolveLocalRoute(normalizedPath, localOrigin)
  if (localRoute) return localRoute
  if (isAbsoluteFilesystemPath(normalizedPath) && !isServerRelativePath(normalizedPath)) return null
  if (normalizedPath.startsWith('/')) return `${localOrigin}${normalizedPath}`
  return `${localOrigin}/${normalizedPath}`
}
