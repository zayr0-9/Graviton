/**
 * Shared iframe message bridge for custom tools
 * Used by both HtmlIframeRegistry (Tool Manager) and ChatMessage (Inline Chat)
 * to ensure consistent IPC handler support across all contexts.
 */

import { getToolByName } from '../features/chats/toolDefinitions'
import { getSessionFromStorage, refreshTokenIfNeeded } from '../lib/jwtUtils'
import { globalAgentLoop } from '../services'
import { buildLocalApiUrl, createStreamingRequest, environment, localApi } from './api'

type StreamState = {
  targets: Set<string>
  pendingEvents: Map<string, Array<{ type: string; payload: any }>>
  awaitingResponse: number
}

type ToolContext = {
  toolName?: string | null
}

type AgentBridgeState = {
  subscriptionId: string | null
  unsubscribe: (() => void) | null
}

type BridgeContext = {
  getIframe: () => HTMLIFrameElement | null
  getUserId: () => string | null
  getToolContext?: () => ToolContext | null
}

type GenerationProvider = 'openrouter' | 'openaichatgpt' | 'lmstudio' | 'zai' | 'bedrock'

type GenerationStreamResult = {
  text: string
  images: Array<{ url: string; mimeType: string }>
}

function normalizeGenerationProvider(provider: string): GenerationProvider | null {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'openrouter') return 'openrouter'
  if (normalized === 'lmstudio') return 'lmstudio'
  if (normalized === 'zai' || normalized === 'z.ai' || normalized === 'glm') return 'zai'
  if (
    normalized === 'bedrock' ||
    normalized === 'aws' ||
    normalized === 'awsbedrock' ||
    normalized === 'aws-bedrock' ||
    normalized === 'amazonbedrock' ||
    normalized === 'amazon-bedrock'
  ) return 'bedrock'
  if (normalized === 'openai' || normalized === 'openaichatgpt' || normalized === 'openai(chatgpt)') {
    return 'openaichatgpt'
  }
  return null
}

function resolveGenerationProvider(modelName: string, provider?: string): GenerationProvider {
  const explicit = typeof provider === 'string' ? normalizeGenerationProvider(provider) : null
  if (explicit) return explicit

  if (modelName.includes('/')) return 'openrouter'
  if (/^(gpt-|o1|o3|o4)/i.test(modelName)) return 'openaichatgpt'
  if (/lmstudio|local-model/i.test(modelName)) return 'lmstudio'
  if (/^(glm-|zai|z\.ai)/i.test(modelName)) return 'zai'
  if (/^(bedrock|aws|awsbedrock|aws-bedrock|amazonbedrock|amazon-bedrock)\//i.test(modelName) || /^anthropic\.claude-/i.test(modelName)) return 'bedrock'
  return 'openrouter'
}

/**
 * Creates the message handler function for iframe IPC bridge
 */
export function createMessageHandler(
  context: BridgeContext,
  streamState: StreamState,
  flushPendingEvents: (streamId: string) => void,
  agentState: AgentBridgeState
) {
  const electronAPI = (window as any).electronAPI
  const isElectron = environment === 'electron'

  const resolveAgentAccess = (): 'none' | 'read' | 'write' => {
    const toolName = context.getToolContext?.()?.toolName
    if (!toolName) return 'none'
    const tool = getToolByName(toolName)
    if (!tool?.isCustom) return 'none'
    const access = tool.appPermissions?.agent
    if (access === 'write') return 'write'
    if (access === 'read') return 'read'
    return 'none'
  }

  const hasAgentReadAccess = () => {
    const access = resolveAgentAccess()
    return access === 'read' || access === 'write'
  }

  const hasAgentWriteAccess = () => resolveAgentAccess() === 'write'

  return async (event: MessageEvent) => {
    const iframe = context.getIframe()
    if (!iframe || event.source !== iframe.contentWindow) {
      return
    }

    const { type, requestId, options } = event.data || {}
    if (!type || !requestId) return

    let response: any = { success: false, error: 'Unknown request type' }

    try {
      switch (type) {
        case 'DIALOG_OPEN_FILE':
          if (electronAPI?.dialog?.openFile) {
            response = await electronAPI.dialog.openFile(options)
          } else {
            response = { success: false, error: 'File dialog not available (not in Electron)' }
          }
          break

        case 'DIALOG_SAVE_FILE':
          if (electronAPI?.dialog?.saveFile) {
            response = await electronAPI.dialog.saveFile(options)
          } else {
            response = { success: false, error: 'Save dialog not available (not in Electron)' }
          }
          break

        case 'FS_READ_FILE':
          if (electronAPI?.fs?.readFile) {
            response = await electronAPI.fs.readFile(options?.filePath, options?.encoding)
          } else {
            response = { success: false, error: 'File read not available (not in Electron)' }
          }
          break

        case 'FS_READ_FILE_STREAM':
          if (electronAPI?.fs?.readFileStream) {
            streamState.awaitingResponse += 1
            try {
              response = await electronAPI.fs.readFileStream(options?.filePath, {
                encoding: options?.encoding,
                highWaterMark: options?.highWaterMark,
              })
              if (response?.success && response?.streamId) {
                streamState.targets.add(response.streamId)
                flushPendingEvents(response.streamId)
              }
            } catch (err) {
              response = { success: false, error: String(err) }
            } finally {
              streamState.awaitingResponse = Math.max(0, streamState.awaitingResponse - 1)
              if (streamState.awaitingResponse === 0) {
                streamState.pendingEvents.clear()
              }
            }
          } else {
            response = { success: false, error: 'File stream not available (not in Electron)' }
          }
          break

        case 'FS_STAT':
          if (electronAPI?.fs?.stat) {
            response = await electronAPI.fs.stat(options?.filePath)
          } else {
            response = { success: false, error: 'File stat not available (not in Electron)' }
          }
          break

        case 'FS_ABORT':
          if (electronAPI?.fs?.abortReadFileStream) {
            response = await electronAPI.fs.abortReadFileStream(options?.streamId)
          } else {
            response = { success: false, error: 'Stream abort not available (not in Electron)' }
          }
          break

        case 'FS_WRITE_FILE':
          if (electronAPI?.fs?.writeFile) {
            response = await electronAPI.fs.writeFile(options?.filePath, options?.content, options?.encoding)
          } else {
            response = { success: false, error: 'File write not available (not in Electron)' }
          }
          break

        case 'FS_MKDIR':
          if (electronAPI?.fs?.mkdir) {
            response = await electronAPI.fs.mkdir(options?.dirPath)
          } else {
            response = { success: false, error: 'Mkdir not available (not in Electron)' }
          }
          break

        case 'SHELL_EXEC':
          if (electronAPI?.exec?.run) {
            response = await electronAPI.exec.run(options?.command, { cwd: options?.cwd, timeout: options?.timeout })
          } else {
            response = { success: false, error: 'Shell exec not available (not in Electron)' }
          }
          break

        case 'HTTP_REQUEST':
          if (electronAPI?.http?.request) {
            response = await electronAPI.http.request({
              url: options?.url,
              method: options?.method,
              headers: options?.headers,
              body: options?.body,
              timeout: options?.timeout,
            })
          } else {
            response = { success: false, error: 'HTTP request not available (not in Electron)' }
          }
          break

        case 'AUTH_CONTEXT': {
          const userId = context.getUserId()
          response = { success: true, tenantId: userId ?? null }
          break
        }

        case 'AGENT_CONTEXT': {
          if (!isElectron) {
            response = { success: false, error: 'Global agent is only available in Electron' }
            break
          }
          if (!hasAgentReadAccess()) {
            response = { success: false, error: 'Agent access not permitted' }
            break
          }
          response = { success: true, state: globalAgentLoop.getState() }
          break
        }

        case 'AGENT_MESSAGES': {
          if (!isElectron) {
            response = { success: false, error: 'Global agent is only available in Electron' }
            break
          }
          if (!hasAgentReadAccess()) {
            response = { success: false, error: 'Agent access not permitted' }
            break
          }
          const state = globalAgentLoop.getState()
          const conversationId = state.conversationId
          if (!conversationId) {
            response = { success: false, error: 'No active agent conversation' }
            break
          }
          const messages = await localApi.get<any[]>(`/app/conversations/${conversationId}/messages`)
          const limit = Number.isFinite(options?.limit) ? Math.max(0, Math.floor(options.limit)) : null
          const sliced = limit && limit > 0 ? messages.slice(-limit) : messages
          response = { success: true, conversationId, messages: sliced }
          break
        }

        case 'AGENT_TASKS': {
          if (!isElectron) {
            response = { success: false, error: 'Global agent is only available in Electron' }
            break
          }
          if (!hasAgentReadAccess()) {
            response = { success: false, error: 'Agent access not permitted' }
            break
          }
          const status = typeof options?.status === 'string' ? options.status : 'pending'
          const endpoint = status ? `/agent/tasks?status=${encodeURIComponent(status)}` : '/agent/tasks'
          const result = await localApi.get<{ success: boolean; tasks?: any[] }>(endpoint)
          let tasks = Array.isArray(result?.tasks) ? result.tasks : []
          const limit = Number.isFinite(options?.limit) ? Math.max(0, Math.floor(options.limit)) : null
          if (limit && limit > 0) {
            tasks = tasks.slice(0, limit)
          }
          response = { success: true, tasks }
          break
        }

        case 'AGENT_ENQUEUE_TASK': {
          if (!isElectron) {
            response = { success: false, error: 'Global agent is only available in Electron' }
            break
          }
          if (!hasAgentWriteAccess()) {
            response = { success: false, error: 'Agent write access not permitted' }
            break
          }
          const description = typeof options?.description === 'string' ? options.description.trim() : ''
          if (!description) {
            response = { success: false, error: 'Missing task description' }
            break
          }
          const toolName = context.getToolContext?.()?.toolName ?? null
          const source = toolName ? `app:${toolName}` : 'app'
          await globalAgentLoop.enqueueTask(description, options?.payload, source)
          response = { success: true }
          break
        }

        case 'AGENT_SUBSCRIBE': {
          if (!isElectron) {
            response = { success: false, error: 'Global agent is only available in Electron' }
            break
          }
          if (!hasAgentReadAccess()) {
            response = { success: false, error: 'Agent access not permitted' }
            break
          }
          if (agentState.unsubscribe) {
            response = { success: true, subscriptionId: agentState.subscriptionId }
            break
          }
          const subscriptionId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          agentState.subscriptionId = subscriptionId
          agentState.unsubscribe = globalAgentLoop.on(event => {
            iframe.contentWindow?.postMessage({ type: 'AGENT_EVENT', subscriptionId, event }, '*')
          })
          iframe.contentWindow?.postMessage(
            { type: 'AGENT_EVENT', subscriptionId, event: { type: 'state', state: globalAgentLoop.getState() } },
            '*'
          )
          response = { success: true, subscriptionId }
          break
        }

        case 'AGENT_UNSUBSCRIBE': {
          if (!isElectron) {
            response = { success: false, error: 'Global agent is only available in Electron' }
            break
          }
          if (agentState.unsubscribe) {
            agentState.unsubscribe()
            agentState.unsubscribe = null
            agentState.subscriptionId = null
          }
          response = { success: true }
          break
        }

        case 'CUSTOM_TOOL_EXECUTE': {
          const { toolPath, args: toolArgs, bustCache } = options || {}
          if (!toolPath) {
            response = { success: false, error: 'Missing toolPath' }
            break
          }

          if (electronAPI?.customTool?.execute) {
            const execArgs = bustCache ? { ...toolArgs, _bustCache: true } : toolArgs
            response = await electronAPI.customTool.execute(toolPath, execArgs)
          } else {
            response = { success: false, error: 'Custom tool execution not available (not in Electron)' }
          }
          break
        }

        case 'CUSTOM_TOOL_CLEAR_CACHE': {
          const { toolPath } = options || {}
          if (electronAPI?.customTool?.clearCache) {
            response = await electronAPI.customTool.clearCache(toolPath)
          } else {
            response = { success: false, error: 'Custom tool cache clear not available (not in Electron)' }
          }
          break
        }

        case 'EXECUTE_TOOL': {
          const { tool, args: toolArgs } = options || {}
          if (!tool) {
            response = { success: false, error: 'Missing tool name' }
            break
          }

          try {
            const result = await localApi.post<{ result?: any; [key: string]: any }>('/tools/execute', {
              tool,
              args: toolArgs || {},
            })
            response = result.result || result
          } catch (err) {
            response = { success: false, error: String(err) }
          }
          break
        }

        case 'RPC': {
          const { namespace, method, args } = options || {}
          if (!namespace || !method) {
            response = { success: false, error: 'RPC requires namespace and method' }
            break
          }

          const allowedNamespaces = ['fs', 'dialog', 'shell', 'exec', 'http', 'storage', 'platformInfo']
          if (!allowedNamespaces.includes(namespace)) {
            response = { success: false, error: `Namespace not allowed: ${namespace}` }
            break
          }

          const api = (electronAPI as any)?.[namespace]
          if (!api) {
            response = { success: false, error: `Namespace not available: ${namespace} (not in Electron)` }
            break
          }

          const fn = api[method]
          if (typeof fn !== 'function') {
            response = { success: false, error: `Method not found: ${namespace}.${method}` }
            break
          }

          try {
            const result = await fn(...(Array.isArray(args) ? args : []))
            if (result && typeof result === 'object' && 'success' in result) {
              response = result
            } else {
              response = { success: true, result }
            }
          } catch (err) {
            response = { success: false, error: String(err) }
          }
          break
        }

        case 'REQUEST_GENERATION': {
          const {
            prompt,
            model,
            provider,
            userId,
            accountId,
            maxTokens,
            temperature,
            systemPrompt,
            attachmentsBase64,
            tools,
            cwd,
            rootPath,
            response_format,
            responseFormat,
          } = options || {}

          if (!prompt) {
            response = { success: false, error: 'Missing prompt' }
            break
          }

          const modelName = typeof model === 'string' && model.trim() ? model.trim() : 'anthropic/claude-sonnet-4'
          const resolvedProvider = resolveGenerationProvider(modelName, provider)
          const effectiveResponseFormat = response_format ?? responseFormat

          const postChunk = (delta: string, fullText: string) => {
            iframe.contentWindow?.postMessage(
              {
                type: 'REQUEST_GENERATION_CHUNK',
                requestId,
                chunk: delta,
                text: fullText,
              },
              '*'
            )
          }

          const postReasoning = (delta: string) => {
            iframe.contentWindow?.postMessage(
              {
                type: 'REQUEST_GENERATION_REASONING',
                requestId,
                reasoning: delta,
              },
              '*'
            )
          }

          const postImage = (
            image: { url: string; mimeType: string },
            images: Array<{ url: string; mimeType: string }>
          ) => {
            iframe.contentWindow?.postMessage(
              {
                type: 'REQUEST_GENERATION_IMAGE',
                requestId,
                image,
                images: [...images],
              },
              '*'
            )
          }

          const streamCloudEphemeral = async (): Promise<GenerationStreamResult> => {
            const streamResponse = await createStreamingRequest('/generate/ephemeral', null, {
              method: 'POST',
              body: JSON.stringify({
                prompt,
                model: modelName,
                maxTokens: maxTokens || 4096,
                temperature: temperature ?? 0.7,
                systemPrompt,
                attachmentsBase64,
                response_format: effectiveResponseFormat,
              }),
            })

            if (!streamResponse.ok) {
              const errorText = await streamResponse.text()
              throw new Error(`HTTP ${streamResponse.status}: ${errorText}`)
            }

            const reader = streamResponse.body?.getReader()
            if (!reader) {
              throw new Error('No response body')
            }

            const decoder = new TextDecoder()
            let fullText = ''
            const images: Array<{ url: string; mimeType: string }> = []
            let sseBuffer = ''

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              sseBuffer += decoder.decode(value, { stream: true })
              const lines = sseBuffer.split('\n')
              sseBuffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                const data = trimmed.slice(5).trim()
                if (!data || data === '[DONE]') continue

                try {
                  const parsed = JSON.parse(data)
                  if (typeof parsed?.text === 'string' && parsed.text) {
                    fullText += parsed.text
                    postChunk(parsed.text, fullText)
                  }
                  if (typeof parsed?.reasoning === 'string' && parsed.reasoning) {
                    postReasoning(parsed.reasoning)
                  }
                  if (typeof parsed?.image === 'string' && parsed.image) {
                    const image = { url: parsed.image, mimeType: parsed?.mimeType || 'image/png' }
                    images.push(image)
                    postImage(image, images)
                  }
                } catch {
                  fullText += data
                  postChunk(data, fullText)
                }
              }
            }

            return { text: fullText, images }
          }

          const streamLocalHeadless = async (): Promise<GenerationStreamResult> => {
            await refreshTokenIfNeeded().catch(() => false)
            const session = getSessionFromStorage()
            const sessionUserId = session?.user?.id || null
            const accessToken = session?.access_token || null
            const effectiveUserId =
              (typeof userId === 'string' && userId.trim()) || context.getUserId() || sessionUserId || 'custom-tool-ui'
            const effectiveRootPath =
              (typeof rootPath === 'string' && rootPath.trim()) || (typeof cwd === 'string' && cwd.trim()) || null

            const conversation = await localApi.post<any>('/app/conversations', {
              user_id: effectiveUserId,
              title: `Custom Tool Generation (${resolvedProvider})`,
              project_id: null,
              cwd: effectiveRootPath,
            })

            const conversationId = typeof conversation?.id === 'string' ? conversation.id : null
            if (!conversationId) {
              throw new Error('Failed to create local conversation for generation')
            }

            const endpoint = await buildLocalApiUrl(`/conversations/${encodeURIComponent(conversationId)}/messages`)
            const requestBody: Record<string, any> = {
              content: String(prompt),
              provider: resolvedProvider,
              modelName,
              userId: effectiveUserId,
              systemPrompt,
              temperature: typeof temperature === 'number' ? temperature : undefined,
              attachmentsBase64: Array.isArray(attachmentsBase64) ? attachmentsBase64 : undefined,
              tools: Array.isArray(tools) ? tools : undefined,
              rootPath: effectiveRootPath,
            }

            if (typeof accountId === 'string' && accountId.trim()) {
              requestBody.accountId = accountId.trim()
            }
            if (accessToken) {
              requestBody.accessToken = accessToken
            }

            const streamResponse = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
              },
              body: JSON.stringify(requestBody),
            })

            if (!streamResponse.ok) {
              const errorText = await streamResponse.text()
              throw new Error(`HTTP ${streamResponse.status}: ${errorText}`)
            }

            const reader = streamResponse.body?.getReader()
            if (!reader) {
              throw new Error('No response body')
            }

            const decoder = new TextDecoder()
            let fullText = ''
            const images: Array<{ url: string; mimeType: string }> = []
            let sseBuffer = ''

            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              sseBuffer += decoder.decode(value, { stream: true })
              const lines = sseBuffer.split('\n')
              sseBuffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                const data = trimmed.slice(5).trim()
                if (!data || data === '[DONE]') continue

                let parsed: any = null
                try {
                  parsed = JSON.parse(data)
                } catch {
                  fullText += data
                  postChunk(data, fullText)
                  continue
                }

                if (parsed?.type === 'error') {
                  throw new Error(parsed?.error || 'Headless generation error')
                }

                if (parsed?.type === 'chunk') {
                  if (parsed.part === 'text' && typeof parsed.delta === 'string') {
                    fullText += parsed.delta
                    postChunk(parsed.delta, fullText)
                  }
                  if (parsed.part === 'reasoning' && typeof parsed.delta === 'string') {
                    postReasoning(parsed.delta)
                  }
                  if (parsed.part === 'image' && typeof parsed.url === 'string') {
                    const image = { url: parsed.url, mimeType: parsed?.mimeType || 'image/png' }
                    images.push(image)
                    postImage(image, images)
                  }
                  continue
                }

                if (parsed?.type === 'complete') {
                  const messageContent = typeof parsed?.message?.content === 'string' ? parsed.message.content : ''
                  if (!fullText && messageContent) {
                    fullText = messageContent
                    postChunk(messageContent, fullText)
                  }
                  continue
                }

                if (typeof parsed?.text === 'string' && parsed.text) {
                  fullText += parsed.text
                  postChunk(parsed.text, fullText)
                }
                if (typeof parsed?.reasoning === 'string' && parsed.reasoning) {
                  postReasoning(parsed.reasoning)
                }
                if (typeof parsed?.image === 'string' && parsed.image) {
                  const image = { url: parsed.image, mimeType: parsed?.mimeType || 'image/png' }
                  images.push(image)
                  postImage(image, images)
                }
              }
            }

            return { text: fullText, images }
          }

          try {
            const generated = isElectron ? await streamLocalHeadless() : await streamCloudEphemeral()
            response = { success: true, text: generated.text, images: generated.images, provider: resolvedProvider }
          } catch (err) {
            response = { success: false, error: String(err), provider: resolvedProvider }
          }
          break
        }

        // case 'REQUEST_GENERATION_LEGACY': {
        //   const {
        //     prompt,
        //     model,
        //     maxTokens,
        //     temperature,
        //     systemPrompt,
        //     attachmentsBase64,
        //     response_format,
        //     responseFormat,
        //   } = options || {}
        //   const effectiveResponseFormat = response_format ?? responseFormat

        //   if (!prompt) {
        //     response = { success: false, error: 'Missing prompt' }
        //     break
        //   }

        //   try {
        //     const streamResponse = await createStreamingRequest('/generate/ephemeral', null, {
        //       method: 'POST',
        //       body: JSON.stringify({
        //         prompt,
        //         model: model || 'anthropic/claude-sonnet-4',
        //         maxTokens: maxTokens || 4096,
        //         temperature: temperature ?? 0.7,
        //         systemPrompt,
        //         attachmentsBase64,
        //         response_format: effectiveResponseFormat,
        //       }),
        //     })

        //     if (!streamResponse.ok) {
        //       const errorText = await streamResponse.text()
        //       response = { success: false, error: `HTTP ${streamResponse.status}: ${errorText}` }
        //       break
        //     }

        //     const reader = streamResponse.body?.getReader()
        //     if (!reader) {
        //       response = { success: false, error: 'No response body' }
        //       break
        //     }

        //     const decoder = new TextDecoder()
        //     let fullText = ''
        //     const images: Array<{ url: string; mimeType: string }> = []
        //     let sseBuffer = ''

        //     while (true) {
        //       const { done, value } = await reader.read()
        //       if (done) break

        //       const chunk = decoder.decode(value, { stream: true })
        //       sseBuffer += chunk

        //       const lines = sseBuffer.split('\n')
        //       sseBuffer = lines.pop() || ''

        //       for (const line of lines) {
        //         if (line.startsWith('data: ')) {
        //           const data = line.slice(6)
        //           if (data === '[DONE]') continue
        //           try {
        //             const parsed = JSON.parse(data)
        //             if (parsed.text) {
        //               fullText += parsed.text
        //               iframe.contentWindow?.postMessage(
        //                 {
        //                   type: 'REQUEST_GENERATION_CHUNK',
        //                   requestId,
        //                   chunk: parsed.text,
        //                   text: fullText,
        //                 },
        //                 '*'
        //               )
        //             } else if (parsed.image) {
        //               const imageData = { url: parsed.image, mimeType: parsed.mimeType || 'image/png' }
        //               images.push(imageData)
        //               iframe.contentWindow?.postMessage(
        //                 {
        //                   type: 'REQUEST_GENERATION_IMAGE',
        //                   requestId,
        //                   image: imageData,
        //                   images: [...images],
        //                 },
        //                 '*'
        //               )
        //             } else if (parsed.reasoning) {
        //               iframe.contentWindow?.postMessage(
        //                 {
        //                   type: 'REQUEST_GENERATION_REASONING',
        //                   requestId,
        //                   reasoning: parsed.reasoning,
        //                 },
        //                 '*'
        //               )
        //             }
        //           } catch {
        //             if (data.trim()) {
        //               fullText += data
        //               iframe.contentWindow?.postMessage(
        //                 {
        //                   type: 'REQUEST_GENERATION_CHUNK',
        //                   requestId,
        //                   chunk: data,
        //                   text: fullText,
        //                 },
        //                 '*'
        //               )
        //             }
        //           }
        //         }
        //       }
        //     }

        //     response = { success: true, text: fullText, images }
        //   } catch (err) {
        //     response = { success: false, error: String(err) }
        //   }
        //   break
        // }
      }
    } catch (err) {
      response = { success: false, error: String(err) }
    }

    iframe.contentWindow?.postMessage({ type: `${type}_RESPONSE`, requestId, ...response }, '*')
  }
}

/**
 * Sets up stream event forwarding for file streaming
 */
export function setupStreamForwarding(
  getIframe: () => HTMLIFrameElement | null,
  streamState: StreamState
): (() => void)[] {
  const electronAPI = (window as any).electronAPI
  const cleanupFns: (() => void)[] = []

  const emitStreamEvent = (type: string, payload: any) => {
    const streamId = payload?.streamId
    if (!streamId) return
    const iframe = getIframe()
    iframe?.contentWindow?.postMessage({ type, ...payload }, '*')
    if (
      type === 'FS_READ_FILE_STREAM_END' ||
      type === 'FS_READ_FILE_STREAM_ERROR' ||
      type === 'FS_READ_FILE_STREAM_ABORTED'
    ) {
      streamState.targets.delete(streamId)
      streamState.pendingEvents.delete(streamId)
    }
  }

  const forwardStreamEvent = (type: string, payload: any) => {
    const streamId = payload?.streamId
    if (!streamId) return
    if (!streamState.targets.has(streamId)) {
      if (streamState.awaitingResponse > 0) {
        const pending = streamState.pendingEvents.get(streamId) || []
        pending.push({ type, payload })
        streamState.pendingEvents.set(streamId, pending)
      }
      return
    }
    emitStreamEvent(type, payload)
  }

  if (electronAPI?.fs?.onReadFileStreamChunk) {
    cleanupFns.push(
      electronAPI.fs.onReadFileStreamChunk((payload: any) => forwardStreamEvent('FS_READ_FILE_STREAM_CHUNK', payload))
    )
  }
  if (electronAPI?.fs?.onReadFileStreamProgress) {
    cleanupFns.push(
      electronAPI.fs.onReadFileStreamProgress((payload: any) =>
        forwardStreamEvent('FS_READ_FILE_STREAM_PROGRESS', payload)
      )
    )
  }
  if (electronAPI?.fs?.onReadFileStreamEnd) {
    cleanupFns.push(
      electronAPI.fs.onReadFileStreamEnd((payload: any) => forwardStreamEvent('FS_READ_FILE_STREAM_END', payload))
    )
  }
  if (electronAPI?.fs?.onReadFileStreamError) {
    cleanupFns.push(
      electronAPI.fs.onReadFileStreamError((payload: any) => forwardStreamEvent('FS_READ_FILE_STREAM_ERROR', payload))
    )
  }
  if (electronAPI?.fs?.onReadFileStreamAborted) {
    cleanupFns.push(
      electronAPI.fs.onReadFileStreamAborted((payload: any) =>
        forwardStreamEvent('FS_READ_FILE_STREAM_ABORTED', payload)
      )
    )
  }

  return cleanupFns
}

/**
 * Creates a flush function for pending stream events
 */
export function createFlushPendingEvents(getIframe: () => HTMLIFrameElement | null, streamState: StreamState) {
  return (streamId: string) => {
    const pending = streamState.pendingEvents.get(streamId)
    if (!pending || pending.length === 0) return
    const iframe = getIframe()
    pending.forEach(entry => {
      iframe?.contentWindow?.postMessage({ type: entry.type, ...entry.payload }, '*')
    })
    streamState.pendingEvents.delete(streamId)
  }
}

/**
 * Convenience function to set up the complete message bridge
 * Returns a cleanup function
 */
export function attachMessageBridge(
  getIframe: () => HTMLIFrameElement | null,
  getUserId: () => string | null,
  getToolContext?: () => ToolContext | null
): () => void {
  const streamState: StreamState = {
    targets: new Set(),
    pendingEvents: new Map(),
    awaitingResponse: 0,
  }
  const agentState: AgentBridgeState = {
    subscriptionId: null,
    unsubscribe: null,
  }

  const context: BridgeContext = { getIframe, getUserId, getToolContext }
  const flushPendingEvents = createFlushPendingEvents(getIframe, streamState)
  const streamCleanupFns = setupStreamForwarding(getIframe, streamState)
  const handleMessage = createMessageHandler(context, streamState, flushPendingEvents, agentState)

  window.addEventListener('message', handleMessage)

  return () => {
    window.removeEventListener('message', handleMessage)
    if (agentState.unsubscribe) {
      agentState.unsubscribe()
      agentState.unsubscribe = null
      agentState.subscriptionId = null
    }
    streamCleanupFns.forEach(cleanup => cleanup?.())
    streamState.targets.clear()
    streamState.pendingEvents.clear()
  }
}
