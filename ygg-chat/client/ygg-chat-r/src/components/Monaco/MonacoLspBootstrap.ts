import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { registerMonacoLspProviders } from '../../lib/lsp/monacoProviders'

let configured = false

function disableBuiltInTypeScriptDiagnostics(): void {
  const typescriptApi = (monaco.languages as any)?.typescript

  typescriptApi?.typescriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  })

  typescriptApi?.javascriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  })
}

export function ensureMonacoLspBootstrap(): typeof monaco {
  if (!configured) {
    loader.config({ monaco })
    disableBuiltInTypeScriptDiagnostics()
    registerMonacoLspProviders()
    configured = true
  }
  return monaco
}

export { monaco }
