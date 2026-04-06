import * as monaco from 'monaco-editor'
import { lspClientPool } from './lspClientPool'
import {
  EXECUTE_LSP_COMMAND_ID,
  type MonacoCodeActionWithLsp,
  type MonacoCompletionItemWithLsp,
  applyLspWorkspaceEdit,
  fromLspRange,
  mapLspCodeActionToMonaco,
  mapLspCompletionItemToMonaco,
  mapLspDefinitionToMonaco,
  mapLspDocumentHighlightsToMonaco,
  mapLspDocumentSymbolsToMonaco,
  mapLspHoverToMonaco,
  mapLspReferencesToMonaco,
  mapLspSignatureHelpToMonaco,
  mapLspTextEditsToMonaco,
  mapLspWorkspaceEditToMonaco,
  mergeResolvedCompletionItem,
  toLspCodeActionContext,
  toLspCompletionContext,
  toLspPosition,
  toLspRange,
  toLspSignatureHelpContext,
} from './monacoMappings'

let providersRegistered = false
const providerDisposables: monaco.IDisposable[] = []

const completionTriggerCharacters: Record<string, string[]> = {
  typescript: ['.', '"', "'", '`', '/', '@', '<'],
  javascript: ['.', '"', "'", '`', '/', '@', '<'],
  json: ['"', ':'],
  yaml: [':', ' '],
}

const signatureTriggerCharacters: Record<string, string[]> = {
  typescript: ['(', ',', '<'],
  javascript: ['(', ',', '<'],
  json: [],
  yaml: [],
}

const signatureRetriggerCharacters: Record<string, string[]> = {
  typescript: [','],
  javascript: [','],
  json: [],
  yaml: [],
}

const codeActionKinds = [
  '',
  'quickfix',
  'refactor',
  'refactor.extract',
  'refactor.inline',
  'refactor.rewrite',
  'source',
  'source.fixAll',
  'source.organizeImports',
]

function registerDisposable(disposable: monaco.IDisposable): void {
  providerDisposables.push(disposable)
}

function createSignatureHelpResult(value: monaco.languages.SignatureHelp): monaco.languages.SignatureHelpResult {
  return {
    value,
    dispose: () => {},
  }
}

function createCodeActionList(actions: monaco.languages.CodeAction[]): monaco.languages.CodeActionList {
  return {
    actions,
    dispose: () => {},
  }
}

function createRejectedRenameEdits(reason: string): monaco.languages.WorkspaceEdit & monaco.languages.Rejection {
  return {
    edits: [],
    rejectReason: reason,
  }
}

function createRejectedRenameLocation(reason: string): monaco.languages.RenameLocation & monaco.languages.Rejection {
  return {
    range: {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    },
    text: '',
    rejectReason: reason,
  }
}

function getFallbackRenameLocation(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): (monaco.languages.RenameLocation & monaco.languages.Rejection) | null {
  const word = model.getWordAtPosition(position)
  if (!word) return null

  return {
    range: {
      startLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn,
    },
    text: word.word,
  }
}

function registerCommandBridge(): void {
  registerDisposable(
    monaco.editor.registerCommand(EXECUTE_LSP_COMMAND_ID, (_accessor, payload: any) => {
      const uri = typeof payload?.uri === 'string' ? payload.uri : ''
      const command = typeof payload?.command === 'string' ? payload.command : ''
      const commandArguments = Array.isArray(payload?.arguments) ? payload.arguments : []
      if (!uri || !command) return
      void lspClientPool.executeCommandForUri(uri, command, commandArguments)
    })
  )
}

function registerCompletionProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: completionTriggerCharacters[languageId] || [],
      provideCompletionItems: async (model, position, context, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/completion',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
            context: toLspCompletionContext(context),
          },
          'completionProvider'
        )

        if (token.isCancellationRequested || !result) return null

        const items = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : []
        return {
          suggestions: items.map((item: any) => mapLspCompletionItemToMonaco({ item, model, position })),
          incomplete: Boolean(result?.isIncomplete),
        }
      },
      resolveCompletionItem: async (item, token) => {
        const completionItem = item as MonacoCompletionItemWithLsp
        if (token.isCancellationRequested || !completionItem.__lspItem || !completionItem.__lspUri) {
          return item
        }

        const resolvedItem = await lspClientPool.resolveCompletionItem(completionItem.__lspUri, completionItem.__lspItem)
        if (token.isCancellationRequested || !resolvedItem) {
          return item
        }

        return mergeResolvedCompletionItem(completionItem, resolvedItem)
      },
    })
  )
}

function markerContainsPosition(marker: monaco.editor.IMarker, position: monaco.Position): boolean {
  if (position.lineNumber < marker.startLineNumber || position.lineNumber > marker.endLineNumber) {
    return false
  }

  const startsBefore =
    position.lineNumber !== marker.startLineNumber || position.column >= marker.startColumn
  const endsAfter = position.lineNumber !== marker.endLineNumber || position.column <= marker.endColumn

  return startsBefore && endsAfter
}

function getMarkerHoverContents(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): monaco.IMarkdownString[] {
  return monaco.editor
    .getModelMarkers({ resource: model.uri })
    .filter(marker => markerContainsPosition(marker, position))
    .map(marker => {
      const source = String(marker.source || 'LSP')
      const code = marker.code == null ? '' : ` (${typeof marker.code === 'object' ? String(marker.code.value ?? '') : String(marker.code)})`
      const severity =
        marker.severity === monaco.MarkerSeverity.Error
          ? 'Error'
          : marker.severity === monaco.MarkerSeverity.Warning
            ? 'Warning'
            : marker.severity === monaco.MarkerSeverity.Info
              ? 'Info'
              : marker.severity === monaco.MarkerSeverity.Hint
                ? 'Hint'
                : 'Diagnostic'

      return {
        value: `**${severity}** · ${source}${code}\n\n${marker.message}`,
        isTrusted: false,
        supportHtml: false,
      }
    })
}

function getMarkerHoverRange(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): monaco.IRange | undefined {
  const marker = monaco.editor
    .getModelMarkers({ resource: model.uri })
    .find(candidate => markerContainsPosition(candidate, position))

  if (!marker) return undefined

  return {
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
  }
}

function registerHoverProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: async (model, position, token) => {
        const markerContents = getMarkerHoverContents(model, position)

        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/hover',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          },
          'hoverProvider'
        )

        if (token.isCancellationRequested) return null

        const lspHover = result ? mapLspHoverToMonaco(result) : null
        const contents = [...markerContents, ...(lspHover?.contents || [])]
        if (contents.length === 0) return null

        return {
          contents,
          range: lspHover?.range || getMarkerHoverRange(model, position),
        }
      },
    })
  )
}

function registerDefinitionProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async (model, position, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/definition',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          },
          'definitionProvider'
        )

        if (token.isCancellationRequested || !result) return null
        return mapLspDefinitionToMonaco(result)
      },
    })
  )
}

function registerImplementationProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerImplementationProvider(languageId, {
      provideImplementation: async (model, position, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/implementation',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          },
          'implementationProvider'
        )

        if (token.isCancellationRequested || !result) return null
        return mapLspDefinitionToMonaco(result)
      },
    })
  )
}

function registerTypeDefinitionProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerTypeDefinitionProvider(languageId, {
      provideTypeDefinition: async (model, position, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/typeDefinition',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          },
          'typeDefinitionProvider'
        )

        if (token.isCancellationRequested || !result) return null
        return mapLspDefinitionToMonaco(result)
      },
    })
  )
}

function registerReferenceProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerReferenceProvider(languageId, {
      provideReferences: async (model, position, context, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/references',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
            context: {
              includeDeclaration: Boolean(context.includeDeclaration),
            },
          },
          'referencesProvider'
        )

        if (token.isCancellationRequested || !result) return []
        return mapLspReferencesToMonaco(result)
      },
    })
  )
}

function registerDocumentHighlightProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerDocumentHighlightProvider(languageId, {
      provideDocumentHighlights: async (model, position, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/documentHighlight',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          },
          'documentHighlightProvider'
        )

        if (token.isCancellationRequested || !result) return []
        return mapLspDocumentHighlightsToMonaco(result)
      },
    })
  )
}

function registerDocumentSymbolProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerDocumentSymbolProvider(languageId, {
      displayName: 'LSP Symbols',
      provideDocumentSymbols: async (model, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/documentSymbol',
          {
            textDocument: { uri: model.uri.toString() },
          },
          'documentSymbolProvider'
        )

        if (token.isCancellationRequested || !result) return []
        return mapLspDocumentSymbolsToMonaco(result)
      },
    })
  )
}

function registerSignatureHelpProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerSignatureHelpProvider(languageId, {
      signatureHelpTriggerCharacters: signatureTriggerCharacters[languageId] || [],
      signatureHelpRetriggerCharacters: signatureRetriggerCharacters[languageId] || [],
      provideSignatureHelp: async (model, position, token, context) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/signatureHelp',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
            context: toLspSignatureHelpContext(context),
          },
          'signatureHelpProvider'
        )

        if (token.isCancellationRequested || !result) return null
        const signatureHelp = mapLspSignatureHelpToMonaco(result)
        return signatureHelp ? createSignatureHelpResult(signatureHelp) : null
      },
    })
  )
}

function registerRenameProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerRenameProvider(languageId, {
      provideRenameEdits: async (model, position, newName, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/rename',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
            newName,
          },
          'renameProvider'
        )

        if (token.isCancellationRequested || !result) {
          return createRejectedRenameEdits('Rename is not available for this symbol.')
        }

        const mappedEdit = mapLspWorkspaceEditToMonaco(result)
        if (!mappedEdit) {
          return createRejectedRenameEdits('Rename returned no editable workspace changes.')
        }

        return mappedEdit
      },
      resolveRenameLocation: async (model, position, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/prepareRename',
          {
            textDocument: { uri: model.uri.toString() },
            position: toLspPosition(position),
          },
          'renameProvider.prepareProvider'
        )

        if (token.isCancellationRequested) {
          return createRejectedRenameLocation('Rename was cancelled.')
        }

        if (!result) {
          return getFallbackRenameLocation(model, position) || createRejectedRenameLocation('Rename is not available here.')
        }

        if (result?.defaultBehavior === true) {
          return getFallbackRenameLocation(model, position) || createRejectedRenameLocation('Rename is not available here.')
        }

        if (result?.range) {
          return {
            range: fromLspRange(result.range),
            text: typeof result.placeholder === 'string' ? result.placeholder : model.getValueInRange(fromLspRange(result.range)),
          }
        }

        return {
          range: fromLspRange(result),
          text: model.getValueInRange(fromLspRange(result)),
        }
      },
    })
  )
}

function registerCodeActionProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerCodeActionProvider(
      languageId,
      {
        provideCodeActions: async (model, range, context, token) => {
          const result = await lspClientPool.requestForModel(
            model,
            'textDocument/codeAction',
            {
              textDocument: { uri: model.uri.toString() },
              range: toLspRange(range),
              context: toLspCodeActionContext(context),
            },
            'codeActionProvider'
          )

          if (token.isCancellationRequested || !result) {
            return createCodeActionList([])
          }

          const actions = (Array.isArray(result) ? result : [])
            .map((action: any) => mapLspCodeActionToMonaco(action, model.uri.toString()))
            .filter(Boolean)

          return createCodeActionList(actions)
        },
        resolveCodeAction: async (codeAction, token) => {
          const action = codeAction as MonacoCodeActionWithLsp
          if (token.isCancellationRequested || !action.__lspAction || !action.__lspUri) {
            return codeAction
          }

          const resolvedAction = await lspClientPool.resolveCodeAction(action.__lspUri, action.__lspAction)
          if (token.isCancellationRequested || !resolvedAction) {
            return codeAction
          }

          return {
            ...codeAction,
            ...mapLspCodeActionToMonaco(resolvedAction, action.__lspUri),
          }
        },
      },
      {
        providedCodeActionKinds: codeActionKinds,
      }
    )
  )
}

function registerFormattingProvider(languageId: string): void {
  registerDisposable(
    monaco.languages.registerDocumentFormattingEditProvider(languageId, {
      displayName: 'LSP Format Document',
      provideDocumentFormattingEdits: async (model, options, token) => {
        const result = await lspClientPool.requestForModel(
          model,
          'textDocument/formatting',
          {
            textDocument: { uri: model.uri.toString() },
            options,
          },
          'documentFormattingProvider'
        )

        if (token.isCancellationRequested || !result) return []
        return mapLspTextEditsToMonaco(result)
      },
    })
  )
}

export function registerMonacoLspProviders(): void {
  if (providersRegistered) return
  providersRegistered = true

  registerCommandBridge()

  const languageIds = ['typescript', 'javascript', 'json', 'yaml']
  languageIds.forEach(languageId => {
    registerCompletionProvider(languageId)
    registerHoverProvider(languageId)
    registerDefinitionProvider(languageId)
    registerImplementationProvider(languageId)
    registerTypeDefinitionProvider(languageId)
    registerReferenceProvider(languageId)
    registerDocumentHighlightProvider(languageId)
    registerDocumentSymbolProvider(languageId)
    registerSignatureHelpProvider(languageId)
    registerRenameProvider(languageId)
    registerCodeActionProvider(languageId)
    registerFormattingProvider(languageId)
  })
}

export function disposeMonacoLspProviders(): void {
  while (providerDisposables.length > 0) {
    providerDisposables.pop()?.dispose()
  }
  providersRegistered = false
}

export { applyLspWorkspaceEdit }
