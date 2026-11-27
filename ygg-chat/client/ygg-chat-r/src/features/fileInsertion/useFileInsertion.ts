import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { insertFileText, processInsertionFiles, type FileProcessor } from './fileInsertion'

type FileInsertionOptions = {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  value: string
  onChange?: (value: string, cursor: number) => void
  enabled: boolean
  scope?: string
  multiline?: boolean
  processors?: readonly FileProcessor[]
  format?: (name: string, text: string) => string
}

export type InputFileInsertionHandle = {
  insertFiles: (files: readonly File[]) => boolean
  isPending: () => boolean
}

/** Bind the file engine to one controlled input. No document-wide listeners or draft storage. */
export function useFileInsertion(options: FileInsertionOptions) {
  const { enabled, scope, value } = options
  const latest = useRef(options)
  const job = useRef<AbortController | null>(null)
  const wantedCursor = useRef<{ value: string; position: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const revision = useRef(0)

  useLayoutEffect(() => { latest.current = options })
  useLayoutEffect(() => {
    setPending(false)
    setErrors([])
    return () => {
      job.current?.abort()
      job.current = null
      wantedCursor.current = null
    }
  }, [enabled, scope])
  useLayoutEffect(() => { revision.current += 1 }, [value])
  useLayoutEffect(() => {
    const cursor = wantedCursor.current
    const field = latest.current.inputRef.current
    if (cursor && cursor.value === value && field && document.activeElement === field) {
      field.setSelectionRange(cursor.position, cursor.position)
    }
    wantedCursor.current = null
  })

  const isPending = useCallback(() => job.current !== null, [])
  const cancel = useCallback(() => {
    job.current?.abort()
    job.current = null
    setPending(false)
    setErrors([])
  }, [])
  const dismiss = useCallback(() => setErrors([]), [])
  const insertFiles = useCallback((files: readonly File[]) => {
    const start = latest.current
    const field = start.inputRef.current
    if (!start.enabled || !field || field.disabled || field.readOnly || !start.onChange || !files.length) return false
    if (job.current) {
      setErrors(['Wait for the current file import or cancel it before adding more files.'])
      return true
    }
    const selectionStart = field.selectionStart ?? start.value.length
    const selectionEnd = field.selectionEnd ?? selectionStart
    const startRevision = revision.current
    const controller = new AbortController()
    job.current = controller
    setPending(true)
    setErrors([])

    void processInsertionFiles(files, {
      signal: controller.signal, processors: start.processors, format: start.format,
    }).then(result => {
      if (job.current !== controller) return
      const current = latest.current
      setErrors(result.errors)
      if (!result.text || current.inputRef.current !== field || field.disabled || field.readOnly) return
      const value = field.value
      // An edit during extraction invalidates the saved range, not the imported text.
      const unchanged = revision.current === startRevision && value === start.value
      const from = unchanged ? selectionStart : value.length
      const to = unchanged ? selectionEnd : value.length
      const next = current.multiline === false
        ? insertSingleLine(value, result.text, from, to)
        : insertFileText(value, result.text, from, to)
      if (field.maxLength >= 0 && next.value.length > field.maxLength) {
        setErrors([...result.errors, 'The imported text does not fit in this field.'])
        return
      }
      wantedCursor.current = { value: next.value, position: next.cursor }
      current.onChange?.(next.value, next.cursor)
    }).catch(() => {
      if (job.current === controller) setErrors(['Could not insert the selected files.'])
    }).finally(() => {
      if (job.current !== controller) return
      job.current = null
      setPending(false)
    })
    return true
  }, [])
  return { insertFiles, isPending, pending, errors, cancel, dismiss }
}

function insertSingleLine(value: string, text: string, start: number, end: number) {
  const insertion = text.replace(/\n+/g, ' ')
  return { value: value.slice(0, start) + insertion + value.slice(end), cursor: start + insertion.length }
}
