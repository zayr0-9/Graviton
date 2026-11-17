/**
 * How grid cards may move when fork order changes.
 * - `rows`: cards re-sort by activity, but a card that stays in its row keeps its column.
 * - `locked`: cards never move; departed cards leave their row and new forks are appended.
 */
export type AgentGridOrderMode = 'rows' | 'locked'

export const AGENT_GRID_ORDER_MODES: readonly AgentGridOrderMode[] = ['rows', 'locked']

/** The rows last rendered, and the column capacity they were laid out for. */
export interface AgentGridLayout { columns: number; rows: readonly (readonly string[])[] }

const chunk = (keys: readonly string[], columns: number): string[][] =>
  Array.from({ length: Math.ceil(keys.length / columns) }, (_, index) => keys.slice(index * columns, (index + 1) * columns))

/**
 * Lay out fork keys (in sort order) into rows of at most `columns`, starting from the previous layout.
 * A column-count change reflows from scratch: the previous columns no longer exist.
 */
export function arrangeAgentGridRows(previous: AgentGridLayout | null, keys: readonly string[], columns: number,
  mode: AgentGridOrderMode): string[][] {
  const present = new Set(keys)
  const previousOrder = previous ? previous.rows.flat().filter(key => present.has(key)) : []
  const seen = new Set(previousOrder)
  const incoming = keys.filter(key => !seen.has(key))

  if (!previous || previous.columns !== columns) {
    return chunk(mode === 'locked' ? [...previousOrder, ...incoming] : keys, columns)
  }

  if (mode === 'locked') {
    const rows = previous.rows.map(row => row.filter(key => present.has(key))).filter(row => row.length > 0)
    for (const key of incoming) {
      const last = rows[rows.length - 1]
      if (last && last.length < columns) last.push(key)
      else rows.push([key])
    }
    return rows
  }

  // Row membership follows sort order. Within a row, cards that were already there keep their
  // slots; cards arriving from other rows take the slots of the cards that left.
  return chunk(keys, columns).map((members, index) => {
    const before = previous.rows[index]
    if (!before) return members
    const memberSet = new Set(members)
    const slots = before.map(key => memberSet.has(key) ? key : null)
    const kept = new Set(slots)
    const arriving = members.filter(key => !kept.has(key))
    const result = slots.map(slot => slot ?? arriving.shift() ?? null)
    return [...result.filter((key): key is string => key !== null), ...arriving]
  })
}
