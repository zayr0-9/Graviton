import React from 'react'
import type { ClaudeBackgroundTask } from '../../../../../shared/claudeProvider'
import { formatTaskDuration, formatTaskTokens } from '../../features/chats/backgroundTasks'
import { MONO_DETAIL_CLASS, MONO_KEY_CLASS } from './chatMessageShared'
import { Badge, SurfaceCard, type BadgeTone, type DisclosureTone } from './messagePrimitives'

const STATUS: Record<ClaudeBackgroundTask['status'], { label: string; tone: BadgeTone; disclosure: DisclosureTone }> = {
  running: { label: 'running', tone: 'info', disclosure: 'running' },
  completed: { label: 'completed', tone: 'success', disclosure: 'success' },
  failed: { label: 'failed', tone: 'error', disclosure: 'error' },
  stopped: { label: 'stopped', tone: 'warning', disclosure: 'warning' },
}

/** Header tone of the card that launched the task. */
export const backgroundTaskTone = (task: ClaudeBackgroundTask): DisclosureTone => STATUS[task.status].disclosure

// Workflow agents report 'start' while running and 'done' once finished; anything else is shown as is.
const agentState = (state: string, taskRunning: boolean): { label: string; tone: BadgeTone } => {
  if (state === 'done') return { label: 'done', tone: 'success' }
  if (state === 'start') return taskRunning ? { label: 'running', tone: 'info' } : { label: 'stopped', tone: 'warning' }
  return { label: state, tone: /fail|error/i.test(state) ? 'error' : 'neutral' }
}


/** Live status of a background task Claude launched: agents, current step, then the result summary. */
export const BackgroundTaskView: React.FC<{ task: ClaudeBackgroundTask }> = ({ task }) => {
  const status = STATUS[task.status]
  const running = task.status === 'running'
  const usage = task.usage
  return (
    <SurfaceCard title={task.workflowName ?? task.description} badge={<Badge tone={status.tone}>{status.label}</Badge>}>
      {task.workflowName && task.description && <div className={MONO_DETAIL_CLASS}>{task.description}</div>}
      {task.agents && task.agents.length > 0 && (
        <ul className='space-y-1' aria-label='Workflow agents'>
          {task.agents.map((agent, index) => {
            const state = agentState(agent.state, running)
            return (
              <li key={`${index}-${agent.label}`} className={`flex min-w-0 items-center gap-2 ${MONO_DETAIL_CLASS}`}>
                <span className='min-w-0 flex-1 truncate'>
                  {agent.phase && <span className={MONO_KEY_CLASS}>{agent.phase} · </span>}
                  {agent.label}
                </span>
                <Badge tone={state.tone}>{state.label}</Badge>
              </li>
            )
          })}
        </ul>
      )}
      {running && task.progress && <div className={`${MONO_DETAIL_CLASS} truncate`} title={task.progress}>{task.progress}</div>}
      {running && task.activity && task.activity !== task.progress && (
        <div className={`${MONO_DETAIL_CLASS} truncate`} title={task.activity}>{task.activity}</div>
      )}
      {running && task.lastTool && <div className={`${MONO_DETAIL_CLASS} ${MONO_KEY_CLASS}`}>Last tool: {task.lastTool}</div>}
      {!running && task.summary && <div className={MONO_DETAIL_CLASS}>{task.summary}</div>}
      {usage && usage.totalTokens > 0 && (
        <div className={`${MONO_DETAIL_CLASS} ${MONO_KEY_CLASS}`}>
          {formatTaskTokens(usage.totalTokens)} tokens · {usage.toolUses} tool use{usage.toolUses === 1 ? '' : 's'} · {formatTaskDuration(usage.durationMs)}
        </div>
      )}
    </SurfaceCard>
  )
}
