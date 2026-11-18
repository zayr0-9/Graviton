import { useEffect } from 'react'
import ProtectedRoute from '../components/ProtectedRoute'
import { RunningAgentsFloatingButton } from '../components/RunningAgentsFloatingButton'
import { useConversations, useResearchNotes } from '../hooks/useQueries'

const AgentsWindowBody = () => {
  const { data: notes = [] } = useResearchNotes()
  const { data: allConversations = [] } = useConversations()
  return <RunningAgentsFloatingButton presentation='window' notes={notes} allConversations={allConversations} />
}

/** The detached agents window (`#/agents-window`): the agents pill's expanded view, full-window. */
export default function AgentsWindow() {
  useEffect(() => { document.title = 'Graviton - Agents' }, [])
  return <ProtectedRoute><AgentsWindowBody /></ProtectedRoute>
}
