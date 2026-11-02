import type { HeadlessBackgroundTask, HeadlessBackgroundTaskOutput } from '../../../../../shared/headlessApi'
import { buildLocalApiUrl } from '../../utils/api'

type TaskTarget = { conversationId: string; streamId: string; taskId: string }

const taskUrl = ({ conversationId, streamId, taskId }: TaskTarget, action: 'stop' | 'output') =>
  buildLocalApiUrl(`/conversations/${encodeURIComponent(conversationId)}/streams/${encodeURIComponent(streamId)}/tasks/${encodeURIComponent(taskId)}/${action}`)

async function readJson(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || fallback)
  return body
}

/** Stops one of a Claude run's background tasks; the run's `background_tasks` event reports the result. */
export async function stopBackgroundTask(target: TaskTarget): Promise<void> {
  await readJson(await fetch(await taskUrl(target, 'stop'), { method: 'POST' }), 'Could not stop the task')
}

/** The end of a background shell or Monitor task's output (the last 8 KiB). */
export async function fetchBackgroundTaskOutput(target: TaskTarget): Promise<HeadlessBackgroundTaskOutput> {
  return readJson(await fetch(await taskUrl(target, 'output')), 'Could not read the task output')
}

// The SDK documents Monitor tasks but not their task_type spelling.
const isMonitor = (kind: string) => kind.includes('monitor')

/** Only shell and Monitor tasks keep an output file the CLI can read back. */
export const backgroundTaskHasOutput = (task: HeadlessBackgroundTask) => task.kind === 'local_bash' || isMonitor(task.kind)

const KIND_LABELS: Record<string, string> = {
  local_bash: 'Shell', local_agent: 'Agent', local_workflow: 'Workflow', mcp_task: 'MCP',
}
export const backgroundTaskKindLabel = (kind: string) => KIND_LABELS[kind] ?? (isMonitor(kind) ? 'Monitor' : 'Task')

export const backgroundTasksSummary = (count: number) => `${count} background task${count === 1 ? '' : 's'}`
