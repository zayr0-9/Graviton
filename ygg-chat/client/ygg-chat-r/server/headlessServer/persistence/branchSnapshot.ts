import type Database from 'better-sqlite3'

export interface BranchSnapshotTarget { tip?: string; lineage?: string }

/** Read topology, not bodies. Shared ancestors can belong to other lineages; filtering
 * messages by lineage_id would silently truncate fork history. Match pathUtils' first-child order. */
export function selectSnapshotBranch(db: Database.Database, conversationId: string, target: BranchSnapshotTarget) {
  const nodes = db.prepare(`SELECT id, parent_id, revision, created_at FROM messages
    WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC`).all(conversationId) as Array<{
    id: string; parent_id: string | null; revision: number; created_at: string
  }>
  const byId = new Map(nodes.map(node => [node.id, node]))
  const firstChild = new Map<string, string>()
  for (const node of nodes) {
    if (!node.parent_id) continue
    const first = firstChild.get(node.parent_id)
    if (!first || node.id.localeCompare(first) < 0) firstChild.set(node.parent_id, node.id)
  }
  const lineage = target.lineage ? db.prepare(`SELECT head_message_id FROM lineages WHERE id = ? AND conversation_id = ?`)
    .get(target.lineage, conversationId) as { head_message_id: string | null } | undefined : undefined
  const hint = lineage?.head_message_id ?? target.tip
  // The renderer's newest-first sort is stable on equal timestamps.
  const anchor = hint && byId.has(hint) ? hint : nodes.find(node => node.created_at === nodes.at(-1)?.created_at)?.id
  const selected = new Set<string>()
  let id = anchor
  while (id && byId.has(id) && !selected.has(id)) {
    selected.add(id)
    id = byId.get(id)?.parent_id ?? undefined
  }
  id = lineage ? undefined : anchor && firstChild.get(anchor)
  while (id && !selected.has(id)) {
    selected.add(id)
    id = firstChild.get(id)
  }
  // Only id/revision pairs cross the wire for omitted bodies. This distinguishes a
  // real deletion from an unchanged sibling previously hydrated by this renderer.
  return { ids: [...selected], retained: nodes.filter(node => !selected.has(node.id)).map(node => [node.id, node.revision] as const) }
}
