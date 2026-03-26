import { v4 as uuidv4 } from 'uuid'

interface MessageRepoDeps {
  db: any
  statements: any
}

export interface CreateMessageInput {
  conversationId: string
  parentId: string | null
  role: 'user' | 'assistant' | 'tool' | 'system' | 'ex_agent'
  content: string
  modelName?: string | null
  toolCalls?: any[] | null
  toolCallId?: string | null
  contentBlocks?: any[] | null
  thinkingBlock?: string | null
  note?: string | null
  noteColor?: string | null
  exAgentSessionId?: string | null
  exAgentType?: string | null
}

export class MessageRepo {
  private readonly db: any
  private readonly statements: any

  constructor(deps: MessageRepoDeps) {
    this.db = deps.db
    this.statements = deps.statements
  }

  createMessage(input: CreateMessageInput): any {
    const now = new Date().toISOString()
    const messageId = uuidv4()

    this.statements.upsertMessage.run(
      messageId,
      input.conversationId,
      input.parentId ?? null,
      JSON.stringify([]),
      input.role,
      input.content ?? '',
      input.content ?? '',
      input.thinkingBlock ?? null,
      JSON.stringify(input.toolCalls ?? null),
      input.toolCallId ?? null,
      input.modelName ?? 'unknown',
      input.note ?? null,
      input.noteColor ?? null,
      input.exAgentSessionId ?? null,
      input.exAgentType ?? null,
      JSON.stringify(input.contentBlocks ?? null),
      now
    )

    if (input.parentId) {
      const parent = this.statements.getMessageById.get(input.parentId) as any
      if (parent) {
        const childrenIds = JSON.parse(parent.children_ids || '[]')
        if (!childrenIds.includes(messageId)) {
          childrenIds.push(messageId)
          this.db.prepare('UPDATE messages SET children_ids = ? WHERE id = ?').run(JSON.stringify(childrenIds), input.parentId)
        }
      }
    }

    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, input.conversationId)

    const conversation = this.statements.getConversationById.get(input.conversationId) as any
    if (conversation?.project_id) {
      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, conversation.project_id)
    }

    return this.statements.getMessageById.get(messageId)
  }

  updateAssistantToolState(
    messageId: string,
    update: {
      contentBlocks?: any[] | null
      toolCalls?: any[] | null
    }
  ): any | null {
    const message = this.statements.getMessageById.get(messageId)
    if (!message) return null

    this.db
      .prepare('UPDATE messages SET content_blocks = ?, tool_calls = ? WHERE id = ?')
      .run(JSON.stringify(update.contentBlocks ?? null), JSON.stringify(update.toolCalls ?? null), messageId)

    return this.statements.getMessageById.get(messageId)
  }
}
