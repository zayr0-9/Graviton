import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Native tools inherit this environment too. Do not give them Graviton's unrelated credentials. */
export function claudeProcessEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const allowed = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|TERM|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|PROGRAMFILES|PROGRAMFILES\(X86\)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/i
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.test(key)))
  env.PATH = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', source.PATH].filter(Boolean).join(path.delimiter)
  return env
}

export async function resolveClaudeExecutable(): Promise<string> {
  if (process.env.CLAUDE_BRIDGE_BINARY) { await access(process.env.CLAUDE_BRIDGE_BINARY); return process.env.CLAUDE_BRIDGE_BINARY }
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates = [path.join(os.homedir(), '.local/bin', name),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))]
  for (const candidate of candidates) {
    try { await access(candidate); return candidate } catch { /* Continue through known locations. */ }
  }
  throw new Error('Claude Code CLI is not installed on the host. Install it and sign in in a terminal, then retry.')
}
