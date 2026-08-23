export interface AttachmentUrlInput {
  urlOrPath?: string | null
  filePath?: string | null
  attachmentId?: string | null
  localOrigin: string
  localApiBase: string
  remoteOrigin: string
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
 * server filesystem path. Local attachment routes always use the resolved Ygg
 * origin; cloud/upload paths continue to use the configured remote origin.
 */
export function resolveAttachmentUrlFromOrigins({
  urlOrPath,
  filePath,
  attachmentId,
  localOrigin,
  localApiBase,
  remoteOrigin,
}: AttachmentUrlInput): string | null {
  if (attachmentId && filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/')
    if (isAbsoluteFilesystemPath(normalizedPath)) {
      return `${localApiBase}/local/attachments/${encodeURIComponent(attachmentId)}/file`
    }
  }

  if (urlOrPath) {
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath
    const localRoute = resolveLocalRoute(urlOrPath, localOrigin)
    if (localRoute) return localRoute
    if (urlOrPath.startsWith('/')) return `${remoteOrigin}${urlOrPath}`
  }

  if (!filePath) return null
  const normalizedPath = filePath.replace(/\\/g, '/')
  if (normalizedPath.startsWith('data/uploads/')) {
    const filename = normalizedPath.split('/').pop() || ''
    return filename ? `${remoteOrigin}/uploads/${filename}` : null
  }
  const localRoute = resolveLocalRoute(normalizedPath, localOrigin)
  if (localRoute) return localRoute
  if (isAbsoluteFilesystemPath(normalizedPath) && !isServerRelativePath(normalizedPath)) return null
  if (normalizedPath.startsWith('/')) return `${remoteOrigin}${normalizedPath}`
  return `${remoteOrigin}/${normalizedPath}`
}
