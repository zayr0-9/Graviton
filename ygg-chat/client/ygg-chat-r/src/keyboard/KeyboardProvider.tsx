import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { CommandRegistry } from './commandRegistry'
import type { CommandHandler } from './commandRegistry'
import { isMacKeyboard } from './commands'
import { useShortcutOverrides } from './useShortcutOverrides'

const KeyboardContext = createContext<CommandRegistry | null>(null)

export const KeyboardProvider = ({ children }: { children: ReactNode }) => {
  const registry = useRef(new CommandRegistry()).current
  const overrides = useShortcutOverrides()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const editable = Boolean(target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor, .xterm'))
      // Semantic overlays block background commands even if focus has not moved yet.
      const blocked = [...document.querySelectorAll('[aria-modal="true"], dialog[open]')]
        .some(element => element.getClientRects().length > 0)
      registry.dispatch(event, { mac: isMacKeyboard(), editable, blocked, overrides })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [registry, overrides])
  return <KeyboardContext.Provider value={registry}>{children}</KeyboardContext.Provider>
}

/** Feature owners supply live callbacks; no feature state is copied into the registry. */
export const useCommands = (handlers: CommandHandler[]) => {
  const registry = useContext(KeyboardContext)
  const latest = useRef(handlers)
  useLayoutEffect(() => { latest.current = handlers })
  const ids = handlers.map(handler => handler.id).join(',')
  useLayoutEffect(() => {
    if (!registry) return
    const unregister = latest.current.map((handler, index) => registry.register({
      id: handler.id,
      run: event => latest.current[index].run(event),
      enabled: () => latest.current[index].enabled?.() ?? true,
      ...(handler.scope ? { scope: () => latest.current[index].scope?.() ?? null } : {}),
    }))
    return () => unregister.forEach(dispose => dispose())
  }, [registry, ids])
}

/** Use for non-semantic legacy overlays until their own keyboard scope is migrated. */
export const useCommandBlocker = (active: boolean) => {
  const registry = useContext(KeyboardContext)
  useLayoutEffect(() => {
    if (active) return registry?.block()
  }, [registry, active])
}
