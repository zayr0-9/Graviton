import * as monaco from 'monaco-editor'
import { localApi } from '../../utils/api'
import { fromFileUri } from './uri'

export const EXECUTE_LSP_COMMAND_ID = 'ygg.lsp.executeServerCommand'

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function coerceArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

function normalizeMarkdownValue(value: string): monaco.IMarkdownString {
  return {
    value,
    supportHtml: false,
    isTrusted: false,
  }
}

function markedStringToMarkdown(value: any): monaco.IMarkdownString {
  if (typeof value === 'string') {
    return normalizeMarkdownValue(value)
  }

  if (isObject(value) && typeof value.language === 'string' && typeof value.value === 'string') {
    return normalizeMarkdownValue(['```' + value.language, value.value, '```'].join('\n'))
  }

  return normalizeMarkdownValue(String(value ?? ''))
}

function markupContentToMarkdown(value: any): monaco.IMarkdownString {
  if (typeof value === 'string') {
    return normalizeMarkdownValue(value)
  }

  if (isObject(value) && typeof value.kind === 'string' && typeof value.value === 'string') {
    if (value.kind === 'markdown') {
      return normalizeMarkdownValue(value.value)
    }
    return normalizeMarkdownValue(value.value)
  }

  return markedStringToMarkdown(value)
}

function completionKindMap(kind?: number): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 2:
      return monaco.languages.CompletionItemKind.Method
    case 3:
      return monaco.languages.CompletionItemKind.Function
    case 4:
      return monaco.languages.CompletionItemKind.Constructor
    case 5:
      return monaco.languages.CompletionItemKind.Field
    case 6:
      return monaco.languages.CompletionItemKind.Variable
    case 7:
      return monaco.languages.CompletionItemKind.Class
    case 8:
      return monaco.languages.CompletionItemKind.Interface
    case 9:
      return monaco.languages.CompletionItemKind.Module
    case 10:
      return monaco.languages.CompletionItemKind.Property
    case 11:
      return monaco.languages.CompletionItemKind.Unit
    case 12:
      return monaco.languages.CompletionItemKind.Value
    case 13:
      return monaco.languages.CompletionItemKind.Enum
    case 14:
      return monaco.languages.CompletionItemKind.Keyword
    case 15:
      return monaco.languages.CompletionItemKind.Snippet
    case 16:
      return monaco.languages.CompletionItemKind.Color
    case 17:
      return monaco.languages.CompletionItemKind.File
    case 18:
      return monaco.languages.CompletionItemKind.Reference
    case 19:
      return monaco.languages.CompletionItemKind.Folder
    case 20:
      return monaco.languages.CompletionItemKind.EnumMember
    case 21:
      return monaco.languages.CompletionItemKind.Constant
    case 22:
      return monaco.languages.CompletionItemKind.Struct
    case 23:
      return monaco.languages.CompletionItemKind.Event
    case 24:
      return monaco.languages.CompletionItemKind.Operator
    case 25:
      return monaco.languages.CompletionItemKind.TypeParameter
    case 1:
    default:
      return monaco.languages.CompletionItemKind.Text
  }
}

function documentHighlightKindMap(kind?: number): monaco.languages.DocumentHighlightKind {
  switch (kind) {
    case 2:
      return monaco.languages.DocumentHighlightKind.Read
    case 3:
      return monaco.languages.DocumentHighlightKind.Write
    case 1:
    default:
      return monaco.languages.DocumentHighlightKind.Text
  }
}

function symbolKindMap(kind?: number): monaco.languages.SymbolKind {
  switch (kind) {
    case 1:
      return monaco.languages.SymbolKind.File
    case 2:
      return monaco.languages.SymbolKind.Module
    case 3:
      return monaco.languages.SymbolKind.Namespace
    case 4:
      return monaco.languages.SymbolKind.Package
    case 5:
      return monaco.languages.SymbolKind.Class
    case 6:
      return monaco.languages.SymbolKind.Method
    case 7:
      return monaco.languages.SymbolKind.Property
    case 8:
      return monaco.languages.SymbolKind.Field
    case 9:
      return monaco.languages.SymbolKind.Constructor
    case 10:
      return monaco.languages.SymbolKind.Enum
    case 11:
      return monaco.languages.SymbolKind.Interface
    case 12:
      return monaco.languages.SymbolKind.Function
    case 13:
      return monaco.languages.SymbolKind.Variable
    case 14:
      return monaco.languages.SymbolKind.Constant
    case 15:
      return monaco.languages.SymbolKind.String
    case 16:
      return monaco.languages.SymbolKind.Number
    case 17:
      return monaco.languages.SymbolKind.Boolean
    case 18:
      return monaco.languages.SymbolKind.Array
    case 19:
      return monaco.languages.SymbolKind.Object
    case 20:
      return monaco.languages.SymbolKind.Key
    case 21:
      return monaco.languages.SymbolKind.Null
    case 22:
      return monaco.languages.SymbolKind.EnumMember
    case 23:
      return monaco.languages.SymbolKind.Struct
    case 24:
      return monaco.languages.SymbolKind.Event
    case 25:
      return monaco.languages.SymbolKind.Operator
    case 26:
      return monaco.languages.SymbolKind.TypeParameter
    default:
      return monaco.languages.SymbolKind.Variable
  }
}

function mapMonacoMarkerSeverityToLsp(severity?: number): number | undefined {
  switch (severity) {
    case monaco.MarkerSeverity.Error:
      return 1
    case monaco.MarkerSeverity.Warning:
      return 2
    case monaco.MarkerSeverity.Info:
      return 3
    case monaco.MarkerSeverity.Hint:
      return 4
    default:
      return undefined
  }
}

export function toLspPosition(position: monaco.Position): { line: number; character: number } {
  return {
    line: Math.max(0, position.lineNumber - 1),
    character: Math.max(0, position.column - 1),
  }
}

export function toLspRange(range: monaco.IRange): {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  return {
    start: {
      line: Math.max(0, range.startLineNumber - 1),
      character: Math.max(0, range.startColumn - 1),
    },
    end: {
      line: Math.max(0, range.endLineNumber - 1),
      character: Math.max(0, range.endColumn - 1),
    },
  }
}

export function fromLspRange(range: any): monaco.IRange {
  return {
    startLineNumber: Number(range?.start?.line ?? 0) + 1,
    startColumn: Number(range?.start?.character ?? 0) + 1,
    endLineNumber: Number(range?.end?.line ?? 0) + 1,
    endColumn: Number(range?.end?.character ?? 0) + 1,
  }
}

export function toLspCompletionContext(context: monaco.languages.CompletionContext): {
  triggerKind: number
  triggerCharacter?: string
} {
  const triggerKind =
    context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter
      ? 2
      : context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions
        ? 3
        : 1

  return {
    triggerKind,
    triggerCharacter: context.triggerCharacter,
  }
}

export function toLspSignatureHelpContext(context: monaco.languages.SignatureHelpContext): {
  triggerKind: number
  triggerCharacter?: string
  isRetrigger: boolean
  activeSignatureHelp?: any
} {
  return {
    triggerKind: context.triggerKind,
    triggerCharacter: context.triggerCharacter,
    isRetrigger: Boolean(context.isRetrigger),
    activeSignatureHelp: context.activeSignatureHelp ? mapMonacoSignatureHelpToLsp(context.activeSignatureHelp) : undefined,
  }
}

function mapMonacoSignatureHelpToLsp(help: monaco.languages.SignatureHelp): any {
  return {
    signatures: help.signatures.map(signature => ({
      label: signature.label,
      documentation: signature.documentation,
      parameters: signature.parameters.map(parameter => ({
        label: parameter.label,
        documentation: parameter.documentation,
      })),
      activeParameter: signature.activeParameter,
    })),
    activeSignature: help.activeSignature,
    activeParameter: help.activeParameter,
  }
}

export function toLspCodeActionContext(context: monaco.languages.CodeActionContext): {
  diagnostics: any[]
  only?: string[]
  triggerKind: number
} {
  return {
    diagnostics: context.markers.map(marker => ({
      range: toLspRange(marker),
      severity: mapMonacoMarkerSeverityToLsp(marker.severity),
      code: marker.code,
      source: marker.source,
      message: marker.message,
    })),
    only: context.only ? [context.only] : undefined,
    triggerKind: context.trigger === monaco.languages.CodeActionTriggerType.Auto ? 2 : 1,
  }
}

export function toMarkdownStringArray(contents: any): monaco.IMarkdownString[] {
  return coerceArray(contents).map(value => markupContentToMarkdown(value))
}

export function mapLspHoverToMonaco(hover: any): monaco.languages.Hover | null {
  if (!hover?.contents) return null
  const contents = toMarkdownStringArray(hover.contents)
  if (contents.length === 0) return null
  return {
    contents,
    range: hover.range ? fromLspRange(hover.range) : undefined,
  }
}

function getDefaultCompletionRange(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): monaco.IRange {
  const word = model.getWordUntilPosition(position)
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  }
}

function mapLspTextEditToCompletionRange(textEdit: any): monaco.IRange | monaco.languages.CompletionItemRanges | null {
  if (!textEdit) return null
  if (textEdit.range) {
    return fromLspRange(textEdit.range)
  }
  if (textEdit.insert && textEdit.replace) {
    return {
      insert: fromLspRange(textEdit.insert),
      replace: fromLspRange(textEdit.replace),
    }
  }
  return null
}

function mapLspAdditionalTextEdits(edits: any[] | null | undefined): monaco.editor.ISingleEditOperation[] | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined
  return edits.map(edit => ({
    range: fromLspRange(edit.range),
    text: String(edit.newText ?? ''),
    forceMoveMarkers: true,
  }))
}

export function mapLspCommandToMonaco(
  rawCommand: any,
  modelUri: string
): { id: string; title: string; arguments?: unknown[] } | undefined {
  if (!isObject(rawCommand) || typeof rawCommand.command !== 'string' || !rawCommand.command.trim()) {
    return undefined
  }

  return {
    id: EXECUTE_LSP_COMMAND_ID,
    title: String(rawCommand.title || rawCommand.command),
    arguments: [
      {
        uri: modelUri,
        command: rawCommand.command,
        arguments: Array.isArray(rawCommand.arguments) ? rawCommand.arguments : [],
      },
    ],
  }
}

export type MonacoCompletionItemWithLsp = monaco.languages.CompletionItem & {
  __lspItem?: any
  __lspUri?: string
}

export function mapLspCompletionItemToMonaco(params: {
  item: any
  model: monaco.editor.ITextModel
  position: monaco.Position
}): MonacoCompletionItemWithLsp {
  const { item, model, position } = params
  const modelUri = model.uri.toString()
  const label =
    isObject(item?.labelDetails) || typeof item?.label === 'string'
      ? {
          label: String(item?.label ?? ''),
          detail: typeof item?.labelDetails?.detail === 'string' ? item.labelDetails.detail : undefined,
          description: typeof item?.labelDetails?.description === 'string' ? item.labelDetails.description : undefined,
        }
      : String(item?.label ?? '')

  const range = mapLspTextEditToCompletionRange(item?.textEdit) || getDefaultCompletionRange(model, position)
  const insertText = String(item?.textEdit?.newText ?? item?.insertText ?? item?.label ?? '')

  let insertTextRules = monaco.languages.CompletionItemInsertTextRule.None
  if (item?.insertTextFormat === 2) {
    insertTextRules |= monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
  }

  const completionItem: MonacoCompletionItemWithLsp = {
    label,
    kind: completionKindMap(item?.kind),
    tags: Array.isArray(item?.tags) && item.tags.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    detail: typeof item?.detail === 'string' ? item.detail : undefined,
    documentation: item?.documentation ? markupContentToMarkdown(item.documentation) : undefined,
    sortText: typeof item?.sortText === 'string' ? item.sortText : undefined,
    filterText: typeof item?.filterText === 'string' ? item.filterText : undefined,
    preselect: Boolean(item?.preselect),
    insertText,
    insertTextRules,
    range,
    commitCharacters: Array.isArray(item?.commitCharacters)
      ? item.commitCharacters.map((character: unknown) => String(character)).filter(Boolean)
      : undefined,
    additionalTextEdits: mapLspAdditionalTextEdits(item?.additionalTextEdits),
    command: mapLspCommandToMonaco(item?.command, modelUri),
    __lspItem: item,
    __lspUri: modelUri,
  }

  return completionItem
}

export function mergeResolvedCompletionItem(
  item: MonacoCompletionItemWithLsp,
  resolvedItem: any
): MonacoCompletionItemWithLsp {
  const nextItem: MonacoCompletionItemWithLsp = {
    ...item,
    detail: typeof resolvedItem?.detail === 'string' ? resolvedItem.detail : item.detail,
    documentation: resolvedItem?.documentation ? markupContentToMarkdown(resolvedItem.documentation) : item.documentation,
    additionalTextEdits: mapLspAdditionalTextEdits(resolvedItem?.additionalTextEdits) || item.additionalTextEdits,
    command: mapLspCommandToMonaco(resolvedItem?.command, item.__lspUri || '') || item.command,
    __lspItem: resolvedItem,
    __lspUri: item.__lspUri,
  }

  return nextItem
}

function mapLocation(value: any): monaco.languages.Location | monaco.languages.LocationLink | null {
  if (!isObject(value) || typeof value.uri !== 'string') return null

  if (value.targetUri || value.targetSelectionRange || value.targetRange) {
    return {
      uri: monaco.Uri.parse(String(value.targetUri || value.uri)),
      range: fromLspRange(value.targetRange || value.range),
      originSelectionRange: value.originSelectionRange ? fromLspRange(value.originSelectionRange) : undefined,
      targetSelectionRange: value.targetSelectionRange ? fromLspRange(value.targetSelectionRange) : undefined,
    }
  }

  return {
    uri: monaco.Uri.parse(value.uri),
    range: fromLspRange(value.range),
  }
}

export function mapLspDefinitionToMonaco(definition: any): monaco.languages.Definition | null {
  if (!definition) return null
  const mapped = coerceArray(definition).map(mapLocation).filter(Boolean) as Array<
    monaco.languages.Location | monaco.languages.LocationLink
  >

  if (mapped.length === 0) return null
  return mapped
}

export function mapLspReferencesToMonaco(references: any): monaco.languages.Location[] {
  return coerceArray(references)
    .map(mapLocation)
    .filter((value): value is monaco.languages.Location => Boolean(value) && !('targetSelectionRange' in value))
}

export function mapLspDocumentHighlightsToMonaco(highlights: any): monaco.languages.DocumentHighlight[] {
  return coerceArray(highlights)
    .filter(isObject)
    .map(highlight => ({
      range: fromLspRange(highlight.range),
      kind: documentHighlightKindMap(highlight.kind),
    }))
}

function mapDocumentSymbol(item: any): monaco.languages.DocumentSymbol {
  return {
    name: String(item?.name ?? ''),
    detail: typeof item?.detail === 'string' ? item.detail : '',
    kind: symbolKindMap(item?.kind),
    tags: Array.isArray(item?.tags) && item.tags.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
    containerName: typeof item?.containerName === 'string' ? item.containerName : undefined,
    range: fromLspRange(item?.range),
    selectionRange: fromLspRange(item?.selectionRange || item?.range),
    children: Array.isArray(item?.children) ? item.children.map(mapDocumentSymbol) : undefined,
  }
}

export function mapLspDocumentSymbolsToMonaco(symbols: any): monaco.languages.DocumentSymbol[] {
  const list = coerceArray(symbols).filter(isObject)
  if (list.length === 0) return []

  const first = list[0]
  if (first.location) {
    return list.map(symbol => ({
      name: String(symbol?.name ?? ''),
      detail: '',
      kind: symbolKindMap(symbol?.kind),
      tags: Array.isArray(symbol?.tags) && symbol.tags.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
      containerName: typeof symbol?.containerName === 'string' ? symbol.containerName : undefined,
      range: fromLspRange(symbol?.location?.range),
      selectionRange: fromLspRange(symbol?.location?.range),
      children: undefined,
    }))
  }

  return list.map(mapDocumentSymbol)
}

export function mapLspSignatureHelpToMonaco(value: any): monaco.languages.SignatureHelp | null {
  if (!value || !Array.isArray(value.signatures)) return null

  return {
    signatures: value.signatures.map((signature: any) => ({
      label: String(signature?.label ?? ''),
      documentation: signature?.documentation ? markupContentToMarkdown(signature.documentation) : undefined,
      parameters: Array.isArray(signature?.parameters)
        ? signature.parameters.map((parameter: any) => ({
            label: Array.isArray(parameter?.label)
              ? [Number(parameter.label[0] ?? 0), Number(parameter.label[1] ?? 0)]
              : String(parameter?.label ?? ''),
            documentation: parameter?.documentation ? markupContentToMarkdown(parameter.documentation) : undefined,
          }))
        : [],
      activeParameter:
        typeof signature?.activeParameter === 'number' ? Number(signature.activeParameter) : undefined,
    })),
    activeSignature: typeof value?.activeSignature === 'number' ? Number(value.activeSignature) : 0,
    activeParameter: typeof value?.activeParameter === 'number' ? Number(value.activeParameter) : 0,
  }
}

function collectWorkspaceTextEdits(workspaceEdit: any): Array<{ uri: string; edit: any }> {
  const collected: Array<{ uri: string; edit: any }> = []

  if (isObject(workspaceEdit?.changes)) {
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      if (!Array.isArray(edits)) continue
      edits.forEach(edit => {
        collected.push({ uri, edit })
      })
    }
  }

  if (Array.isArray(workspaceEdit?.documentChanges)) {
    workspaceEdit.documentChanges.forEach((change: any) => {
      if (!change || !Array.isArray(change.edits) || typeof change?.textDocument?.uri !== 'string') return
      change.edits.forEach((edit: any) => {
        collected.push({ uri: change.textDocument.uri, edit })
      })
    })
  }

  return collected
}

export function mapLspWorkspaceEditToMonaco(workspaceEdit: any): monaco.languages.WorkspaceEdit | null {
  const edits = collectWorkspaceTextEdits(workspaceEdit).map(({ uri, edit }) => ({
    resource: monaco.Uri.parse(uri),
    versionId: undefined,
    textEdit: {
      range: fromLspRange(edit?.range),
      text: String(edit?.newText ?? ''),
      insertAsSnippet: edit?.insertTextFormat === 2,
      keepWhitespace: false,
    },
  }))

  if (edits.length === 0) return null
  return { edits }
}

function sortSingleEditOperations(
  model: monaco.editor.ITextModel,
  edits: monaco.editor.ISingleEditOperation[]
): monaco.editor.ISingleEditOperation[] {
  return [...edits].sort((left, right) => {
    const leftOffset = model.getOffsetAt({
      lineNumber: left.range.startLineNumber,
      column: left.range.startColumn,
    })
    const rightOffset = model.getOffsetAt({
      lineNumber: right.range.startLineNumber,
      column: right.range.startColumn,
    })
    return rightOffset - leftOffset
  })
}

function toSingleEditOperations(edits: any[]): monaco.editor.ISingleEditOperation[] {
  return edits.map(edit => ({
    range: fromLspRange(edit?.range),
    text: String(edit?.newText ?? ''),
    forceMoveMarkers: true,
  }))
}

function applySingleEditOperations(
  model: monaco.editor.ITextModel,
  edits: monaco.editor.ISingleEditOperation[]
): void {
  const sortedEdits = sortSingleEditOperations(model, edits)
  model.pushStackElement()
  model.pushEditOperations([], sortedEdits, () => null)
  model.pushStackElement()
}

async function applyWorkspaceEditsToFileOnDisk(uri: string, edits: any[]): Promise<{ applied: boolean; failureReason?: string }> {
  const filePath = fromFileUri(uri)
  if (!filePath) {
    return {
      applied: false,
      failureReason: `Workspace edit targeted a non-file resource (${uri}).`,
    }
  }

  try {
    const response = await localApi.get<{ content?: string }>(`/local/file-content?path=${encodeURIComponent(filePath)}`, {
      cache: 'no-store',
    })
    const originalContent = typeof response?.content === 'string' ? response.content : ''
    const tempModel = monaco.editor.createModel(originalContent, undefined, monaco.Uri.parse(uri))

    try {
      applySingleEditOperations(tempModel, toSingleEditOperations(edits))
      await localApi.post('/local/file-content', {
        path: filePath,
        content: tempModel.getValue(),
      })
    } finally {
      tempModel.dispose()
    }

    return { applied: true }
  } catch (error) {
    return {
      applied: false,
      failureReason: error instanceof Error ? error.message : `Failed to apply workspace edit to ${filePath}.`,
    }
  }
}

export async function applyLspWorkspaceEdit(workspaceEdit: any): Promise<{ applied: boolean; failureReason?: string }> {
  const groupedEdits = new Map<string, any[]>()

  collectWorkspaceTextEdits(workspaceEdit).forEach(({ uri, edit }) => {
    const existingEdits = groupedEdits.get(uri)
    if (existingEdits) {
      existingEdits.push(edit)
      return
    }

    groupedEdits.set(uri, [edit])
  })

  if (groupedEdits.size === 0) {
    return {
      applied: false,
      failureReason: 'Workspace edit had no supported text edits.',
    }
  }

  const failures: string[] = []

  for (const [uri, edits] of groupedEdits.entries()) {
    const parsedUri = monaco.Uri.parse(uri)
    const model = monaco.editor.getModel(parsedUri)

    if (model) {
      applySingleEditOperations(model, toSingleEditOperations(edits))
      continue
    }

    const diskResult = await applyWorkspaceEditsToFileOnDisk(uri, edits)
    if (!diskResult.applied) {
      failures.push(diskResult.failureReason || `Failed to apply workspace edit to ${uri}.`)
    }
  }

  if (failures.length > 0) {
    return {
      applied: false,
      failureReason: failures.join(' | '),
    }
  }

  return { applied: true }
}

export type MonacoCodeActionWithLsp = monaco.languages.CodeAction & {
  __lspAction?: any
  __lspUri?: string
}

export function mapLspCodeActionToMonaco(action: any, modelUri: string): MonacoCodeActionWithLsp {
  return {
    title: String(action?.title ?? 'LSP Action'),
    kind: typeof action?.kind === 'string' ? action.kind : undefined,
    isPreferred: Boolean(action?.isPreferred),
    disabled: typeof action?.disabled?.reason === 'string' ? action.disabled.reason : undefined,
    diagnostics: Array.isArray(action?.diagnostics)
      ? action.diagnostics.map((diagnostic: any) => ({
          message: String(diagnostic?.message ?? ''),
          severity:
            diagnostic?.severity === 1
              ? monaco.MarkerSeverity.Error
              : diagnostic?.severity === 2
                ? monaco.MarkerSeverity.Warning
                : diagnostic?.severity === 4
                  ? monaco.MarkerSeverity.Hint
                  : monaco.MarkerSeverity.Info,
          startLineNumber: Number(diagnostic?.range?.start?.line ?? 0) + 1,
          startColumn: Number(diagnostic?.range?.start?.character ?? 0) + 1,
          endLineNumber: Number(diagnostic?.range?.end?.line ?? 0) + 1,
          endColumn: Number(diagnostic?.range?.end?.character ?? 0) + 1,
          source: diagnostic?.source,
          code: diagnostic?.code,
        }))
      : undefined,
    edit: mapLspWorkspaceEditToMonaco(action?.edit) || undefined,
    command: mapLspCommandToMonaco(action?.command, modelUri),
    __lspAction: action,
    __lspUri: modelUri,
  }
}

export function mapLspTextEditsToMonaco(edits: any): monaco.languages.TextEdit[] {
  return coerceArray(edits)
    .filter(isObject)
    .map(edit => ({
      range: fromLspRange(edit.range),
      text: String(edit.newText ?? ''),
    }))
}
