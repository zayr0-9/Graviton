import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { FileInsertionError } from '../features/fileInsertion/fileInsertionError'

GlobalWorkerOptions.workerSrc = workerUrl

interface PdfTextItem {
  str?: string
  transform?: number[]
  height?: number
}

const buildLineAwareText = (items: PdfTextItem[]): string => {
  const lines: { y: number; text: string }[] = []

  for (const item of items) {
    const text = item.str?.replace(/\s+/g, ' ')?.trim()
    if (!text) continue

    const y = typeof item.transform?.[5] === 'number' ? item.transform[5] : 0
    const heightEstimate = item.height ?? 0
    const threshold = Math.max(6, heightEstimate * 0.5, 4)

    const lastLine = lines[lines.length - 1]
    if (!lastLine || Math.abs(lastLine.y - y) > threshold) {
      lines.push({ y, text })
      continue
    }

    const separator = lastLine.text.endsWith('-') ? '' : ' '
    lastLine.text += `${separator}${text}`
    lastLine.y = (lastLine.y + y) / 2
  }

  return lines
    .map(line => line.text.trim())
    .filter(Boolean)
    .join('\n')
}

export async function extractTextFromPdf(
  file: File,
  { signal, maxChars = Infinity, maxPages = Infinity }: { signal?: AbortSignal; maxChars?: number; maxPages?: number } = {},
): Promise<string> {
  const data = await file.arrayBuffer()
  signal?.throwIfAborted()
  const loadingTask = getDocument({ data, isEvalSupported: false, useSystemFonts: false })
  const destroy = () => loadingTask.destroy().catch(() => undefined)
  let cleanup: Promise<void | undefined> | undefined
  const abort = () => { cleanup ??= destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const pdf = await loadingTask.promise
    if (pdf.numPages > maxPages) throw new FileInsertionError(`PDFs are limited to ${maxPages} pages. Try a smaller excerpt.`)
    let fullText = ''

    for (let i = 1; i <= pdf.numPages; i++) {
      signal?.throwIfAborted()
      const page = await pdf.getPage(i)
      const textContent = await page.getTextContent()
      const pageText = buildLineAwareText(textContent.items as PdfTextItem[])

      page.cleanup()
      if (pageText) {
        if (fullText.length + pageText.length > maxChars) throw new FileInsertionError('Too much text to insert. Try a smaller excerpt.')
        fullText += pageText + '\n\n'
      }
    }

    return fullText.trim()
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new FileInsertionError('This PDF is password-protected.')
    }
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    await (cleanup ?? destroy())
  }
}
