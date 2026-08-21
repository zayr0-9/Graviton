// electron/server/toolSandboxPolicy.ts
// Which tools must run in the out-of-process sandbox. This is a security
// policy, not a wiring detail: it keeps bash, powershell, and the
// file-mutating tools out of the server process on both hosts.

/**
 * Built-in tools routed to the sandbox when the tool runtime mode is
 * 'utility'. Keep in sync with the handlers registered inside
 * toolRuntimeUtility.ts.
 */
export const UTILITY_RUNTIME_TOOL_WHITELIST: ReadonlySet<string> = new Set<string>([
  'read_file',
  'read_file_continuation',
  'read_files',
  'create_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'directory',
  'view_image',
  'glob',
  'ripgrep',
  'bash',
  'powershell',
  'html_renderer',
])

export function shouldUseUtilityRuntimeForTool(toolName: string): boolean {
  return UTILITY_RUNTIME_TOOL_WHITELIST.has(toolName)
}
