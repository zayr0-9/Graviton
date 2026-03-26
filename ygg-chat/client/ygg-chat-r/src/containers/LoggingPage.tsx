import React, { useMemo, useState } from 'react'
import {
  Bar as RechartsBar,
  BarChart as RechartsBarChart,
  CartesianGrid as RechartsCartesianGrid,
  Cell as RechartsCell,
  Legend as RechartsLegend,
  Line as RechartsLine,
  LineChart as RechartsLineChart,
  Pie as RechartsPie,
  PieChart as RechartsPieChart,
  ResponsiveContainer as RechartsResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis as RechartsXAxis,
  YAxis as RechartsYAxis,
} from 'recharts'
import { useNavigate } from 'react-router-dom'
import { isCommunityMode } from '../config/runtimeMode'
import { type LoggingFilters, useCloudLoggingAnalytics, useLocalLoggingAnalytics } from '../hooks/useLoggingAnalytics'
import { environment } from '../utils/api'

const RANGE_OPTIONS = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
  { label: 'Last 120 days', value: 120 },
  { label: 'Last 180 days', value: 180 },
  { label: 'Last 365 days', value: 365 },
  { label: 'All', value: 9999 },
] as const

type StorageView = 'cloud' | 'local'

type ToolJobByTool = {
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
}

const Bar = RechartsBar as unknown as React.ComponentType<any>
const BarChart = RechartsBarChart as unknown as React.ComponentType<any>
const CartesianGrid = RechartsCartesianGrid as unknown as React.ComponentType<any>
const Cell = RechartsCell as unknown as React.ComponentType<any>
const Legend = RechartsLegend as unknown as React.ComponentType<any>
const Line = RechartsLine as unknown as React.ComponentType<any>
const LineChart = RechartsLineChart as unknown as React.ComponentType<any>
const Pie = RechartsPie as unknown as React.ComponentType<any>
const PieChart = RechartsPieChart as unknown as React.ComponentType<any>
const ResponsiveContainer = RechartsResponsiveContainer as unknown as React.ComponentType<any>
const Tooltip = RechartsTooltip as unknown as React.ComponentType<any>
const XAxis = RechartsXAxis as unknown as React.ComponentType<any>
const YAxis = RechartsYAxis as unknown as React.ComponentType<any>

const integerFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

const TOOL_STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  failed: '#f43f5e',
  cancelled: '#f59e0b',
  running: '#3b82f6',
  pending: '#a855f7',
}

const formatNumber = (value: number | null | undefined, digits = 2): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}

const formatPercent = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(2)}%`
}

const panelClass =
  'rounded-xl border border-neutral-200/80 dark:border-neutral-700/90 bg-white/95 dark:bg-neutral-900/98 backdrop-blur-2xl text-neutral-900 dark:text-neutral-100 shadow-sm dark:shadow-black/30'

const chartContainerClass = 'h-72 rounded-xl border border-neutral-200/70 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-950/40 p-3'

const LoggingPage: React.FC = () => {
  const navigate = useNavigate()
  const supportsLocal = environment === 'electron'

  const [storageView, setStorageView] = useState<StorageView>(isCommunityMode ? 'local' : 'cloud')
  const [filters, setFilters] = useState<LoggingFilters>({
    rangeDays: 30,
    projectId: null,
    conversationId: null,
    model: null,
    providerRunStatus: null,
    toolName: null,
    toolStatus: null,
  })

  const cloudQuery = useCloudLoggingAnalytics(filters, !isCommunityMode && storageView === 'cloud')
  const localQuery = useLocalLoggingAnalytics(filters, supportsLocal && (isCommunityMode || storageView === 'local'))

  const activeQuery = storageView === 'local' || isCommunityMode ? localQuery : cloudQuery
  const data = activeQuery.data

  const setFilter = <K extends keyof LoggingFilters>(key: K, value: LoggingFilters[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }))
  }

  const cards = useMemo(() => {
    if (!data) return []
    return [
      { label: 'Net Credits Consumed', value: formatNumber(data.summary.netCreditsConsumed) },
      { label: 'Messages', value: integerFormatter.format(data.summary.messagesTotal || 0) },
      {
        label: 'Total Tokens (est.)',
        value:
          typeof data.summary.estimatedTotalTokens === 'number'
            ? integerFormatter.format(data.summary.estimatedTotalTokens)
            : '—',
      },
      { label: 'Conversations', value: integerFormatter.format(data.summary.conversationsCreated || 0) },
      { label: 'Projects', value: integerFormatter.format(data.summary.projectsCreated || 0) },
      { label: 'Active Days', value: integerFormatter.format(data.summary.activeDays || 0) },
      {
        label: 'Avg Credits / Generation',
        value: formatNumber(data.summary.averageCreditsPerGeneration),
      },
      {
        label: 'Avg Credits / Assistant Msg',
        value: formatNumber(data.summary.averageCreditsPerAssistantMessage),
      },
      {
        label: 'Assistant Cost Coverage',
        value: formatPercent(data.dataQuality.assistantMessagesWithCostPct),
      },
    ]
  }, [data])

  const isLoading = activeQuery.isLoading
  const error = activeQuery.error instanceof Error ? activeQuery.error.message : null

  const available = data?.filters.available
  const selectedProject = filters.projectId || ''
  const selectedConversation = filters.conversationId || ''
  const selectedModel = filters.model || ''
  const selectedStatus = filters.providerRunStatus || ''
  const selectedToolName = filters.toolName || ''
  const selectedToolStatus = filters.toolStatus || ''

  const spendRows = (data?.spend.daily || []) as Array<Record<string, unknown>>
  const topModels = (data?.models.topByCredits || []) as Array<Record<string, unknown>>
  const monthlyAllocation = data?.payments.history.monthlyAllocation || []
  const topups = data?.payments.history.topups || []

  const requestedByNameEntries = Object.entries(data?.tools.requested.byName || {})
  const toolJobRows = (((data?.tools.jobs.byTool || []) as ToolJobByTool[]).length > 0
    ? ((data?.tools.jobs.byTool || []) as ToolJobByTool[])
    : requestedByNameEntries.map(([toolName, requested]) => ({
        toolName,
        requested,
        total: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        pending: 0,
        running: 0,
        averageDurationMs: null,
        failureRatePct: 0,
      })))
    .filter(row => row.total > 0 || row.requested > 0)
    .slice(0, 12)

  const toolVolumeChartData = toolJobRows
    .slice()
    .sort((a, b) => Math.max(b.total, b.requested) - Math.max(a.total, a.requested))
    .slice(0, 8)
    .map(row => ({
      toolName: shortenLabel(row.toolName),
      requested: row.requested,
      jobs: row.total,
    }))

  const toolFailureChartData = toolJobRows
    .filter(row => row.total >= 3)
    .slice()
    .sort((a, b) => b.failureRatePct - a.failureRatePct)
    .slice(0, 8)
    .map(row => ({
      toolName: shortenLabel(row.toolName),
      failures: row.failed,
      total: row.total,
      failureRatePct: row.failureRatePct,
    }))

  const toolDurationChartData = toolJobRows
    .filter(row => typeof row.averageDurationMs === 'number')
    .slice()
    .sort((a, b) => (b.averageDurationMs || 0) - (a.averageDurationMs || 0))
    .slice(0, 8)
    .map(row => ({
      toolName: shortenLabel(row.toolName),
      averageDurationMs: Number(row.averageDurationMs || 0),
    }))

  const toolStatusChartData = Object.entries(data?.tools.jobs.statusCounts || {})
    .map(([name, value]) => ({ name, value, color: TOOL_STATUS_COLORS[name] || '#94a3b8' }))
    .filter(item => item.value > 0)

  const toolDailyChartData = (data?.tools.jobs.daily || []).slice(-Math.min(filters.rangeDays, 365))
  const uniqueToolsCount = Math.max(toolJobRows.length, requestedByNameEntries.length)
  const hasToolVolumeData = toolVolumeChartData.length > 0
  const hasToolFailureData = toolFailureChartData.length > 0
  const hasToolDurationData = toolDurationChartData.length > 0
  const hasToolStatusData = toolStatusChartData.length > 0
  const hasToolDailyData = toolDailyChartData.length > 0

  const completedJobs = data?.tools.jobs.statusCounts.completed || 0
  const failedJobs = data?.tools.jobs.statusCounts.failed || 0
  const cancelledJobs = data?.tools.jobs.statusCounts.cancelled || 0
  const terminalJobs = completedJobs + failedJobs + cancelledJobs
  const executionCoveragePct =
    data && data.tools.requested.total > 0 ? (data.tools.jobs.total / data.tools.requested.total) * 100 : null
  const failureRatePct = terminalJobs > 0 ? (failedJobs / terminalJobs) * 100 : null

  const toolSummaryCards = [
    { label: 'Requested Calls', value: integerFormatter.format(data?.tools.requested.total || 0) },
    { label: 'Tracked Jobs', value: integerFormatter.format(data?.tools.jobs.total || 0) },
    { label: 'Execution Coverage', value: formatPercent(executionCoveragePct) },
    { label: 'Failure Rate', value: formatPercent(failureRatePct) },
    { label: 'Completed Jobs', value: integerFormatter.format(completedJobs) },
    { label: 'Avg Duration (ms)', value: formatNumber(data?.tools.jobs.averageDurationMs) },
  ]

  return (
    <div className='h-full overflow-y-auto min-h-full'>
      <div className='max-w-7xl mx-auto px-4 py-8 space-y-6'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h1 className='text-3xl font-bold text-neutral-900 dark:text-neutral-100'>Usage Logging</h1>
            <p className='text-sm text-neutral-600 dark:text-neutral-300'>
              Track spend, model behavior, run health, and activity metrics.
            </p>
          </div>
          <button
            type='button'
            onClick={() => navigate(-1)}
            className='px-4 py-2 rounded-lg bg-neutral-100 text-white dark:bg-neutral-800 dark:text-neutral-100 dark:border dark:border-neutral-700 text-sm font-medium'
          >
            Back
          </button>
        </div>

        <div className={`${panelClass} p-4`}>
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3'>
            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Range</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={filters.rangeDays}
                onChange={e => setFilter('rangeDays', Number(e.target.value))}
              >
                {RANGE_OPTIONS.map(option => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {supportsLocal && (
              <label className='flex flex-col text-xs gap-1'>
                <span className='text-neutral-500 dark:text-neutral-400'>Storage</span>
                <select
                  className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                  value={storageView}
                  onChange={e => setStorageView(e.target.value as StorageView)}
                >
                  {!isCommunityMode && (
                    <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value='cloud'>
                      Cloud
                    </option>
                  )}
                  <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value='local'>
                    Local
                  </option>
                </select>
              </label>
            )}

            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Project</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={selectedProject}
                onChange={e => {
                  const value = e.target.value || null
                  setFilters(prev => ({ ...prev, projectId: value, conversationId: null }))
                }}
              >
                <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value=''>
                  All
                </option>
                {available?.projects.map(project => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={project.id}
                    value={project.id}
                  >
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Conversation</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={selectedConversation}
                onChange={e => setFilter('conversationId', e.target.value || null)}
              >
                <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value=''>
                  All
                </option>
                {available?.conversations.map(conversation => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={conversation.id}
                    value={conversation.id}
                  >
                    {conversation.title || conversation.id}
                  </option>
                ))}
              </select>
            </label>

            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Model</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={selectedModel}
                onChange={e => setFilter('model', e.target.value || null)}
              >
                <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value=''>
                  All
                </option>
                {available?.models.map(model => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={model}
                    value={model}
                  >
                    {model}
                  </option>
                ))}
              </select>
            </label>

            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Run Status</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={selectedStatus}
                onChange={e => setFilter('providerRunStatus', e.target.value || null)}
              >
                <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value=''>
                  All
                </option>
                {(available?.providerRunStatuses || []).map(status => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={status}
                    value={status}
                  >
                    {status}
                  </option>
                ))}
              </select>
            </label>

            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Tool Name</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={selectedToolName}
                onChange={e => setFilter('toolName', e.target.value || null)}
              >
                <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value=''>
                  All
                </option>
                {(available?.toolNames || []).map(toolName => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={toolName}
                    value={toolName}
                  >
                    {toolName}
                  </option>
                ))}
              </select>
            </label>

            <label className='flex flex-col text-xs gap-1'>
              <span className='text-neutral-500 dark:text-neutral-400'>Tool Job Status</span>
              <select
                className='appearance-none px-3 py-2 rounded-xl border border-neutral-300/90 dark:border-neutral-700/90 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-md text-sm text-neutral-900 dark:text-neutral-100 dark:[color-scheme:dark] shadow-sm'
                value={selectedToolStatus}
                onChange={e => setFilter('toolStatus', e.target.value || null)}
              >
                <option className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100' value=''>
                  All
                </option>
                {(available?.toolJobStatuses || []).map(status => (
                  <option
                    className='bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100'
                    key={status}
                    value={status}
                  >
                    {status}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {isLoading && (
          <div className={`${panelClass} p-6 text-sm text-neutral-600 dark:text-neutral-300`}>Loading analytics…</div>
        )}

        {error && (
          <div className='rounded-xl border border-rose-300 dark:border-rose-700 bg-rose-50/80 dark:bg-rose-900/20 p-4 text-sm text-rose-800 dark:text-rose-200'>
            {error}
          </div>
        )}

        {!isLoading && !error && data && (
          <>
            <div className='grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3'>
              {cards.map(card => (
                <div key={card.label} className={`${panelClass} p-4`}>
                  <p className='text-xs text-neutral-500 dark:text-neutral-400'>{card.label}</p>
                  <p className='text-2xl font-semibold text-neutral-900 dark:text-neutral-100 mt-1'>{card.value}</p>
                </div>
              ))}
            </div>

            <div className='grid grid-cols-1 xl:grid-cols-2 gap-4'>
              <section className={`${panelClass} p-4`}>
                <h2 className='text-lg font-semibold text-neutral-900 dark:text-neutral-100'>Spend Timeline</h2>
                <p className='text-xs text-neutral-500 dark:text-neutral-400 mb-3'>
                  Latest {spendRows.length} day buckets
                </p>
                <div className='overflow-auto max-h-80'>
                  <table className='w-full text-xs'>
                    <thead>
                      <tr className='text-left text-neutral-500 dark:text-neutral-300'>
                        <th className='py-1 pr-2'>Date</th>
                        <th className='py-1 pr-2'>Net</th>
                        <th className='py-1 pr-2'>Usage</th>
                        <th className='py-1 pr-2'>Refund</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spendRows.slice(-20).map(row => {
                        const date = String(row.date || 'unknown')
                        const net = Number(row.netCreditsConsumed ?? row.apiCredits ?? 0)
                        const usage = Number(row.apiCredits ?? row.netCreditsConsumed ?? 0)
                        const refund = Number(row.refundCredits ?? 0)
                        return (
                          <tr key={date} className='border-t border-neutral-100 dark:border-neutral-800'>
                            <td className='py-1 pr-2'>{date}</td>
                            <td className='py-1 pr-2'>{formatNumber(net)}</td>
                            <td className='py-1 pr-2'>{formatNumber(usage)}</td>
                            <td className='py-1 pr-2'>{formatNumber(refund)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className={`${panelClass} p-4`}>
                <h2 className='text-lg font-semibold text-neutral-900 dark:text-neutral-100'>Top Models</h2>
                <p className='text-xs text-neutral-500 dark:text-neutral-400 mb-3'>By credits in selected range</p>
                <div className='overflow-auto max-h-80'>
                  <table className='w-full text-xs'>
                    <thead>
                      <tr className='text-left text-neutral-500 dark:text-neutral-400'>
                        <th className='py-1 pr-2'>Model</th>
                        <th className='py-1 pr-2'>Runs</th>
                        <th className='py-1 pr-2'>Total Credits</th>
                        <th className='py-1 pr-2'>Avg Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topModels.slice(0, 15).map(model => (
                        <tr key={String(model.model)} className='border-t border-neutral-100 dark:border-neutral-800'>
                          <td className='py-1 pr-2'>{String(model.model || 'unknown')}</td>
                          <td className='py-1 pr-2'>{integerFormatter.format(Number(model.runs || 0))}</td>
                          <td className='py-1 pr-2'>{formatNumber(Number(model.totalActualCredits || 0))}</td>
                          <td className='py-1 pr-2'>{formatNumber(Number(model.avgActualCredits || 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <div className='grid grid-cols-1 xl:grid-cols-3 gap-4'>
              <section className={`${panelClass} p-4`}>
                <h2 className='text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-3'>Activity</h2>
                <div className='space-y-2'>
                  {Object.entries(data.activity.messagesByRole).map(([role, count]) => (
                    <div key={role} className='flex items-center justify-between text-xs'>
                      <span className='text-neutral-600 dark:text-neutral-300'>{role}</span>
                      <span className='font-medium text-neutral-900 dark:text-neutral-100'>
                        {integerFormatter.format(count)}
                      </span>
                    </div>
                  ))}
                </div>
                <div className='grid grid-cols-3 gap-2 mt-4 text-xs'>
                  <StatMini
                    label='Branch Points'
                    value={integerFormatter.format(data.activity.branching.branchPoints || 0)}
                  />
                  <StatMini label='Avg Depth' value={formatNumber(data.activity.branching.averageDepth)} />
                  <StatMini label='Max Depth' value={integerFormatter.format(data.activity.branching.maxDepth || 0)} />
                </div>
              </section>

              <section className={`${panelClass} p-4 xl:col-span-2`}>
                <div className='flex items-start justify-between gap-3 mb-4'>
                  <div>
                    <h2 className='text-lg font-semibold text-neutral-900 dark:text-neutral-100'>Tools Analytics</h2>
                    <p className='text-xs text-neutral-500 dark:text-neutral-400'>
                      Requested calls, execution reliability, and runtime behavior.
                    </p>
                  </div>
                  <div className='text-right text-xs text-neutral-500 dark:text-neutral-400'>
                    <div>Tracking: {data.tools.jobs.available ? 'Available' : 'Unavailable'}</div>
                    <div>Unique tools: {integerFormatter.format(uniqueToolsCount)}</div>
                  </div>
                </div>

                <div className='grid grid-cols-2 xl:grid-cols-6 gap-3 mb-4'>
                  {toolSummaryCards.map(card => (
                    <div key={card.label} className='rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950/40 p-3'>
                      <p className='text-[11px] text-neutral-500 dark:text-neutral-400'>{card.label}</p>
                      <p className='text-lg font-semibold text-neutral-900 dark:text-neutral-100 mt-1'>{card.value}</p>
                    </div>
                  ))}
                </div>

                <div className='grid grid-cols-1 xl:grid-cols-2 gap-4'>
                  <ChartPanel title='Requested vs Tracked Jobs' subtitle='Highest-volume tools'>
                    <div className={chartContainerClass}>
                      {hasToolVolumeData ? (
                        <ResponsiveContainer width='100%' height='100%'>
                          <BarChart data={toolVolumeChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                            <CartesianGrid strokeDasharray='3 3' stroke='#374151' opacity={0.15} />
                            <XAxis dataKey='toolName' tick={{ fontSize: 12 }} interval={0} angle={-18} textAnchor='end' height={60} />
                            <YAxis tick={{ fontSize: 12 }} />
                            <Tooltip content={<AnalyticsTooltip />} />
                            <Legend />
                            <Bar dataKey='requested' fill='#8b5cf6' radius={[4, 4, 0, 0]} />
                            <Bar dataKey='jobs' fill='#06b6d4' radius={[4, 4, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <ChartEmptyState message='No tool volume data for the selected filters.' />
                      )}
                    </div>
                  </ChartPanel>

                  <ChartPanel title='Failure Rate by Tool' subtitle='Includes tools with at least 3 tracked jobs'>
                    <div className={chartContainerClass}>
                      {hasToolFailureData ? (
                        <ResponsiveContainer width='100%' height='100%'>
                          <BarChart data={toolFailureChartData} layout='vertical' margin={{ top: 8, right: 24, left: 24, bottom: 8 }}>
                            <CartesianGrid strokeDasharray='3 3' stroke='#374151' opacity={0.15} />
                            <XAxis type='number' tick={{ fontSize: 12 }} unit='%' />
                            <YAxis dataKey='toolName' type='category' width={120} tick={{ fontSize: 12 }} />
                            <Tooltip content={<AnalyticsTooltip />} formatter={(value: number) => [`${value.toFixed(2)}%`, 'Failure Rate']} />
                            <Bar dataKey='failureRatePct' radius={[0, 4, 4, 0]}>
                              {toolFailureChartData.map(entry => (
                                <Cell key={entry.toolName} fill={entry.failureRatePct >= 50 ? '#f43f5e' : '#fb7185'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <ChartEmptyState message='Not enough tracked tool job data to compute failure rates yet.' />
                      )}
                    </div>
                  </ChartPanel>

                  <ChartPanel title='Tool Job Trend' subtitle='Daily requested calls vs tracked jobs'>
                    <div className={chartContainerClass}>
                      {hasToolDailyData ? (
                        <ResponsiveContainer width='100%' height='100%'>
                          <LineChart data={toolDailyChartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                            <CartesianGrid strokeDasharray='3 3' stroke='#374151' opacity={0.15} />
                            <XAxis dataKey='date' tick={{ fontSize: 12 }} />
                            <YAxis tick={{ fontSize: 12 }} />
                            <Tooltip content={<AnalyticsTooltip />} />
                            <Legend />
                            <Line type='monotone' dataKey='requested' stroke='#8b5cf6' strokeWidth={2} dot={false} />
                            <Line type='monotone' dataKey='total' stroke='#06b6d4' strokeWidth={2} dot={false} />
                            <Line type='monotone' dataKey='failed' stroke='#f43f5e' strokeWidth={2} dot={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : (
                        <ChartEmptyState message='No daily tracked tool history available from the current analytics source.' />
                      )}
                    </div>
                  </ChartPanel>

                  <ChartPanel title='Job Status Distribution' subtitle='Current range totals'>
                    <div className={chartContainerClass}>
                      {hasToolStatusData ? (
                        <ResponsiveContainer width='100%' height='100%'>
                          <PieChart>
                            <Pie data={toolStatusChartData} dataKey='value' nameKey='name' innerRadius={55} outerRadius={90} paddingAngle={2}>
                              {toolStatusChartData.map(entry => (
                                <Cell key={entry.name} fill={entry.color} />
                              ))}
                            </Pie>
                            <Tooltip content={<AnalyticsTooltip />} />
                            <Legend />
                          </PieChart>
                        </ResponsiveContainer>
                      ) : (
                        <ChartEmptyState message='No tool job status data is available for the selected filters.' />
                      )}
                    </div>
                  </ChartPanel>
                </div>

                <div className='grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4'>
                  <ChartPanel title='Slowest Tools' subtitle='Average tracked runtime'>
                    <div className={chartContainerClass}>
                      {hasToolDurationData ? (
                        <ResponsiveContainer width='100%' height='100%'>
                          <BarChart data={toolDurationChartData} layout='vertical' margin={{ top: 8, right: 24, left: 24, bottom: 8 }}>
                            <CartesianGrid strokeDasharray='3 3' stroke='#374151' opacity={0.15} />
                            <XAxis type='number' tick={{ fontSize: 12 }} />
                            <YAxis dataKey='toolName' type='category' width={120} tick={{ fontSize: 12 }} />
                            <Tooltip content={<AnalyticsTooltip />} formatter={(value: number) => [formatNumber(value), 'Avg Duration (ms)']} />
                            <Bar dataKey='averageDurationMs' fill='#f59e0b' radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      ) : (
                        <ChartEmptyState message='No tracked tool runtime data is available yet.' />
                      )}
                    </div>
                  </ChartPanel>

                  <section className='rounded-xl border border-neutral-200/70 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-950/30 p-4'>
                    <h3 className='text-sm font-semibold text-neutral-900 dark:text-neutral-100'>Per-tool breakdown</h3>
                    <p className='text-xs text-neutral-500 dark:text-neutral-400 mb-3'>
                      Requested calls, tracked jobs, failures, and average runtime.
                    </p>
                    <div className='overflow-auto max-h-80'>
                      <table className='w-full text-xs'>
                        <thead>
                          <tr className='text-left text-neutral-500 dark:text-neutral-400'>
                            <th className='py-1.5 pr-2'>Tool</th>
                            <th className='py-1.5 pr-2'>Requested</th>
                            <th className='py-1.5 pr-2'>Jobs</th>
                            <th className='py-1.5 pr-2'>Failed</th>
                            <th className='py-1.5 pr-2'>Failure %</th>
                            <th className='py-1.5 pr-2'>Avg ms</th>
                          </tr>
                        </thead>
                        <tbody>
                          {toolJobRows.map(row => (
                            <tr key={row.toolName} className='border-t border-neutral-100 dark:border-neutral-800'>
                              <td className='py-1.5 pr-2 max-w-52 truncate'>{row.toolName}</td>
                              <td className='py-1.5 pr-2'>{integerFormatter.format(row.requested)}</td>
                              <td className='py-1.5 pr-2'>{integerFormatter.format(row.total)}</td>
                              <td className='py-1.5 pr-2'>{integerFormatter.format(row.failed)}</td>
                              <td className='py-1.5 pr-2'>{formatPercent(row.failureRatePct)}</td>
                              <td className='py-1.5 pr-2'>{formatNumber(row.averageDurationMs)}</td>
                            </tr>
                          ))}
                          {toolJobRows.length === 0 && (
                            <tr>
                              <td colSpan={6} className='py-6 text-center text-neutral-500 dark:text-neutral-400'>
                                No tool analytics for the selected filters.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </section>
            </div>

            <div className='grid grid-cols-1 xl:grid-cols-2 gap-4'>
              <section className={`${panelClass} p-4`}>
                <h2 className='text-lg font-semibold text-neutral-900 dark:text-neutral-100'>Subscription & Balance</h2>
                <div className='mt-3 text-xs space-y-2'>
                  <div className='flex justify-between'>
                    <span className='text-neutral-600 dark:text-neutral-300'>Current Plan</span>
                    <span className='font-medium'>
                      {data.payments.currentPlan?.planName || data.payments.currentPlan?.planCode || '—'}
                    </span>
                  </div>
                  <div className='flex justify-between'>
                    <span className='text-neutral-600 dark:text-neutral-300'>Subscription Status</span>
                    <span className='font-medium'>{data.payments.currentPlan?.subscriptionStatus || '—'}</span>
                  </div>
                  <div className='flex justify-between'>
                    <span className='text-neutral-600 dark:text-neutral-300'>Current Balance</span>
                    <span className='font-medium'>{formatNumber(data.payments.currentCreditsBalance)}</span>
                  </div>
                  <div className='flex justify-between'>
                    <span className='text-neutral-600 dark:text-neutral-300'>Burn Rate (credits/day)</span>
                    <span className='font-medium'>{formatNumber(data.spend.burnRate.creditsPerDay)}</span>
                  </div>
                  <div className='flex justify-between'>
                    <span className='text-neutral-600 dark:text-neutral-300'>Projected Days Remaining</span>
                    <span className='font-medium'>{formatNumber(data.spend.burnRate.projectedDaysRemaining)}</span>
                  </div>
                </div>
              </section>

              <section className={`${panelClass} p-4`}>
                <h2 className='text-lg font-semibold text-neutral-900 dark:text-neutral-100'>Allocation / Topups</h2>
                <div className='grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 text-xs'>
                  <div>
                    <p className='font-medium mb-1 text-neutral-700 dark:text-neutral-200'>Monthly Allocation</p>
                    <div className='space-y-1 max-h-28 overflow-auto'>
                      {monthlyAllocation.length === 0 && (
                        <p className='text-neutral-500 dark:text-neutral-400'>No data</p>
                      )}
                      {monthlyAllocation.slice(0, 8).map((item: any) => (
                        <div key={String(item.id)} className='flex justify-between'>
                          <span>{String(item.created_at || '').slice(0, 10)}</span>
                          <span>{formatNumber(Number(item.credits || 0))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className='font-medium mb-1 text-neutral-700 dark:text-neutral-200'>Topups</p>
                    <div className='space-y-1 max-h-28 overflow-auto'>
                      {topups.length === 0 && <p className='text-neutral-500 dark:text-neutral-400'>No data</p>}
                      {topups.slice(0, 8).map((item: any) => (
                        <div key={String(item.id)} className='flex justify-between'>
                          <span>{String(item.created_at || '').slice(0, 10)}</span>
                          <span>{formatNumber(Number(item.credits || 0))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const ChartPanel = ({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) => (
  <section>
    <div className='mb-2'>
      <h3 className='text-sm font-semibold text-neutral-900 dark:text-neutral-100'>{title}</h3>
      {subtitle && <p className='text-xs text-neutral-500 dark:text-neutral-400'>{subtitle}</p>}
    </div>
    {children}
  </section>
)

const ChartEmptyState = ({ message }: { message: string }) => (
  <div className='h-full w-full flex items-center justify-center text-center px-6 text-sm text-neutral-500 dark:text-neutral-400'>
    {message}
  </div>
)

const AnalyticsTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || payload.length === 0) return null

  return (
    <div className='rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 shadow-lg px-3 py-2 text-xs'>
      {label ? <div className='font-medium mb-1 text-neutral-900 dark:text-neutral-100'>{label}</div> : null}
      <div className='space-y-1'>
        {payload.map((entry: any) => (
          <div key={entry.dataKey || entry.name} className='flex items-center justify-between gap-3'>
            <span className='text-neutral-600 dark:text-neutral-300'>{entry.name || entry.dataKey}</span>
            <span className='font-medium text-neutral-900 dark:text-neutral-100'>
              {typeof entry.value === 'number' ? formatNumber(entry.value) : String(entry.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

const shortenLabel = (value: string, max = 20) => {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

const StatMini = ({ label, value }: { label: string; value: string }) => {
  return (
    <div className='rounded-md border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/90 backdrop-blur-md p-2'>
      <p className='text-[10px] text-neutral-500 dark:text-neutral-400'>{label}</p>
      <p className='text-xs font-medium text-neutral-900 dark:text-neutral-100'>{value}</p>
    </div>
  )
}

export default LoggingPage
