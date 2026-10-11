import { lazy } from 'react'

/**
 * Lazy boundary around everything that imports monaco-editor: the two dock panes, the
 * model registry and the LSP client pool. The right bar reaches them only through
 * loadMonacoWorkspace(), so Monaco downloads the first time a file or diff opens
 * instead of at startup.
 */
export type MonacoWorkspace = typeof import('./monacoWorkspaceModules')

type MonacoWorkspaceListener = (workspace: MonacoWorkspace) => void

let pending: Promise<MonacoWorkspace> | null = null
let loaded: MonacoWorkspace | null = null
const loadListeners = new Set<MonacoWorkspaceListener>()

/** Loads the workspace once. Callbacks chained on the result run in call order. */
export function loadMonacoWorkspace(): Promise<MonacoWorkspace> {
  if (!pending) {
    pending = import('./monacoWorkspaceModules').then(workspace => {
      loaded = workspace
      for (const listener of loadListeners) {
        listener(workspace)
      }
      return workspace
    })
  }
  return pending
}

/**
 * Runs `listener` once the workspace is loaded, without triggering the load. Returns a
 * function that cancels the wait. Runs synchronously when the workspace is already loaded.
 */
export function whenMonacoWorkspaceLoaded(listener: MonacoWorkspaceListener): () => void {
  if (loaded) {
    listener(loaded)
    return () => {}
  }
  loadListeners.add(listener)
  return () => {
    loadListeners.delete(listener)
  }
}

export const LazyMonacoFileEditorPane = lazy(() =>
  loadMonacoWorkspace().then(workspace => ({ default: workspace.MonacoFileEditorPane }))
)

export const LazyMonacoGitDiffPane = lazy(() =>
  loadMonacoWorkspace().then(workspace => ({ default: workspace.MonacoGitDiffPane }))
)
