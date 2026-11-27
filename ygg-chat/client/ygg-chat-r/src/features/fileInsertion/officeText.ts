import { FileInsertionError } from './fileInsertionError'
import OfficeTextWorker from './officeText.worker?worker'

export type OfficeKind = 'docx' | 'xlsx'
export type OfficeRequest = { kind: OfficeKind; data: ArrayBuffer; maxChars: number }
export type OfficeResponse = { text: string } | { error: string }

export async function extractOfficeText(kind: OfficeKind, file: File, signal: AbortSignal, maxChars: number): Promise<string> {
  const data = await file.arrayBuffer()
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new OfficeTextWorker()
    const finish = () => {
      window.clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      worker.terminate()
    }
    const abort = () => { finish(); reject(signal.reason) }
    const timeout = window.setTimeout(() => {
      finish()
      reject(new FileInsertionError('Reading this file took too long. Try a smaller excerpt.'))
    }, 15_000)
    signal.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<OfficeResponse>) => {
      finish()
      if ('error' in event.data) reject(new FileInsertionError(event.data.error))
      else resolve(event.data.text)
    }
    worker.onerror = () => { finish(); reject(new FileInsertionError('Could not read this Office file.')) }
    try {
      worker.postMessage({ kind, data, maxChars } satisfies OfficeRequest, [data])
    } catch (error) {
      finish()
      reject(error)
    }
  })
}
