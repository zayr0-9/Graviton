import { useEffect, useRef } from 'react'
import { isAgentsWindow } from '../platform/agentsWindow'
import { isBrowserClient, isHostClient } from '../platform/clientCapabilities'
import { useAppDispatch } from './redux'

const FINISHED_RUNS_POLL_MS = 5000

/**
 * Keeps the agents pill in step with runs it did not start:
 * - Every host client installs recently finished runs from the host, so a reload (or the
 *   agents window) still lists finished forks with their transcripts.
 * - The agents window also attaches a reader to every live host run, so its cards stream.
 *   The main window does not: it already reads the runs it started or opened in Chat.
 * The chat modules load lazily: this hook sits under the pill's data hook, whose
 * importers should not pull in the chat store.
 */
export function useHostAgentRunSync(hostRuns: ReadonlyArray<{ streamId: string; conversationId: string }>, liveForkKeys: ReadonlySet<string>, showFinished: boolean) {
  const dispatch = useAppDispatch()
  const liveForkKeysRef = useRef(liveForkKeys)
  liveForkKeysRef.current = liveForkKeys
  const attemptedFinishedRef = useRef(new Set<string>())
  const attachedRef = useRef(new Set<string>())

  const syncFinished = isHostClient && (!isBrowserClient || showFinished)
  useEffect(() => {
    if (!syncFinished) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const { syncFinishedAgentRuns } = await import('../features/chats/finishedAgentRuns')
        if (!controller.signal.aborted) await dispatch(syncFinishedAgentRuns(liveForkKeysRef.current, attemptedFinishedRef.current, controller.signal))
      } catch { /* Retry on the next poll. */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, FINISHED_RUNS_POLL_MS) }
    }
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [dispatch, syncFinished])

  useEffect(() => {
    if (!isAgentsWindow()) return
    const fresh = hostRuns.filter(run => !attachedRef.current.has(run.streamId))
    if (!fresh.length) return
    for (const run of fresh) attachedRef.current.add(run.streamId)
    void import('../features/chats/chatActions').then(({ resumeInFlightStreams }) => {
      for (const run of fresh) void dispatch(resumeInFlightStreams({ conversationId: run.conversationId, streamId: run.streamId }))
    })
  }, [hostRuns, dispatch])
}
