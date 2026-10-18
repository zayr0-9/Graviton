import { getBindings, getCommand, matchesBinding } from './commands'
import type { CommandId, ShortcutOverrides } from './commands'

export type CommandHandler = {
  id: CommandId
  run: (event: KeyboardEvent) => void
  /** Direct keyboard owner (not descendants such as search fields or buttons).
   * A focused widget wins over an application-wide handler.
   */
  scope?: () => Element | null
  enabled?: () => boolean
}

export class CommandRegistry {
  private handlers = new Set<CommandHandler>()
  private blockers = new Set<object>()

  register(handler: CommandHandler) {
    this.handlers.add(handler)
    return () => { this.handlers.delete(handler) }
  }

  block() {
    const token = {}
    this.blockers.add(token)
    return () => { this.blockers.delete(token) }
  }

  dispatch(event: KeyboardEvent, context: { mac: boolean; editable: boolean; blocked?: boolean; overrides?: ShortcutOverrides }): boolean {
    if (event.defaultPrevented || event.isComposing || context.blocked || this.blockers.size > 0) return false
    const candidates = [...this.handlers].filter(handler => {
      if (handler.enabled && !handler.enabled()) return false
      if (handler.scope) {
        const scope = handler.scope()
        if (!scope || event.target !== scope) return false
      }
      const command = getCommand(handler.id)
      if (context.editable && !command.allowInInput) return false
      const bindings = getBindings(handler.id, context.mac, context.overrides)
      return bindings.some(binding => matchesBinding(event, binding, context.mac))
    }).sort((a, b) => Number(Boolean(b.scope)) - Number(Boolean(a.scope)))
    const handler = candidates[0]
    if (!handler) return false
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat || getCommand(handler.id).repeat) handler.run(event)
    return true
  }
}
