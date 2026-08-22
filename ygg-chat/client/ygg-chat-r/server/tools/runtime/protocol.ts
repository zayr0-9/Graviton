export interface ToolExecutionOptions {
  rootPath?: string
  operationMode?: 'plan' | 'execute'
  conversationId?: string | null
  messageId?: string | null
  parentMessageId?: string | null
  streamId?: string | null
  toolCallId?: string | null
}

export interface UtilityExecuteToolRequest {
  type: 'execute_tool'
  requestId: string
  toolName: string
  args: any
  options?: ToolExecutionOptions
}

export interface UtilityShutdownRequest {
  type: 'shutdown'
  requestId: string
}

export interface UtilityReloadCustomToolsRequest {
  type: 'reload_custom_tools'
  requestId: string
  reason?: string
}

export type UtilityRuntimeRequest =
  | UtilityExecuteToolRequest
  | UtilityShutdownRequest
  | UtilityReloadCustomToolsRequest

export interface UtilityReadyEvent {
  type: 'ready'
}

export interface UtilityRequestTelemetry {
  durationMs?: number
  handledBy?: 'built_in' | 'custom'
}

export interface UtilityExecuteToolResponse {
  type: 'tool_result'
  requestId: string
  success: boolean
  result?: any
  error?: string
  errorCode?: string
  telemetry?: UtilityRequestTelemetry
}

export interface UtilityShutdownResponse {
  type: 'shutdown_ack'
  requestId: string
}

export interface UtilityReloadCustomToolsResponse {
  type: 'custom_tools_reloaded'
  requestId: string
  success: boolean
  totalCount?: number
  error?: string
  durationMs?: number
}

export type UtilityRuntimeResponse =
  | UtilityReadyEvent
  | UtilityExecuteToolResponse
  | UtilityShutdownResponse
  | UtilityReloadCustomToolsResponse
