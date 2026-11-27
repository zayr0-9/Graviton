import { FileInsertionError } from './fileInsertionError'

export const FILE_INSERTION_MAX_FILES = 10
export const FILE_INSERTION_MAX_BYTES = 10 * 1024 * 1024
export const FILE_INSERTION_MAX_CHARS = 100_000

export type FileProcessor = {
  extensions: readonly string[]
  mimeTypes: readonly string[]
  process: (file: File, signal: AbortSignal, maxChars: number) => Promise<string>
}

export const isImageFile = (file: Pick<File, 'type'>): boolean => file.type.startsWith('image/')

type FileTransfer = Pick<DataTransfer, 'files' | 'items'>

/** Read synchronously, while the paste/drop event still grants access. */
export function getTransferredFiles(transfer: FileTransfer): File[] {
  // Prefer the complete FileList when available; it and items normally describe the same files.
  const files = Array.from(transfer.files ?? [])
  if (files.length) return files
  return Array.from(transfer.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file != null)
}

const textProcessor: FileProcessor = {
  extensions: ['.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml'],
  mimeTypes: ['application/json', 'application/x-ndjson', 'application/xml', 'application/yaml'],
  async process(file, signal, maxChars) {
    if (file.size > maxChars * 4 + 3) throw new FileInsertionError('Too much text to insert. Try a smaller excerpt.')
    const buffer = await file.arrayBuffer()
    signal.throwIfAborted()
    const bytes = new Uint8Array(buffer)
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    let text: string
    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(buffer)
    } catch {
      throw new FileInsertionError('Not valid UTF-8 or BOM-marked UTF-16 text.')
    }
    if (text.includes('\0')) throw new FileInsertionError('Not a plain text file.')
    if (text.length > maxChars) throw new FileInsertionError('Too much text to insert. Try a smaller excerpt.')
    return text
  },
}

export const defaultFileProcessors: readonly FileProcessor[] = [
  {
    extensions: ['.pdf'],
    mimeTypes: ['application/pdf'],
    process: async (file, signal, maxChars) => {
      const { extractTextFromPdf } = await import('../../utils/pdfUtils')
      const controller = new AbortController()
      const abort = () => controller.abort(signal.reason)
      signal.throwIfAborted()
      signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new FileInsertionError('Reading this PDF took too long. Try a smaller excerpt.')), 15_000)
      try {
        return await extractTextFromPdf(file, { signal: controller.signal, maxChars, maxPages: 300 })
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    },
  },
  {
    extensions: ['.docx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    process: async (file, signal, maxChars) => {
      const { extractOfficeText } = await import('./officeText')
      return extractOfficeText('docx', file, signal, maxChars)
    },
  },
  {
    extensions: ['.xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    process: async (file, signal, maxChars) => {
      const { extractOfficeText } = await import('./officeText')
      return extractOfficeText('xlsx', file, signal, maxChars)
    },
  },
  textProcessor,
]

export function getFileInsertionAccept(processors = defaultFileProcessors): string {
  return [...new Set(processors.flatMap(processor => [...processor.extensions, ...processor.mimeTypes]))].join(',')
}

export function findFileProcessor(file: Pick<File, 'name' | 'type'>, processors = defaultFileProcessors): FileProcessor | undefined {
  const name = file.name.toLowerCase()
  const mime = file.type.split(';')[0].trim().toLowerCase()
  return processors.find(processor => processor.extensions.some(extension => name.endsWith(extension)))
    ?? processors.find(processor => processor.mimeTypes.includes(mime))
    ?? (mime.startsWith('text/') && processors.includes(textProcessor) ? textProcessor : undefined)
}

export type FileInsertionBatch = { text: string; errors: string[] }

/** Process in input order; a bad file never discards a successful sibling. */
export async function processInsertionFiles(
  files: readonly File[],
  { signal, processors = defaultFileProcessors, format = formatFileInsertion }: {
    signal: AbortSignal
    processors?: readonly FileProcessor[]
    format?: (name: string, text: string) => string
  },
): Promise<FileInsertionBatch> {
  const blocks: string[] = []
  const errors: string[] = []
  let remaining = FILE_INSERTION_MAX_CHARS
  let bytes = 0
  if (files.length > FILE_INSERTION_MAX_FILES) errors.push(`Only the first ${FILE_INSERTION_MAX_FILES} files were processed.`)
  for (const file of files.slice(0, FILE_INSERTION_MAX_FILES)) {
    signal.throwIfAborted()
    const name = displayFileName(file.name)
    try {
      const processor = findFileProcessor(file, processors)
      if (!processor || (processor === textProcessor && /\.(doc|xls)$/i.test(file.name))) {
        throw new FileInsertionError(/\.(doc|xls)$/i.test(file.name) ? 'Save as .docx or .xlsx and try again.' : 'Unsupported file type.')
      }
      if (!file.size) throw new FileInsertionError('The file is empty.')
      if (bytes + file.size > FILE_INSERTION_MAX_BYTES) throw new FileInsertionError('File import is limited to 10 MB per batch.')
      bytes += file.size
      const maxChars = remaining - (blocks.length ? 2 : 0)
      if (maxChars <= 0) throw new FileInsertionError('Too much text to insert. Try fewer files.')
      const text = (await processor.process(file, signal, maxChars)).replace(/\r\n?/g, '\n')
      signal.throwIfAborted()
      if (!text.trim()) {
        throw new FileInsertionError(processor.extensions.includes('.pdf')
          ? 'No selectable text found. Scanned PDFs need OCR.' : 'No readable text found.')
      }
      const block = format(name, text)
      if (block.length > maxChars) throw new FileInsertionError('Too much text to insert. Try a smaller excerpt.')
      blocks.push(block)
      remaining = maxChars - block.length
    } catch (error) {
      signal.throwIfAborted()
      errors.push(`${name}: ${error instanceof FileInsertionError ? error.message : 'Could not read this file.'}`)
    }
  }
  return { text: blocks.join('\n\n'), errors }
}

function displayFileName(name: string): string {
  // Keep control characters in filesystem names out of labels and fenced headers.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) || 'Unnamed file'
}

export function formatFileInsertion(name: string, text: string): string {
  const content = `File: ${name}\n\n${text}`
  let length = 3
  for (const match of content.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const fence = '`'.repeat(length)
  return `${fence}\n${content}\n${fence}`
}

/** Keep imported file blocks verbatim when chat expands workspace @mentions. */
export function mapOutsideFileInsertions(value: string, map: (text: string) => string): string {
  const lines = value.split('\n')
  const parts: string[] = []
  let plainStart = 0
  for (let index = 0; index < lines.length - 1; index++) {
    const fence = /^(`{3,})\s*$/.exec(lines[index])?.[1]
    if (!fence || !lines[index + 1].startsWith('File: ')) continue
    const end = lines.indexOf(fence, index + 2)
    if (end === -1) break
    if (index > plainStart) parts.push(map(lines.slice(plainStart, index).join('\n')))
    parts.push(lines.slice(index, end + 1).join('\n'))
    plainStart = end + 1
    index = end
  }
  if (plainStart < lines.length) parts.push(map(lines.slice(plainStart).join('\n')))
  return parts.join('\n')
}

export function insertFileText(value: string, text: string, start: number, end: number) {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const block = `${before && !before.endsWith('\n') ? '\n' : ''}${text}${after && !after.startsWith('\n') ? '\n' : ''}`
  return { value: before + block + after, cursor: start + block.length }
}
