import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { isHostClient } from '../platform/clientCapabilities'
import { localApi } from '../utils/api'

export interface LoggingFilters {
  rangeDays: number
  projectId?: string | null
  conversationId?: string | null
  model?: string | null
  providerRunStatus?: string | null
  toolName?: string | null
  toolStatus?: string | null
  runStatus?: string | null
}

export interface OutcomeMetrics {
  total: number
  statusCounts: Record<string, number>
  terminalTotal: number
  failureRatePct: number | null
  duration: { samples: number; averageMs: number | null; p50Ms: number | null; p90Ms: number | null }
}

export interface LoggingDashboardResponse {
  generatedAt?: string
  availability?: { costs: boolean; jobs: boolean; runs: boolean; executions: boolean }
  costRecords?: number
  localRuns?: OutcomeMetrics & { available: boolean; main: OutcomeMetrics; subagents: OutcomeMetrics }
  executions?: {
    available: boolean
    root: OutcomeMetrics
    nested: OutcomeMetrics
    byTool: Array<OutcomeMetrics & { toolName: string; rootTotal: number; nestedTotal: number }>
    daily: Array<{ date: string; root: number; nested: number; failed: number }>
  }
  reportedUsage?: {
    samples: number; duplicateSamples: number; unidentifiedSamples: number
    inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number; totalTokens: number
    cachedInputPct: number | null; assistantMessages: number; messagesWithUsage: number
  }
  rangeDays: number
  filters: {
    applied: Record<string, unknown>
    available: {
      models: string[]
      providerRunStatuses: string[]
      toolNames: string[]
      toolJobStatuses?: string[]
      runStatuses?: string[]
      projects: Array<{ id: string; name: string }>
      conversations: Array<{
        id: string
        title: string | null
        project_id: string | null
      }>
    }
  }
  summary: {
    netCreditsConsumed: number
    totalReservedCredits: number
    totalRefundCredits: number
    totalAdjustmentCredits: number
    averageCreditsPerGeneration: number
    averageCreditsPerAssistantMessage: number
    messagesTotal: number
    conversationsCreated: number
    projectsCreated: number
    activeDays: number
    estimatedTotalTokens?: number
    activeConversations?: number
    activeProjects?: number
  }
  spend: {
    totals?: {
      approxCostUsd: number
      apiCredits: number
      promptTokens: number
      completionTokens: number
      reasoningTokens: number
    }
    daily: Array<Record<string, unknown>>
    balanceTrend: Array<{ date: string; credits: number }>
    burnRate: {
      creditsPerDay: number
      projectedDaysRemaining: number | null
    }
  }
  models: {
    topByCredits: Array<Record<string, unknown>>
    tokenMixByModel: Array<Record<string, unknown>>
  }
  providerRuns: {
    statusCounts: Record<string, number>
    quality: {
      total: number
      withGenerationIdPct: number
      withMessageLinkPct: number
      withConversationLinkPct: number
      reconciledPct: number
      lastReconciledAt: string | null
    }
    reconcileLagMinutes: {
      avg: number
      p50: number
      p90: number
      max: number
    }
  }
  activity: {
    messagesByRole: Record<string, number>
    messagesPerDay: Array<{ date: string; count: number }>
    branching: {
      branchPoints: number
      averageDepth: number
      maxDepth: number
    }
  }
  tools: {
    requested: {
      total: number
      byName: Record<string, number>
    }
    batching?: {
      batchedCalls: number
      unbatchedEquivalentCalls: number
      savedCalls: number
      savedCallsPct: number
      cachePrefixSavingsFactorPct: number
      byBatchTool: Array<{
        toolName: string
        batches: number
        expandedCalls: number
        savedCalls: number
      }>
      daily: Array<{
        date: string
        batchedCalls: number
        unbatchedEquivalentCalls: number
        savedCalls: number
      }>
    }
    jobs: {
      available: boolean
      statusCounts: Record<string, number>
      total: number
      topFailing: Array<{ toolName: string; failures: number }>
      averageDurationMs: number | null
      byTool: Array<{
        toolName: string
        requested: number
        total: number
        completed: number
        failed: number
        cancelled: number
        pending: number
        running: number
        averageDurationMs: number | null
        failureRatePct: number
      }>
      daily: Array<{
        date: string
        requested: number
        total: number
        completed: number
        failed: number
        cancelled: number
      }>
    }
  }
  dataQuality: {
    assistantMessagesWithCostPct: number
    assistantMessagesTotal: number
    assistantMessagesWithCost: number
  }
}

const buildQueryString = (filters: LoggingFilters): string => {
  const params = new URLSearchParams()
  params.set('rangeDays', String(filters.rangeDays))

  if (filters.projectId) params.set('projectId', filters.projectId)
  if (filters.conversationId) params.set('conversationId', filters.conversationId)
  if (filters.model) params.set('model', filters.model)
  if (filters.providerRunStatus) params.set('providerRunStatus', filters.providerRunStatus)
  if (filters.toolName) params.set('toolName', filters.toolName)
  if (filters.toolStatus) params.set('toolStatus', filters.toolStatus)
  if (filters.runStatus) params.set('runStatus', filters.runStatus)

  return params.toString()
}

export const useLocalLoggingAnalytics = (filters: LoggingFilters, enabled: boolean = true) => {
  const queryString = useMemo(() => buildQueryString(filters), [filters])

  return useQuery({
    queryKey: ['logging-analytics', 'local', queryString],
    queryFn: () => localApi.get<LoggingDashboardResponse>(`/local/analytics/dashboard?${queryString}`),
    enabled: enabled && isHostClient,
    staleTime: 15 * 1000,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}
