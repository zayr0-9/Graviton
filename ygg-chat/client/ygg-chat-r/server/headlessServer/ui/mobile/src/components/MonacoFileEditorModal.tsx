import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import type * as MonacoEditor from 'monaco-editor'
import { Button } from './ui'

interface MonacoFileEditorModalProps {
  open: boolean
  filePath: string | null
  value: string
  loading: boolean
  error: string | null
  isDirty: boolean
  isSaving: boolean
  onChange: (nextValue: string) => void
  onSave: () => void
  onClose: () => void
}

const extensionLanguageMap: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  txt: 'plaintext',
}

const detectLanguage = (filePath: string | null): string => {
  if (!filePath) return 'plaintext'
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === filePath.length - 1) return 'plaintext'
  const extension = filePath.slice(dotIndex + 1).toLowerCase()
  return extensionLanguageMap[extension] || 'plaintext'
}

export const MonacoFileEditorModal: React.FC<MonacoFileEditorModalProps> = ({
  open,
  filePath,
  value,
  loading,
  error,
  isDirty,
  isSaving,
  onChange,
  onSave,
  onClose,
}) => {
  const [hasOpened, setHasOpened] = useState(false)
  const editorRef = useRef<MonacoEditor.editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    if (open) setHasOpened(true)
  }, [open])

  useEffect(() => {
    if (!open) return

    const runLayout = () => {
      editorRef.current?.layout()
    }

    const rafId = window.requestAnimationFrame(() => {
      runLayout()
      window.setTimeout(runLayout, 60)
    })

    const onResize = () => runLayout()
    window.addEventListener('resize', onResize)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onEscape)
    return () => {
      document.body.style.overflow = previousBodyOverflow
      window.removeEventListener('keydown', onEscape)
    }
  }, [open, onClose])

  const language = useMemo(() => detectLanguage(filePath), [filePath])

  if (!hasOpened || typeof document === 'undefined') return null

  return createPortal(
    <div className={`mobile-monaco-modal-root${open ? '' : ' is-hidden'}`} aria-hidden={!open}>
      <div className='mobile-monaco-modal' role='dialog' aria-modal='true' aria-label='File editor'>
        <header className='mobile-monaco-modal-header'>
          <div className='mobile-monaco-modal-meta'>
            <strong>{filePath || 'File editor'}</strong>
            <small>{language}</small>
          </div>

          <div className='mobile-monaco-modal-actions'>
            <Button variant='secondary' size='sm' onClick={onSave} disabled={!filePath || loading || isSaving || !isDirty}>
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant='outline' size='sm' onClick={onClose} aria-label='Close editor'>
              ✕
            </Button>
          </div>
        </header>

        {error ? <div className='mobile-monaco-modal-error'>{error}</div> : null}

        <div className='mobile-monaco-editor-host'>
          <Editor
            theme='vs-dark'
            language={language}
            value={value}
            width='100%'
            height='100%'
            onMount={editor => {
              editorRef.current = editor
              window.requestAnimationFrame(() => editor.layout())
            }}
            onChange={next => onChange(next ?? '')}
            options={{
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: 'on',
              smoothScrolling: true,
              scrollBeyondLastLine: false,
              tabSize: 2,
            }}
          />

          {loading ? <div className='mobile-monaco-loading'>Loading…</div> : null}
        </div>
      </div>
    </div>,
    document.body
  )
}
