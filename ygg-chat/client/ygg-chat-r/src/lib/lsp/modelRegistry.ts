import * as monaco from 'monaco-editor'
import { fromFileUri, toFileUri } from './uri'

type TrackedModelEntry = {
  refCount: number
}

export type TrackedModelContentChangeEvent = {
  filePath: string
  content: string
}

const trackedModels = new Map<string, TrackedModelEntry>()
const modelContentDisposables = new Map<string, monaco.IDisposable>()
const modelContentListeners = new Set<(event: TrackedModelContentChangeEvent) => void>()

function getUriKey(filePath: string): string {
  return toFileUri(filePath).toString()
}

function notifyModelContentChange(filePath: string, content: string): void {
  modelContentListeners.forEach(listener => listener({ filePath, content }))
}

function ensureModelTracking(model: monaco.editor.ITextModel): void {
  const uriKey = model.uri.toString()
  if (modelContentDisposables.has(uriKey)) return

  const disposable = model.onDidChangeContent(() => {
    const filePath = fromFileUri(model.uri)
    if (!filePath) return
    notifyModelContentChange(filePath, model.getValue())
  })

  modelContentDisposables.set(uriKey, disposable)
}

function disposeModelTracking(uriKey: string): void {
  const disposable = modelContentDisposables.get(uriKey)
  if (disposable) {
    disposable.dispose()
    modelContentDisposables.delete(uriKey)
  }
}

export function onTrackedModelContentChange(
  listener: (event: TrackedModelContentChangeEvent) => void
): monaco.IDisposable {
  modelContentListeners.add(listener)
  return {
    dispose: () => {
      modelContentListeners.delete(listener)
    },
  }
}

export function getModel(filePath: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModel(toFileUri(filePath)) || null
}

export function getOrCreateModel(
  filePath: string,
  content: string,
  monacoLanguageId: string
): monaco.editor.ITextModel {
  const uri = toFileUri(filePath)
  const existingModel = monaco.editor.getModel(uri)
  if (existingModel) {
    if (existingModel.getLanguageId() !== monacoLanguageId) {
      monaco.editor.setModelLanguage(existingModel, monacoLanguageId)
    }
    ensureModelTracking(existingModel)
    return existingModel
  }

  const model = monaco.editor.createModel(content, monacoLanguageId, uri)
  ensureModelTracking(model)
  return model
}

export function retainModel(filePath: string, content: string, monacoLanguageId: string): monaco.editor.ITextModel {
  const uriKey = getUriKey(filePath)
  const existingEntry = trackedModels.get(uriKey)
  trackedModels.set(uriKey, {
    refCount: (existingEntry?.refCount || 0) + 1,
  })
  return getOrCreateModel(filePath, content, monacoLanguageId)
}

export function setModelContent(filePath: string, content: string): void {
  const model = getModel(filePath)
  if (!model || model.getValue() === content) return
  model.setValue(content)
}

export function releaseModel(filePath: string): void {
  const uriKey = getUriKey(filePath)
  const existingEntry = trackedModels.get(uriKey)
  if (!existingEntry) {
    disposeModel(filePath)
    return
  }

  const nextRefCount = existingEntry.refCount - 1
  if (nextRefCount > 0) {
    trackedModels.set(uriKey, { refCount: nextRefCount })
    return
  }

  trackedModels.delete(uriKey)
  disposeModel(filePath)
}

export function disposeModel(filePath: string): void {
  const uri = toFileUri(filePath)
  const uriKey = uri.toString()
  trackedModels.delete(uriKey)
  disposeModelTracking(uriKey)
  const model = monaco.editor.getModel(uri)
  if (model) {
    model.dispose()
  }
}
