export type TodoListSummary = {
  name: string
  action: 'create' | 'read' | 'edit'
  items: Array<{ text: string; done: boolean }>
  messageId: string | number
}

type MessageWithContentBlocks = {
  id: string | number
  role: string
  content_blocks?: unknown
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: unknown
  name?: unknown
  input?: Record<string, unknown>
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

const TODO_ITEM_REGEX = /^\s*[-*]\s*\[(x|X| )\]\s*(.*)$/
const TODO_ACTIONS = new Set(['create', 'read', 'edit'])

export function parseTodoItems(markdownContent: string): Array<{ text: string; done: boolean }> {
  const items: Array<{ text: string; done: boolean }> = []
  for (const line of markdownContent.split('\n')) {
    const match = TODO_ITEM_REGEX.exec(line)
    if (!match) continue
    items.push({
      done: match[1].toLowerCase() === 'x',
      text: match[2].trim(),
    })
  }
  return items
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseBlocks(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseJsonString(value)
  if (Array.isArray(parsed)) return parsed.filter(block => block && typeof block === 'object')
  return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : []
}

function findResultBlock(
  blocks: Array<Record<string, unknown>>,
  toolUseId: unknown
): ToolResultBlock | undefined {
  return blocks.find(
    block => block.type === 'tool_result' && block.tool_use_id === toolUseId
  ) as ToolResultBlock | undefined
}

function summaryFromResult(
  actionValue: unknown,
  input: Record<string, unknown> | undefined,
  rawResult: unknown,
  messageId: string | number
): TodoListSummary | null {
  if (typeof actionValue !== 'string' || !TODO_ACTIONS.has(actionValue)) return null

  const resultData = parseJsonString(rawResult)
  let markdownContent = ''
  if (resultData && typeof resultData === 'object' && 'content' in resultData) {
    const content = (resultData as Record<string, unknown>).content
    markdownContent = typeof content === 'string' ? content : ''
  } else if (typeof resultData === 'string') {
    markdownContent = resultData
  }

  const items = parseTodoItems(markdownContent)
  if (items.length === 0) return null

  const resultRecord = resultData && typeof resultData === 'object'
    ? resultData as Record<string, unknown>
    : undefined
  const resultName = resultRecord?.name ?? resultRecord?.id ?? input?.name

  return {
    name: typeof resultName === 'string' && resultName ? resultName : 'Todo List',
    action: actionValue as TodoListSummary['action'],
    items,
    messageId,
  }
}

function summaryFromMultiCall(
  toolUse: ToolUseBlock,
  resultBlock: ToolResultBlock,
  messageId: string | number
): TodoListSummary | null {
  const calls = Array.isArray(toolUse.input?.calls) ? toolUse.input.calls : []
  const aggregate = parseJsonString(resultBlock.content)
  if (!aggregate || typeof aggregate !== 'object') return null
  const results = Array.isArray((aggregate as Record<string, unknown>).results)
    ? (aggregate as Record<string, unknown>).results as unknown[]
    : []

  for (let index = Math.min(calls.length, results.length) - 1; index >= 0; index -= 1) {
    const call = calls[index]
    const result = results[index]
    if (!call || typeof call !== 'object' || !result || typeof result !== 'object') continue

    const callRecord = call as Record<string, unknown>
    const nestedToolName = typeof callRecord.tool === 'string' ? callRecord.tool : callRecord.toolName
    const resultRecord = result as Record<string, unknown>
    if (nestedToolName !== 'todo_list' || resultRecord.tool !== 'todo_list' || resultRecord.ok !== true) continue

    const nestedInput = callRecord.args && typeof callRecord.args === 'object' && !Array.isArray(callRecord.args)
      ? callRecord.args as Record<string, unknown>
      : undefined
    const summary = summaryFromResult(nestedInput?.action, nestedInput, resultRecord.data, messageId)
    if (summary) return summary
  }

  return null
}

export function extractLatestTodoList(messages: MessageWithContentBlocks[]): TodoListSummary | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if ((message.role !== 'assistant' && message.role !== 'ex_agent') || !message.content_blocks) continue

    const blocks = parseBlocks(message.content_blocks)
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]
      if (block.type !== 'tool_use') continue

      const toolUse = block as unknown as ToolUseBlock
      const resultBlock = findResultBlock(blocks, toolUse.id)
      if (!resultBlock || resultBlock.is_error) continue

      if (toolUse.name === 'todo_list') {
        const summary = summaryFromResult(toolUse.input?.action, toolUse.input, resultBlock.content, message.id)
        if (summary) return summary
      } else if (toolUse.name === 'multi_call') {
        const summary = summaryFromMultiCall(toolUse, resultBlock, message.id)
        if (summary) return summary
      }
    }
  }

  return null
}
