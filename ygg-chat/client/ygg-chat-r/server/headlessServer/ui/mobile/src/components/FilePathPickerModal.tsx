import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { mobileApi } from '../api'
import type { MobileLocalFileEntry } from '../types'
import { Button } from './ui'
import { MonacoFileEditorModal } from './MonacoFileEditorModal'

interface FilePathPickerModalProps {
  open: boolean
  rootPath: string | null
  onClose: () => void
  onInsertPath: (path: string) => void
}

type PersistedFilePickerState = {
  currentPath: string | null
  pathHistory: string[]
  scrollTop: number
  searchQuery: string
  followGitignore: boolean
}

type EditorFileState = {
  content: string
  loading: boolean
  error: string | null
  dirty: boolean
  saving: boolean
  loaded: boolean
}

const FILE_PICKER_STATE_STORAGE_KEY = 'mobile:file-picker-state:v1'

const createEditorFileState = (): EditorFileState => ({
  content: '',
  loading: false,
  error: null,
  dirty: false,
  saving: false,
  loaded: false,
})

const normalizePath = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const getStorageBucket = (): Record<string, PersistedFilePickerState> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(FILE_PICKER_STATE_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PersistedFilePickerState>) : {}
  } catch {
    return {}
  }
}

const writeStorageBucket = (bucket: Record<string, PersistedFilePickerState>) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FILE_PICKER_STATE_STORAGE_KEY, JSON.stringify(bucket))
  } catch {
    // ignore persistence errors
  }
}

const getStateKey = (rootPath: string | null): string => rootPath || '__none__'

const readPersistedState = (stateKey: string): PersistedFilePickerState | null => {
  const bucket = getStorageBucket()
  const value = bucket[stateKey]
  if (!value || typeof value !== 'object') return null

  return {
    currentPath: normalizePath(value.currentPath),
    pathHistory: Array.isArray(value.pathHistory) ? value.pathHistory.filter(item => typeof item === 'string') : [],
    scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0,
    searchQuery: typeof value.searchQuery === 'string' ? value.searchQuery : '',
    followGitignore: value.followGitignore !== false,
  }
}

const writePersistedState = (stateKey: string, state: PersistedFilePickerState) => {
  const bucket = getStorageBucket()
  bucket[stateKey] = state
  writeStorageBucket(bucket)
}

export const FilePathPickerModal: React.FC<FilePathPickerModalProps> = ({ open, rootPath, onClose, onInsertPath }) => {
  const normalizedRootPath = useMemo(() => normalizePath(rootPath), [rootPath])
  const stateKey = useMemo(() => getStateKey(normalizedRootPath), [normalizedRootPath])

  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [pathHistory, setPathHistory] = useState<string[]>([])
  const [files, setFiles] = useState<MobileLocalFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [followGitignore, setFollowGitignore] = useState(true)
  const [searchResults, setSearchResults] = useState<MobileLocalFileEntry[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [isRespectingGitignore, setIsRespectingGitignore] = useState(true)

  const [listScrollTop, setListScrollTop] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editorPath, setEditorPath] = useState<string | null>(null)
  const [editorFiles, setEditorFiles] = useState<Record<string, EditorFileState>>({})

  useEffect(() => {
    if (!open) return

    const restored = readPersistedState(stateKey)

    if (restored) {
      setCurrentPath(restored.currentPath || normalizedRootPath)
      setPathHistory(restored.pathHistory)
      setSearchQuery(restored.searchQuery)
      setFollowGitignore(restored.followGitignore)
      setListScrollTop(restored.scrollTop)
    } else {
      setCurrentPath(normalizedRootPath)
      setPathHistory([])
      setSearchQuery('')
      setFollowGitignore(true)
      setListScrollTop(0)
    }

    setError(null)
    setSearchError(null)
    setIsRespectingGitignore(restored ? restored.followGitignore : true)
  }, [open, normalizedRootPath, stateKey])

  useEffect(() => {
    if (!open) return

    writePersistedState(stateKey, {
      currentPath,
      pathHistory,
      searchQuery,
      followGitignore,
      scrollTop: listScrollTop,
    })
  }, [open, stateKey, currentPath, pathHistory, searchQuery, followGitignore, listScrollTop])

  useEffect(() => {
    if (!open || !currentPath) return

    let cancelled = false

    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const payload = await mobileApi.listLocalFiles(currentPath)
        if (cancelled) return
        setFiles(payload.files)
      } catch (err) {
        if (cancelled) return
        setFiles([])
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, [open, currentPath])

  const searchBasePath = normalizedRootPath || currentPath
  const activeSearchQuery = searchQuery.trim()
  const isSearchMode = activeSearchQuery.length > 0

  useEffect(() => {
    if (!open) return

    if (!activeSearchQuery) {
      setSearchResults([])
      setSearching(false)
      setSearchError(null)
      return
    }

    if (!searchBasePath) {
      setSearchResults([])
      setSearching(false)
      setSearchError('Set conversation/project cwd first')
      return
    }

    let cancelled = false
    const timeoutId = window.setTimeout(async () => {
      setSearching(true)
      setSearchError(null)
      try {
        const payload = await mobileApi.searchLocalFiles({
          directoryPath: searchBasePath,
          query: activeSearchQuery,
          limit: 200,
          followGitignore,
        })
        if (cancelled) return
        setSearchResults(payload.files)
        setIsRespectingGitignore(payload.respectingGitignore)
      } catch (err) {
        if (cancelled) return
        setSearchResults([])
        setSearchError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 220)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [open, activeSearchQuery, searchBasePath, followGitignore])

  useEffect(() => {
    if (!open) return

    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleEscape)

    return () => {
      document.body.style.overflow = previousBodyOverflow
      window.removeEventListener('keydown', handleEscape)
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const node = listRef.current
    if (!node) return
    node.scrollTop = listScrollTop
  }, [open, listScrollTop, loading, searching, files, searchResults, isSearchMode])

  const canGoHome = useMemo(() => Boolean(normalizedRootPath && currentPath && normalizedRootPath !== currentPath), [normalizedRootPath, currentPath])
  const canGoBack = pathHistory.length > 0
  const displayedFiles = isSearchMode ? searchResults : files

  const openEditorForFile = async (filePath: string) => {
    setEditorPath(filePath)
    setEditorOpen(true)

    const current = editorFiles[filePath]
    if (current?.loaded || current?.loading) return

    setEditorFiles(prev => ({
      ...prev,
      [filePath]: {
        ...(prev[filePath] || createEditorFileState()),
        loading: true,
        error: null,
      },
    }))

    try {
      const payload = await mobileApi.getLocalFileContent(filePath)
      setEditorFiles(prev => ({
        ...prev,
        [filePath]: {
          ...(prev[filePath] || createEditorFileState()),
          content: payload.content,
          loading: false,
          error: null,
          dirty: false,
          saving: false,
          loaded: true,
        },
      }))
    } catch (err) {
      setEditorFiles(prev => ({
        ...prev,
        [filePath]: {
          ...(prev[filePath] || createEditorFileState()),
          loading: false,
          error: err instanceof Error ? err.message : String(err),
          loaded: true,
        },
      }))
    }
  }

  const activeEditorState = editorPath ? editorFiles[editorPath] || createEditorFileState() : createEditorFileState()

  const handleEditorChange = (nextValue: string) => {
    if (!editorPath) return
    setEditorFiles(prev => ({
      ...prev,
      [editorPath]: {
        ...(prev[editorPath] || createEditorFileState()),
        content: nextValue,
        dirty: true,
      },
    }))
  }

  const handleEditorSave = async () => {
    if (!editorPath) return
    const fileState = editorFiles[editorPath] || createEditorFileState()
    if (fileState.loading || fileState.saving || !fileState.dirty) return

    setEditorFiles(prev => ({
      ...prev,
      [editorPath]: {
        ...(prev[editorPath] || createEditorFileState()),
        saving: true,
        error: null,
      },
    }))

    try {
      await mobileApi.saveLocalFileContent(editorPath, fileState.content)
      setEditorFiles(prev => ({
        ...prev,
        [editorPath]: {
          ...(prev[editorPath] || createEditorFileState()),
          saving: false,
          dirty: false,
          loaded: true,
          error: null,
        },
      }))
    } catch (err) {
      setEditorFiles(prev => ({
        ...prev,
        [editorPath]: {
          ...(prev[editorPath] || createEditorFileState()),
          saving: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className='mobile-file-picker-portal-root'>
      <button
        type='button'
        aria-label='Close file picker'
        className='mobile-file-picker-portal-backdrop'
        onClick={onClose}
      />

      <section className='mobile-file-picker-portal' role='dialog' aria-modal='true' aria-label='Insert file path'>
        <header className='mobile-file-picker-header'>
          <div>
            <h2>Insert path</h2>
            <p>{currentPath || 'No working directory set'}</p>
          </div>
          <div className='mobile-file-picker-header-buttons'>
            <Button
              variant='ghost'
              size='sm'
              className='mobile-file-picker-gitignore-btn'
              onClick={() => setFollowGitignore(value => !value)}
              title='Toggle .gitignore-aware search'
            >
              {followGitignore ? '.gitignore ✓' : '.gitignore'}
            </Button>
            <Button variant='outline' size='sm' onClick={onClose}>
              Done
            </Button>
          </div>
        </header>

        <div className='mobile-file-picker-actions'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              if (!normalizedRootPath) return
              setCurrentPath(normalizedRootPath)
              setListScrollTop(0)
            }}
            disabled={!canGoHome}
          >
            Root
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              const previous = pathHistory[pathHistory.length - 1]
              if (!previous) return
              setPathHistory(history => history.slice(0, -1))
              setCurrentPath(previous)
              setListScrollTop(0)
            }}
            disabled={!canGoBack}
          >
            Back
          </Button>
          <Button
            variant='secondary'
            size='sm'
            onClick={() => {
              if (currentPath) onInsertPath(currentPath)
            }}
            disabled={!currentPath}
          >
            + Current dir
          </Button>
        </div>

        <div className='mobile-file-picker-search'>
          <input
            type='search'
            className='ui-input mobile-file-picker-search-input'
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder='Search in cwd (recursive)…'
            disabled={!searchBasePath}
          />
          <Button
            variant='ghost'
            size='sm'
            onClick={() => {
              setSearchQuery('')
              setSearchResults([])
              setSearchError(null)
            }}
            disabled={searchQuery.length === 0}
          >
            Clear
          </Button>
        </div>

        <div className='mobile-file-picker-search-hint'>
          {searchBasePath
            ? `Searching in: ${searchBasePath} ${followGitignore ? (isRespectingGitignore ? '(respects .gitignore)' : '(git repo not detected; fallback search)') : '(ignoring .gitignore)'}`
            : 'Set conversation/project cwd first'}
        </div>

        <div
          ref={listRef}
          className='mobile-file-picker-list'
          onScroll={event => setListScrollTop(event.currentTarget.scrollTop)}
        >
          {!isSearchMode && loading ? <div className='mobile-file-picker-muted'>Loading files…</div> : null}
          {!isSearchMode && error ? <div className='mobile-file-picker-error'>{error}</div> : null}
          {!isSearchMode && !loading && !error && files.length === 0 ? (
            <div className='mobile-file-picker-muted'>Empty directory</div>
          ) : null}

          {isSearchMode && searching ? <div className='mobile-file-picker-muted'>Searching subdirectories…</div> : null}
          {isSearchMode && searchError ? <div className='mobile-file-picker-error'>{searchError}</div> : null}
          {isSearchMode && !searching && !searchError && searchResults.length === 0 ? (
            <div className='mobile-file-picker-muted'>No matches</div>
          ) : null}

          {displayedFiles.map(file => (
            <div className='mobile-file-picker-row' key={`${isSearchMode ? 'search' : 'list'}-${file.path}`}>
              <button
                type='button'
                className='mobile-file-picker-item'
                onClick={() => {
                  if (!file.isDirectory) return
                  setPathHistory(history => {
                    if (!currentPath || currentPath === file.path) return history
                    return [...history, currentPath]
                  })
                  setCurrentPath(file.path)
                  setListScrollTop(0)
                  if (isSearchMode) {
                    setSearchQuery('')
                    setSearchResults([])
                    setSearchError(null)
                  }
                }}
                disabled={!file.isDirectory}
                title={file.path}
              >
                <span className='mobile-file-picker-item-icon'>{file.isDirectory ? '📁' : '📄'}</span>
                <span className='mobile-file-picker-item-labels'>
                  <span className='mobile-file-picker-item-name'>{file.name}</span>
                  {isSearchMode && file.relativePath && file.relativePath !== file.name ? (
                    <span className='mobile-file-picker-item-subpath'>{file.relativePath}</span>
                  ) : null}
                </span>
              </button>

              <div className='mobile-file-picker-row-actions'>
                {!file.isDirectory ? (
                  <Button
                    variant='ghost'
                    size='sm'
                    className='mobile-file-picker-edit-btn'
                    onClick={() => {
                      void openEditorForFile(file.path)
                    }}
                    title='Edit file'
                    aria-label={`Edit ${file.name}`}
                  >
                    ✎
                  </Button>
                ) : null}

                <Button
                  variant='ghost'
                  size='sm'
                  className='mobile-file-picker-insert-btn'
                  onClick={() => onInsertPath(file.path)}
                  title='Insert path'
                >
                  +
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <MonacoFileEditorModal
        open={editorOpen}
        filePath={editorPath}
        value={activeEditorState.content}
        loading={activeEditorState.loading}
        error={activeEditorState.error}
        isDirty={activeEditorState.dirty}
        isSaving={activeEditorState.saving}
        onChange={handleEditorChange}
        onSave={() => {
          void handleEditorSave()
        }}
        onClose={() => setEditorOpen(false)}
      />
    </div>,
    document.body
  )
}
