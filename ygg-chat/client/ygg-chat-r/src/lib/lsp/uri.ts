import * as monaco from 'monaco-editor'

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function toFileUri(filePath: string): monaco.Uri {
  return monaco.Uri.file(filePath)
}

export function toFileUriString(filePath: string): string {
  return toFileUri(filePath).toString()
}

export function fromFileUri(uri: string | monaco.Uri | null | undefined): string | null {
  if (!uri) return null

  const parsed = typeof uri === 'string' ? monaco.Uri.parse(uri) : uri
  if (parsed.scheme !== 'file') return null

  const authority = decodePathSegment(parsed.authority || '')
  const decodedPath = decodePathSegment(parsed.path || '')

  if (/^\/[a-zA-Z]:\//.test(decodedPath)) {
    return decodedPath.slice(1).replace(/\//g, '\\')
  }

  if (authority) {
    const normalizedPath = decodedPath.replace(/\//g, '\\')
    return `\\\\${authority}${normalizedPath}`
  }

  return decodedPath
}

export function getFilePathFromModel(model: monaco.editor.ITextModel | null | undefined): string | null {
  if (!model) return null
  return fromFileUri(model.uri)
}
