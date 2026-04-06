export type SupportedLspServerId = 'typescript' | 'json' | 'yaml'

export interface ResolvedLanguageInfo {
  extension: string | null
  monacoLanguageId: string
  lspLanguageId: string | null
  serverId: SupportedLspServerId | null
}

const extensionLanguageMap: Record<string, Omit<ResolvedLanguageInfo, 'extension'>> = {
  js: { monacoLanguageId: 'javascript', lspLanguageId: 'javascript', serverId: 'typescript' },
  mjs: { monacoLanguageId: 'javascript', lspLanguageId: 'javascript', serverId: 'typescript' },
  cjs: { monacoLanguageId: 'javascript', lspLanguageId: 'javascript', serverId: 'typescript' },
  jsx: { monacoLanguageId: 'javascript', lspLanguageId: 'javascriptreact', serverId: 'typescript' },
  ts: { monacoLanguageId: 'typescript', lspLanguageId: 'typescript', serverId: 'typescript' },
  tsx: { monacoLanguageId: 'typescript', lspLanguageId: 'typescriptreact', serverId: 'typescript' },
  css: { monacoLanguageId: 'css', lspLanguageId: null, serverId: null },
  scss: { monacoLanguageId: 'scss', lspLanguageId: null, serverId: null },
  less: { monacoLanguageId: 'less', lspLanguageId: null, serverId: null },
  html: { monacoLanguageId: 'html', lspLanguageId: null, serverId: null },
  htm: { monacoLanguageId: 'html', lspLanguageId: null, serverId: null },
  json: { monacoLanguageId: 'json', lspLanguageId: 'json', serverId: 'json' },
  md: { monacoLanguageId: 'markdown', lspLanguageId: null, serverId: null },
  py: { monacoLanguageId: 'python', lspLanguageId: null, serverId: null },
  sh: { monacoLanguageId: 'shell', lspLanguageId: null, serverId: null },
  bash: { monacoLanguageId: 'shell', lspLanguageId: null, serverId: null },
  yml: { monacoLanguageId: 'yaml', lspLanguageId: 'yaml', serverId: 'yaml' },
  yaml: { monacoLanguageId: 'yaml', lspLanguageId: 'yaml', serverId: 'yaml' },
  xml: { monacoLanguageId: 'xml', lspLanguageId: null, serverId: null },
  sql: { monacoLanguageId: 'sql', lspLanguageId: null, serverId: null },
  go: { monacoLanguageId: 'go', lspLanguageId: null, serverId: null },
  rs: { monacoLanguageId: 'rust', lspLanguageId: null, serverId: null },
  java: { monacoLanguageId: 'java', lspLanguageId: null, serverId: null },
  c: { monacoLanguageId: 'c', lspLanguageId: null, serverId: null },
  h: { monacoLanguageId: 'cpp', lspLanguageId: null, serverId: null },
  cpp: { monacoLanguageId: 'cpp', lspLanguageId: null, serverId: null },
  cc: { monacoLanguageId: 'cpp', lspLanguageId: null, serverId: null },
  hpp: { monacoLanguageId: 'cpp', lspLanguageId: null, serverId: null },
  txt: { monacoLanguageId: 'plaintext', lspLanguageId: null, serverId: null },
}

function getExtension(filePath: string | null | undefined): string | null {
  const normalized = String(filePath || '').trim()
  if (!normalized) return null
  const dotIndex = normalized.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === normalized.length - 1) return null
  return normalized.slice(dotIndex + 1).toLowerCase()
}

export function resolveLanguageInfo(filePath: string | null | undefined): ResolvedLanguageInfo {
  const extension = getExtension(filePath)
  const resolved = (extension && extensionLanguageMap[extension]) || null
  return {
    extension,
    monacoLanguageId: resolved?.monacoLanguageId || 'plaintext',
    lspLanguageId: resolved?.lspLanguageId || null,
    serverId: resolved?.serverId || null,
  }
}

export function detectMonacoLanguageId(filePath: string | null | undefined): string {
  return resolveLanguageInfo(filePath).monacoLanguageId
}
