import { localApi } from './api'

/** Execute UI-triggered tools through the shared job queue, without chat-loop orchestration. */
export async function executeToolAndWait<T>(request: {
  toolName: string
  args: Record<string, unknown>
}): Promise<{ result: T }> {
  const response = await localApi.post<{ success: boolean; result?: T; error?: string }>(
    '/jobs/execute-and-wait',
    request
  )
  if (!response.success) {
    throw new Error(response.error || `Tool execution failed: ${request.toolName}`)
  }
  // Keep the tool payload separate from the job lifecycle envelope. A completed
  // job can still return a tool-level failure, which callers handle as before.
  return { result: response.result as T }
}
