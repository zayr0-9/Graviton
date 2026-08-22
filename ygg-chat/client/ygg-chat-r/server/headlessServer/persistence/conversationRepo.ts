interface ConversationRepoDeps {
  db: any
  statements: any
}

export class ConversationRepo {
  private readonly db: any
  private readonly statements: any

  constructor(deps: ConversationRepoDeps) {
    this.db = deps.db
    this.statements = deps.statements
  }

  exists(conversationId: string): boolean {
    return Boolean(this.statements.getConversationById.get(conversationId))
  }

  getById(conversationId: string): any {
    return this.statements.getConversationById.get(conversationId)
  }

  getMessageById(messageId: string): any {
    return this.statements.getMessageById.get(messageId)
  }

  listMessages(conversationId: string): any[] {
    return this.statements.getMessagesByConversationId.all(conversationId)
  }

  listPathToMessage(conversationId: string, messageId: string | null): any[] {
    if (!messageId) return this.listMessages(conversationId)

    const chain: any[] = []
    const seen = new Set<string>()
    let cursor: string | null = messageId

    while (cursor) {
      if (seen.has(cursor)) break
      seen.add(cursor)

      const message = this.getMessageById(cursor)
      if (!message || message.conversation_id !== conversationId) break

      chain.unshift(message)
      cursor = message.parent_id || null
    }

    return chain.length > 0 ? chain : this.listMessages(conversationId)
  }

  findNearestUserAncestor(conversationId: string, messageId: string | null): any | null {
    if (!messageId) return null

    const seen = new Set<string>()
    let cursor: string | null = messageId

    while (cursor) {
      if (seen.has(cursor)) break
      seen.add(cursor)

      const message = this.getMessageById(cursor)
      if (!message || message.conversation_id !== conversationId) return null
      if (message.role === 'user') return message

      cursor = message.parent_id || null
    }

    return null
  }

  touch(conversationId: string, at: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, conversationId)
  }
}
