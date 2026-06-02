import { createZaiStreamingRequest, type ZaiRequestPayload, type ZaiStreamHandlers } from './Zai'

export type BedrockRequestPayload = ZaiRequestPayload
export type BedrockStreamHandlers = ZaiStreamHandlers

export async function createBedrockStreamingRequest(payload: BedrockRequestPayload, handlers: BedrockStreamHandlers) {
  return createZaiStreamingRequest({ ...payload, provider: 'bedrock' } as BedrockRequestPayload & { provider: 'bedrock' }, handlers)
}
