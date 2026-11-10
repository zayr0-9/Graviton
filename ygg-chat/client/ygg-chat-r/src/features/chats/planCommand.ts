/**
 * The composer's `/plan` command for Claude Code chats: `/plan` alone toggles native plan mode,
 * `/plan <task>` turns it on and sends the task. Returns null for anything else, including a
 * path such as `/plan.md`, which Claude reads as an ordinary prompt.
 */
export function parsePlanCommand(input: string): { task: string } | null {
  const match = /^\/plan(?:\s+([\s\S]*))?$/i.exec(input.trim())
  return match ? { task: (match[1] ?? '').trim() } : null
}
