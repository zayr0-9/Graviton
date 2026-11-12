/**
 * Shared iframe message bridge for custom tools
 * Used by both HtmlIframeRegistry (Tool Manager) and ChatMessage (Inline Chat)
 * to ensure consistent IPC handler support across all contexts.
 */

import { createHostAppClient, getHostAppContext } from '../platform/hostAppClient'
import { isBrowserClient } from '../platform/clientCapabilities'
import { buildLocalApiUrl, localApi } from './api'
import { executeToolAndWait } from './executeToolAndWait'

type StreamState = {
  targets: Set<string>
  pendingEvents: Map<string, Array<{ type: string; payload: any }>>
  awaitingResponse: number
}

type ToolContext = {
  toolName?: string | null
}

type BridgeContext = {
  getIframe: () => HTMLIFrameElement | null
  getUserId: () => string | null
  getToolContext?: () => ToolContext | null
  registerCleanup?: (cleanup: () => void) => void
}

type GenerationProvider = 'openrouterbyok' | 'openaichatgpt' | 'lmstudio' | 'zai' | 'deepseek' | 'bedrock'

type GenerationStreamResult = {
  text: string
  images: Array<{ url: string; mimeType: string }>
}

function normalizeGenerationProvider(provider: string): GenerationProvider | null {
  const normalized = provider.trim().toLowerCase()
  // 'openrouter' was the retired hosted route; it now means the user's own OpenRouter key.
  if (normalized === 'openrouter' || normalized.replace(/\s+/g, '') === 'openrouterbyok') return 'openrouterbyok'
  if (normalized === 'lmstudio') return 'lmstudio'
  if (normalized === 'zai' || normalized === 'z.ai' || normalized === 'glm') return 'zai'
  if (normalized === 'deepseek') return 'deepseek'
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

const DEFAULT_GENERATION_MODELS: Record<GenerationProvider, string> = {
  openaichatgpt: 'gpt-5.6-sol',
  openrouterbyok: 'openai/gpt-5-mini',
  lmstudio: 'local-model',
  zai: 'glm-5.1',
  deepseek: 'deepseek-flash',
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
}

function inferProviderFromModel(modelName: string): GenerationProvider {
  if (/^(gpt-|o1|o3|o4)/i.test(modelName)) return 'openaichatgpt'
  if (/lmstudio|local-model/i.test(modelName)) return 'lmstudio'
  if (/^(glm-|zai|z\.ai)/i.test(modelName)) return 'zai'
  if (/^deepseek-/i.test(modelName)) return 'deepseek'
  if (/^(bedrock|aws|awsbedrock|aws-bedrock|amazonbedrock|amazon-bedrock)\//i.test(modelName) || /^anthropic\.claude-/i.test(modelName)) return 'bedrock'
  // Any other vendor/model slug is an OpenRouter model served with the user's own key.
  return 'openrouterbyok'
}

/** The provider and model the user currently has selected in the composer, when usable here. */
function readCurrentSelection(): { provider: GenerationProvider | null; model: string | null } {
  try {
    const provider = normalizeGenerationProvider(localStorage.getItem('currentProvider') || '')
    const raw = localStorage.getItem('selectedModel')
    const parsed = raw ? JSON.parse(raw) : null
    const model = parsed && typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null
    return { provider, model }
  } catch {
    return { provider: null, model: null }
  }
}

/**
 * Custom-tool generation defaults to the user's current provider and model (fully-local plan
 * Q8), falling back to ChatGPT. An explicit provider and/or model from the tool wins.
 */
function resolveGeneration(model: unknown, provider: unknown): { provider: GenerationProvider; modelName: string } {
  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : null
  const explicit = typeof provider === 'string' ? normalizeGenerationProvider(provider) : null
  if (requestedModel) return { provider: explicit ?? inferProviderFromModel(requestedModel), modelName: requestedModel }
  const current = readCurrentSelection()
  const resolved = explicit ?? current.provider ?? 'openaichatgpt'
  const modelName = resolved === current.provider && current.model ? current.model : DEFAULT_GENERATION_MODELS[resolved]
  return { provider: resolved, modelName }
}

/**
 * Creates the message handler function for iframe IPC bridge
 */
export function createMessageHandler(
  context: BridgeContext,
  streamState: StreamState,
  flushPendingEvents: (streamId: string) => void
) {
  const electronAPI = (window as any).electronAPI
  const appClient = createHostAppClient(() => ({ ...getHostAppContext(), ...context.getToolContext?.() }))
  const fileHashes = new Map<string, string>()
  const appStreams = new Map<string, AbortController>()
  context.registerCleanup?.(() => { appClient.dispose(); for (const controller of appStreams.values()) controller.abort(); appStreams.clear() })

  return async (event: MessageEvent) => {
    const iframe = context.getIframe()
    if (!iframe || event.source !== iframe.contentWindow) {
      return
    }

    const { type, requestId, options } = event.data || {}
    if (!type || !requestId) return

    let response: any = { success: false, error: 'Unknown request type' }

    try {
      const appMethods: Record<string, string> = { FS_READ_FILE: 'fs.readFile', FS_STAT: 'fs.stat', FS_WRITE_FILE: 'fs.writeFile', FS_MKDIR: 'fs.mkdir', SHELL_EXEC: 'exec.run', HTTP_REQUEST: 'http.request', CUSTOM_TOOL_EXECUTE: 'customTool.invoke', EXECUTE_TOOL: 'tools.invoke' }
      if (isBrowserClient && appMethods[type]) {
        const params = { ...options, ...(type === 'FS_WRITE_FILE' ? { expectedHash: options?.expectedHash ?? fileHashes.get(options?.filePath) } : {}) }
        response = await appClient.call(appMethods[type], params, requestId)
        if (response?.hash && options?.filePath) fileHashes.set(options.filePath, response.hash)
      } else switch (type) {
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
          if (isBrowserClient) {
            const read = await appClient.call('fs.readFile', { filePath: options?.filePath }, requestId)
            if (!read.success) { response = read; break }
            const streamId = `${requestId}:file`
            const controller = new AbortController()
            appStreams.set(streamId, controller); streamState.targets.add(streamId)
            response = { success: true, streamId }
            // Post after the acknowledgement. Only this parent owns the stream;
            // no global stream IDs or filesystem roots are exposed to the iframe.
            setTimeout(async () => {
              const content = String(read.content ?? '')
              try {
                for (let offset = 0; offset < content.length; offset += 65536) {
                  if (controller.signal.aborted) break
                  iframe.contentWindow?.postMessage({ type: 'FS_READ_FILE_STREAM_CHUNK', streamId, chunk: content.slice(offset, offset + 65536) }, '*')
                  await new Promise(resolve => setTimeout(resolve, 0))
                }
                iframe.contentWindow?.postMessage({ type: controller.signal.aborted ? 'FS_READ_FILE_STREAM_ABORTED' : 'FS_READ_FILE_STREAM_END', streamId }, '*')
              } finally { appStreams.delete(streamId); streamState.targets.delete(streamId) }
            }, 0)
          } else if (electronAPI?.fs?.readFileStream) {
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
          if (!streamState.targets.has(options?.streamId)) { response = { success: false, error: 'Stream is not owned by this app' }; break }
          if (isBrowserClient) {
            appStreams.get(options?.streamId)?.abort()
            response = { success: true }
          } else if (electronAPI?.fs?.abortReadFileStream) {
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
            const result = await executeToolAndWait<any>({
              toolName: tool,
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

          const allowedNamespaces = ['fs', 'dialog', 'shell', 'exec', 'http', 'platformInfo']
          if (isBrowserClient) {
            const supported: Record<string, string> = { 'fs.readFile': 'fs.readFile', 'fs.stat': 'fs.stat', 'fs.writeFile': 'fs.writeFile', 'fs.mkdir': 'fs.mkdir', 'exec.run': 'exec.run', 'http.request': 'http.request' }
            const hostMethod = supported[`${namespace}.${method}`]
            if (!hostMethod) { response = { success: false, error: 'Unsupported app RPC method' }; break }
            const values = Array.isArray(args) ? args : []
            const params = namespace === 'fs' ? { filePath: values[0], dirPath: values[0], content: values[1], expectedHash: fileHashes.get(values[0]) }
              : namespace === 'exec' ? { command: values[0], ...values[1] } : values[0] ?? {}
            response = await appClient.call(hostMethod, params, requestId)
            if (response?.hash && params.filePath) fileHashes.set(params.filePath, response.hash)
            break
          }
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
            temperature,
            systemPrompt,
            attachmentsBase64,
            tools,
            cwd,
            rootPath,
          } = options || {}

          if (!prompt) {
            response = { success: false, error: 'Missing prompt' }
            break
          }

          const { provider: resolvedProvider, modelName } = resolveGeneration(model, provider)

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

          const streamLocalHeadless = async (): Promise<GenerationStreamResult> => {

            const effectiveUserId =
              (typeof userId === 'string' && userId.trim()) || context.getUserId() || 'custom-tool-ui'
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

            const streamResponse = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
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
            const generated = await streamLocalHeadless()
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

  const appCleanupFns: Array<() => void> = []
  const context: BridgeContext = { getIframe, getUserId, getToolContext, registerCleanup: cleanup => appCleanupFns.push(cleanup) }
  const flushPendingEvents = createFlushPendingEvents(getIframe, streamState)
  const streamCleanupFns = setupStreamForwarding(getIframe, streamState)
  const handleMessage = createMessageHandler(context, streamState, flushPendingEvents)

  window.addEventListener('message', handleMessage)

  return () => {
    window.removeEventListener('message', handleMessage)
    streamCleanupFns.forEach(cleanup => cleanup?.())
    appCleanupFns.forEach(cleanup => cleanup())
    streamState.targets.clear()
    streamState.pendingEvents.clear()
  }
}
