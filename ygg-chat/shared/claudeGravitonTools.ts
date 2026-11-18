/**
 * Graviton's built-in tools in Claude chats, served as the in-process `graviton` MCP server
 * (`client/ygg-chat-r/server/headlessServer/services/claudeGravitonTools.ts`). Every built-in this
 * host runs is offered; Settings → Tools decides which. Claude sees `mcp__graviton__<tool>`;
 * Graviton rows, cards, hooks and approvals use the plain name.
 */
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
