import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  HermesAcpClient,
  type HermesAcpMcpServer,
  type HermesBridgeEvent,
  type HermesPermissionRequest,
  type HermesResponse,
  type HermesStreamChunk,
  type OnHermesPermissionRequest,
  type OnHermesResponse,
  type OnHermesStreamingChunk,
  getHermesLauncherDiagnostics,
  resolveAcpLauncher,
} from './hermesAcpClient.js'

export type {
  HermesBridgeEvent,
  HermesPermissionRequest,
  HermesResponse,
  HermesStreamChunk,
  OnHermesPermissionRequest,
  OnHermesResponse,
  OnHermesStreamingChunk,
}

const sessions = new Map<string, string>()

function createSessionKey(conversationId: string, cwd: string): string {
  return `${conversationId}:${cwd}`
}

export function getHermesSession(conversationId: string, cwd: string): string | undefined {
  return sessions.get(createSessionKey(conversationId, cwd))
}

export function setHermesSession(conversationId: string, cwd: string, sessionId: string): void {
  sessions.set(createSessionKey(conversationId, cwd), sessionId)
}

export function normalizeHermesModel(model?: string): string | undefined {
  if (!model) return undefined

  const raw = model.trim()
  if (!raw) return undefined

  const normalizedKey = raw.toLowerCase().replace(/[_\s]+/g, ' ').trim()

  const aliases: Record<string, string> = {
    'gpt-5.4': 'gpt-5.4',
    'gpt-5.4 mini': 'gpt-5.4-mini',
    'gpt-5.3 codex': 'gpt-5.3-codex',
    'gpt-5.3 codex spark': 'gpt-5.3-codex-spark',
    'gpt-5.2': 'gpt-5.5',
    'gpt-5.2 codex': 'gpt-5.3-codex',
    'gpt-5.1 codex max': 'gpt-5.3-codex',
    'gpt-5.1 codex mini': 'gpt-5.3-codex',
    'gpt-5-mini': 'openai/gpt-5-mini',
    'openai/gpt-5.1-codex-mini': 'openai/gpt-5.3-codex',
  }

  return aliases[normalizedKey] || raw
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export function buildHermesYggMcpServerName(conversationId: string, cwd: string): string {
  const digest = createHash('sha256')
    .update(`${conversationId}\n${cwd}`)
    .digest('hex')
    .slice(0, 10)

  return `ygg-${digest}`
}

export function resolveHermesAcpMcpServers(
  conversationId: string,
  cwd: string,
  launchMode: 'native' | 'wsl'
): HermesAcpMcpServer[] {
  const authToken = readTrimmedEnv('YGG_HERMES_MCP_AUTH_TOKEN')
  const localServerUrl = readTrimmedEnv('YGG_LOCAL_SERVER_URL')
  const localServerLanUrl = readTrimmedEnv('YGG_LOCAL_SERVER_LAN_URL')

  if (!authToken) return []

  const preferredBaseUrl = launchMode === 'wsl' ? localServerLanUrl || localServerUrl : localServerUrl || localServerLanUrl
  if (!preferredBaseUrl) return []

  const endpointUrl = new URL('/api/mcp/ygg', preferredBaseUrl).toString()

  return [
    {
      name: buildHermesYggMcpServerName(conversationId, cwd),
      transport: 'http',
      type: 'http',
      enabled: true,
      url: endpointUrl,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'X-Ygg-Hermes-Conversation-Id': conversationId,
        'X-Ygg-Hermes-Cwd': cwd,
      },
    },
  ]
}

function extractSessionId(event: HermesBridgeEvent): string | undefined {
  return event.session_id || event.sessionId
}

async function emitAndTrackSession(
  event: HermesBridgeEvent,
  conversationId: string,
  cwd: string,
  onResponse?: OnHermesResponse
): Promise<string | undefined> {
  const sessionId = extractSessionId(event)
  if (sessionId) {
    setHermesSession(conversationId, cwd, sessionId)
  }

  if (onResponse) {
    await onResponse({
      messageType:
        event.type === 'session'
          ? 'session'
          : event.type === 'assistant_message'
            ? 'assistant_message'
            : event.type === 'tool_start'
              ? 'tool_start'
              : event.type === 'tool_result'
                ? 'tool_result'
                : event.type === 'final'
                  ? 'final'
                  : event.type === 'conversation_end'
                    ? 'conversation_end'
                    : event.type === 'error'
                      ? 'error'
                      : 'event',
      timestamp: new Date(),
      sessionId,
      event,
      error:
        event.type === 'error'
          ? {
              code: typeof event.code === 'string' ? event.code : undefined,
              message: typeof event.message === 'string' ? event.message : 'Hermes ACP error',
            }
          : undefined,
    })
  }

  return sessionId
}

export async function executeHermesAgent(
  conversationId: string,
  userMessage: string,
  cwd: string,
  onResponse?: OnHermesResponse,
  onStreamingChunk?: OnHermesStreamingChunk,
  sessionId?: string,
  forkSession?: boolean,
  model?: string,
  _maxIterations?: number,
  abortSignal?: AbortSignal,
  onPermissionRequest?: OnHermesPermissionRequest
): Promise<string | null> {
  const existingSessionId = sessionId || (!forkSession ? getHermesSession(conversationId, cwd) : undefined)
  const normalizedModel = normalizeHermesModel(model)
  const launcher = resolveAcpLauncher()
  const launcherDiagnostics = getHermesLauncherDiagnostics(cwd)

  console.info('[HermesAgent] Launching Hermes ACP', {
    ...launcherDiagnostics,
    mcpServers: [],
    mcpServerInjectionEnabled: false,
  })

  const proc = spawn(launcher.command, launcher.args, {
    cwd: launcher.spawnCwd,
    shell: false,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const client = new HermesAcpClient(proc, {
    cwd,
    onResponse,
    onStreamingChunk,
    onPermissionRequest,
    abortSignal,
  })

  let latestSessionId: string | null = existingSessionId || null

  try {
    const initializeResult = await client.initialize()
    console.info('[HermesAgent] Hermes ACP initialized', {
      requestedLaunchMode: launcher.requestedLaunchMode,
      effectiveLaunchMode: launcher.launchMode,
      launchSource: launcher.launchSource,
      agentInfo: initializeResult?.agentInfo ?? initializeResult?.agent_info ?? null,
      sessionCapabilities:
        initializeResult?.agentCapabilities?.sessionCapabilities ??
        initializeResult?.agent_capabilities?.session_capabilities ??
        null,
    })
    await client.maybeAuthenticate(initializeResult)

    let activeSessionId = existingSessionId

    if (activeSessionId && forkSession) {
      activeSessionId = await client.forkSession(activeSessionId, cwd)
      latestSessionId = activeSessionId
      await emitAndTrackSession(
        {
          type: 'session',
          session_id: activeSessionId,
          source: 'fork',
          parent_session_id: existingSessionId,
        },
        conversationId,
        cwd,
        onResponse
      )
    } else if (activeSessionId) {
      await client.loadSession(activeSessionId, cwd)
      latestSessionId = activeSessionId
      await emitAndTrackSession(
        {
          type: 'session',
          session_id: activeSessionId,
          source: 'load',
        },
        conversationId,
        cwd,
        onResponse
      )
    } else {
      activeSessionId = await client.newSession(cwd)
      latestSessionId = activeSessionId
      await emitAndTrackSession(
        {
          type: 'session',
          session_id: activeSessionId,
          source: 'new',
        },
        conversationId,
        cwd,
        onResponse
      )
    }

    if (!activeSessionId) {
      throw new Error('Hermes ACP session was not established')
    }

    if (normalizedModel) {
      try {
        await client.setSessionModel(activeSessionId, normalizedModel)
      } catch (error) {
        console.warn('[HermesAgent] Failed to set ACP session model:', error)
      }
    }

    const promptResult = await client.prompt(activeSessionId, userMessage)
    latestSessionId = activeSessionId
    setHermesSession(conversationId, cwd, activeSessionId)

    if (abortSignal?.aborted || promptResult.stopReason === 'cancelled') {
      throw Object.assign(new Error('Hermes ACP prompt cancelled'), { name: 'AbortError' })
    }

    if (promptResult.finalText || promptResult.finalReasoning) {
      await emitAndTrackSession(
        {
          type: 'final',
          session_id: activeSessionId,
          content: promptResult.finalText,
          reasoning: promptResult.finalReasoning,
          stop_reason: promptResult.stopReason,
          usage: promptResult.usage,
        },
        conversationId,
        cwd,
        onResponse
      )
    }

    await emitAndTrackSession(
      {
        type: 'conversation_end',
        session_id: activeSessionId,
        stop_reason: promptResult.stopReason,
        usage: promptResult.usage,
      },
      conversationId,
      cwd,
      onResponse
    )

    return latestSessionId
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (!(error instanceof Error && error.name === 'AbortError')) {
      await emitAndTrackSession(
        {
          type: 'error',
          session_id: latestSessionId || undefined,
          message: errorMessage,
          code: 'HERMES_ACP_ERROR',
        },
        conversationId,
        cwd,
        onResponse
      )
    }
    throw error
  } finally {
    client.close()
  }
}
