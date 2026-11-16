import type { ChatNode, Message } from '../../features/chats/chatTypes'
import { expandHeimdallSelectionToBranchMessages } from './heimdallSelection'

/**
 * Heimdall collapse groups are a visual-only tree-management aid. A group stores the
 * message ids it hides (including filtered connector rows), never changing canonical
 * messages, branch paths or transfer/delete inputs. Groups persist per conversation
 * in SQLite (`heimdall_collapse_groups`, see useHeimdallCollapseGroups.ts).
 */
export interface HeimdallCollapseGroup {
  id: string
  memberIds: string[]
}

/** A rendered collapse node. It reuses the head message id so clicks, keyboard
 * activation and branch-path building keep working with real message ids. */
export interface HeimdallCollapsedNode {
  groupId: string
  /** Visible member ids of this segment in preorder, head first. */
  visibleMemberIds: string[]
}

export interface HeimdallCollapsedTree {
  root: ChatNode | null
  collapsedById: Map<string, HeimdallCollapsedNode>
  /** Every visible member (including the head) -> the collapse node that replaces it. */
  headByMemberId: Map<string, string>
}

const SYNTHETIC_ROOT_ID = 'root'

/**
 * Replace each connected run of group members with one node. Children of members
 * that are not in the group become the collapse node's children in preorder, so
 * branches leaving the collapsed region stay attached and visible. A segment that
 * has fewer than two visible members (e.g. after deletes or filter changes) is left
 * uncollapsed. Iterative: no recursion proportional to conversation depth.
 */
export function applyHeimdallCollapse(root: ChatNode | null, groups: readonly HeimdallCollapseGroup[]): HeimdallCollapsedTree {
  const collapsedById = new Map<string, HeimdallCollapsedNode>()
  const headByMemberId = new Map<string, string>()
  if (!root || groups.length === 0) return { root, collapsedById, headByMemberId }

  const groupByMember = new Map<string, HeimdallCollapseGroup>()
  for (const group of groups) {
    for (const id of group.memberIds) groupByMember.set(String(id), group)
  }

  const output: ChatNode[] = []
  const pending: Array<{ node: ChatNode; output: ChatNode[] }> = [{ node: root, output }]
  while (pending.length) {
    const { node, output: siblings } = pending.pop()!
    const group = node.id === SYNTHETIC_ROOT_ID ? undefined : groupByMember.get(String(node.id))

    if (group) {
      // Preorder over the segment: members expand, non-members are exits.
      const members: string[] = []
      const exits: ChatNode[] = []
      const segment: ChatNode[] = [node]
      while (segment.length) {
        const current = segment.pop()!
        if (current !== node && groupByMember.get(String(current.id)) !== group) {
          exits.push(current)
          continue
        }
        members.push(String(current.id))
        for (let i = current.children.length - 1; i >= 0; i--) segment.push(current.children[i])
      }

      if (members.length >= 2) {
        const copy: ChatNode = { ...node, children: [] }
        siblings.push(copy)
        collapsedById.set(String(node.id), { groupId: group.id, visibleMemberIds: members })
        for (const memberId of members) headByMemberId.set(memberId, String(node.id))
        for (let i = exits.length - 1; i >= 0; i--) pending.push({ node: exits[i], output: copy.children })
        continue
      }
    }

    const copy: ChatNode = { ...node, children: [] }
    siblings.push(copy)
    for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], output: copy.children })
  }

  return { root: output[0] ?? null, collapsedById, headByMemberId }
}

export type HeimdallCollapsePlan =
  | { kind: 'collapse'; group: HeimdallCollapseGroup; replacedGroupIds: string[]; visibleCount: number }
  | { kind: 'unavailable'; reason: string }
  /** The selection is exactly an existing group: offer Expand only. */
  | { kind: 'noop' }

/**
 * Plan collapsing the current selection. The selection must form one connected
 * region of the visible (filtered, uncollapsed) tree with at least two nodes.
 * Existing groups touched by the selection merge into the new group.
 */
export function planHeimdallCollapse({
  visibleRoot,
  messages,
  selectedIds,
  groups,
}: {
  visibleRoot: ChatNode | null
  messages: Message[]
  selectedIds: readonly Message['id'][]
  groups: readonly HeimdallCollapseGroup[]
}): HeimdallCollapsePlan {
  if (!visibleRoot || selectedIds.length === 0) return { kind: 'unavailable', reason: 'Select at least two messages to collapse' }

  const selected = new Set(selectedIds.map(String))
  const touched = groups.filter(group => group.memberIds.some(id => selected.has(String(id))))
  const wanted = new Set(selected)
  for (const group of touched) for (const id of group.memberIds) wanted.add(String(id))

  const parentById = new Map<string, string | null>()
  const visibleIds = new Set<string>()
  const pending: Array<{ node: ChatNode; parentId: string | null }> = [{ node: visibleRoot, parentId: null }]
  while (pending.length) {
    const { node, parentId } = pending.pop()!
    const isSynthetic = node.id === SYNTHETIC_ROOT_ID
    if (!isSynthetic) {
      visibleIds.add(String(node.id))
      parentById.set(String(node.id), parentId)
    }
    for (const child of node.children) pending.push({ node: child, parentId: isSynthetic ? null : String(node.id) })
  }

  const visibleWanted = [...wanted].filter(id => visibleIds.has(id))
  if (visibleWanted.length < 2) return { kind: 'unavailable', reason: 'Select at least two messages to collapse' }

  const visibleWantedSet = new Set(visibleWanted)
  const heads = visibleWanted.filter(id => {
    const parentId = parentById.get(id)
    return parentId == null || !visibleWantedSet.has(parentId)
  })
  if (heads.length !== 1) return { kind: 'unavailable', reason: 'Select one connected run of messages to collapse' }

  if (touched.length === 1) {
    const existing = new Set(touched[0].memberIds.map(String))
    if (visibleWanted.every(id => existing.has(id))) return { kind: 'noop' }
  }

  const messageById = new Map(messages.map(message => [String(message.id), message]))
  const visibleMessageIds = visibleWanted.flatMap(id => {
    const message = messageById.get(id)
    return message ? [message.id] : []
  })
  // Include filtered connector rows and hidden-only tails so toggling the filter
  // off later still shows one connected collapse instead of fragments.
  const expanded = expandHeimdallSelectionToBranchMessages(messages, visibleMessageIds, visibleIds).map(String)
  const memberIds = [...new Set([
    ...expanded,
    ...touched.flatMap(group => group.memberIds.map(String)).filter(id => messageById.has(id)),
  ])]

  return {
    kind: 'collapse',
    group: { id: `${heads[0]}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, memberIds },
    replacedGroupIds: touched.map(group => group.id),
    visibleCount: visibleWanted.length,
  }
}

/** Groups that own any selected message; Expand removes all of them. */
export function getHeimdallCollapseGroupsInSelection(
  groups: readonly HeimdallCollapseGroup[],
  selectedIds: readonly Message['id'][]
): HeimdallCollapseGroup[] {
  if (groups.length === 0 || selectedIds.length === 0) return []
  const selected = new Set(selectedIds.map(String))
  return groups.filter(group => group.memberIds.some(id => selected.has(String(id))))
}
