import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAuth } from './useAuth'
import { isCloudSession } from '../config/runtimeMode'
import { api, environment, localApi } from '../utils/api'

export interface LoggingFilters {
  rangeDays: number
  projectId?: string | null
  conversationId?: string | null
  model?: string | null
  providerRunStatus?: string | null
  toolName?: string | null
  toolStatus?: string | null
}

export interface LoggingDashboardResponse {
  rangeDays: number
  source?: 'cloud' | 'local'
  filters: {
    applied: Record<string, unknown>
    available: {
      models: string[]
      providerRunStatuses: string[]
      toolNames: string[]
      toolJobStatuses?: string[]
      projects: Array<{ id: string; name: string; storage_mode?: 'cloud' | 'local' | null }>
      conversations: Array<{
        id: string
        title: string | null
        project_id: string | null
        storage_mode?: 'cloud' | 'local' | null
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
  payments: {
    currentPlan: {
      subscriptionStatus: string
      currentPeriodEnd: string | null
      cancelAtPeriodEnd: boolean | null
      planCode: string | null
      planName: string | null
    } | null
    history: {
      monthlyAllocation: Array<Record<string, unknown>>
      topups: Array<Record<string, unknown>>
    }
    currentCreditsBalance: number | null
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

  return params.toString()
}

export const useCloudLoggingAnalytics = (filters: LoggingFilters, enabled: boolean = true) => {
  const { accessToken, userId } = useAuth()
  const queryString = useMemo(() => buildQueryString(filters), [filters])
  const cloudSession = isCloudSession({ accessToken, userId })

  return useQuery({
    queryKey: ['logging-analytics', 'cloud', queryString],
    queryFn: () => api.get<LoggingDashboardResponse>(`/analytics/dashboard?${queryString}`, accessToken),
    enabled: enabled && cloudSession,
    staleTime: 30 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}

export const useLocalLoggingAnalytics = (filters: LoggingFilters, enabled: boolean = true) => {
  const queryString = useMemo(() => buildQueryString(filters), [filters])

  return useQuery({
    queryKey: ['logging-analytics', 'local', queryString],
    queryFn: () => localApi.get<LoggingDashboardResponse>(`/local/analytics/dashboard?${queryString}`),
    enabled: enabled && environment === 'electron',
    staleTime: 15 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })
}
