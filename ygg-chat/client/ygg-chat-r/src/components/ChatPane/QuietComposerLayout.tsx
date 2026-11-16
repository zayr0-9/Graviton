import React, { createContext, useContext, useLayoutEffect, useMemo, useState } from 'react'

/** Ephemeral presentation targets only. The App-owned agents controller never moves. */
const AgentsHeaderContext = createContext<{
  launcher: HTMLElement | null
  notice: HTMLElement | null
  setLauncher: (node: HTMLElement | null) => void
  setNotice: (node: HTMLElement | null) => void
}>({ launcher: null, notice: null, setLauncher: () => {}, setNotice: () => {} })

export function AgentsHeaderProvider({ children }: { children: React.ReactNode }) {
  const [launcher, setLauncher] = useState<HTMLElement | null>(null)
  const [notice, setNotice] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ launcher, notice, setLauncher, setNotice }), [launcher, notice])
  return <AgentsHeaderContext.Provider value={value}>{children}</AgentsHeaderContext.Provider>
}
export const useAgentsHeader = () => useContext(AgentsHeaderContext)

export function AgentsHeaderSlots() {
  const { setLauncher, setNotice } = useAgentsHeader()
  return <>
    <span ref={setLauncher} className='quiet-agents-slot' />
    <div ref={setNotice} className='quiet-notice-slot' />
  </>
}

/** Layout follows pane width, never the runtime or pointer type. */
export function useCompactComposer(ref: React.RefObject<HTMLElement | null>) {
  const [compact, setCompact] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setCompact(element.clientWidth > 0 && element.clientWidth < 768)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return compact
}
