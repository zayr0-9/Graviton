import { parseMessageMeta } from './contextInjection.js'
import { extractOpenAIContextUsageFromBlocks, openAIContextUsageBlock } from './contextUsage.js'

/** Preserve server-local provenance when a cloud response has no operational metadata. */
export function mergeLocalRunMetadata(remote: unknown, local: unknown): Record<string, unknown> | null {
  const cloud = parseMessageMeta(remote)
  const durable = parseMessageMeta(local)?.runStatistics
  return durable ? { ...cloud, runStatistics: durable } : cloud
}

export function mergeLocalUsageBlocks(remote: unknown, local: unknown): unknown {
  const usage = extractOpenAIContextUsageFromBlocks(local)
  if (!usage || extractOpenAIContextUsageFromBlocks(remote)) return remote
  let blocks = remote
  if (typeof blocks === 'string') {
    try { blocks = JSON.parse(blocks) } catch { return remote }
  }
  // Do not introduce a usage-only block list that would suppress legacy prose.
  return Array.isArray(blocks) && blocks.length ? [...blocks, openAIContextUsageBlock(usage)] : remote
}
