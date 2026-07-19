const ATTACHED_IMAGE_PATHS_OPEN = '<ygg-attached-image-paths-v1>'
const ATTACHED_IMAGE_PATHS_CLOSE = '</ygg-attached-image-paths-v1>'
const ATTACHED_IMAGE_PATHS_PATTERN = /\n*<ygg-attached-image-paths-v1>\s*([\s\S]*?)\s*<\/ygg-attached-image-paths-v1>\n*/g

export function extractAttachedImagePaths(content: string | null | undefined): string[] {
  if (typeof content !== 'string' || !content) return []

  const paths: string[] = []
  for (const match of content.matchAll(ATTACHED_IMAGE_PATHS_PATTERN)) {
    try {
      const parsed = JSON.parse(match[1])
      if (!Array.isArray(parsed)) continue
      for (const value of parsed) {
        if (typeof value === 'string' && value.trim()) paths.push(value.trim())
      }
    } catch {
      // Ignore malformed metadata blocks and leave the user-authored text renderable.
    }
  }
  return Array.from(new Set(paths))
}

export function stripAttachedImagePathMetadata(content: string | null | undefined): string {
  if (typeof content !== 'string' || !content) return ''
  return content.replace(ATTACHED_IMAGE_PATHS_PATTERN, '\n').trim()
}

export function appendAttachedImagePathMetadata(
  content: string | null | undefined,
  paths: Array<string | null | undefined>
): string {
  const visibleContent = stripAttachedImagePathMetadata(content)
  const existingPaths = extractAttachedImagePaths(content)
  const uniquePaths = Array.from(
    new Set([...existingPaths, ...paths].filter((value): value is string => typeof value === 'string' && !!value.trim()).map(value => value.trim()))
  )
  if (uniquePaths.length === 0) return visibleContent

  const metadata = `${ATTACHED_IMAGE_PATHS_OPEN}\n${JSON.stringify(uniquePaths)}\n${ATTACHED_IMAGE_PATHS_CLOSE}`
  return visibleContent ? `${visibleContent}\n\n${metadata}` : metadata
}
