/**
 * Graviton built-ins Claude chats can use, served as the in-process `graviton` MCP server
 * (`client/ygg-chat-r/server/headlessServer/services/claudeGravitonTools.ts`). Claude sees them as
 * `mcp__graviton__<tool>`; Graviton rows, cards, hooks and approvals use the plain name.
 *
 * Claude has its own file, shell, search, web-search, task and plan tools, so their Graviton twins
 * stay out: two tools for one job split the model's choice. Composite and run-scoped tools
 * (multi_call, repl, watcher, subagents, context_status, switch_mode, claude_bridge) need
 * Graviton's own loop.
 */
export const CLAUDE_GRAVITON_TOOL_NAMES: ReadonlySet<string> = new Set([
  'theme_manager',
  'fetch_chats',
  'html_renderer',
  'browse_web',
  'custom_tool_manager',
  'mcp_manager',
  'skill_manager',
])

export const GRAVITON_MCP_SERVER = 'graviton'
const PREFIX = `mcp__${GRAVITON_MCP_SERVER}__`

/** The Graviton tool behind a Claude tool name (`mcp__graviton__theme_manager` → `theme_manager`), else null. */
export function gravitonToolName(claudeName: string): string | null {
  return claudeName.startsWith(PREFIX) && claudeName.length > PREFIX.length ? claudeName.slice(PREFIX.length) : null
}

/** The name Claude uses for a Graviton tool. */
export function claudeGravitonToolName(name: string): string {
  return `${PREFIX}${name}`
}
