import React, { createContext, useContext, useState } from 'react'
import { ArrowLeft, RefreshCw, SlidersHorizontal, Activity, Database, Cloud, ChevronDown } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'
import { BarChart as RechartsBarChart, Bar as RechartsBar, LineChart as RechartsLineChart, Line as RechartsLine,
  XAxis as RechartsXAxis, YAxis as RechartsYAxis, CartesianGrid as RechartsCartesianGrid,
  ResponsiveContainer as RechartsResponsiveContainer, Tooltip as RechartsTooltip, Legend as RechartsLegend } from 'recharts'
import { useNavigate } from 'react-router-dom'
import { useCustomChatTheme, useHtmlDarkMode, getThemeModeColor, type CustomChatTheme } from '../components/ThemeManager/themeConfig'
import { isCommunityMode } from '../config/runtimeMode'
import { useCloudLoggingAnalytics, useLocalLoggingAnalytics, type LoggingFilters,
  type LoggingDashboardResponse, type OutcomeMetrics } from '../hooks/useLoggingAnalytics'
import { formatMetric, formatPercent, formatDuration, rankTools, shortenLabel, toolJobRows,
  uniqueToolCount, usageHeadline, activityTimeline } from '../utils/loggingAnalytics'

// Recharts 2's React 18 JSX types need the same React 19 bridge as the original page.
const BarChart = RechartsBarChart as unknown as React.ComponentType<any>
const Bar = RechartsBar as unknown as React.ComponentType<any>
const LineChart = RechartsLineChart as unknown as React.ComponentType<any>
const Line = RechartsLine as unknown as React.ComponentType<any>
const XAxis = RechartsXAxis as unknown as React.ComponentType<any>
const YAxis = RechartsYAxis as unknown as React.ComponentType<any>
const CartesianGrid = RechartsCartesianGrid as unknown as React.ComponentType<any>
const ResponsiveContainer = RechartsResponsiveContainer as unknown as React.ComponentType<any>
const Tooltip = RechartsTooltip as unknown as React.ComponentType<any>
const Legend = RechartsLegend as unknown as React.ComponentType<any>

type Colors = CustomChatTheme['colors']
type ColorKey = { [K in keyof Colors]: Colors[K] extends { light: string; dark: string } ? K : never }[keyof Colors]
type Tone = { page?: string; panel?: string; inner?: string; text?: string; muted?: string; button?: string;
  buttonText?: string; active?: string; activeText?: string; error?: string; errorText?: string;
  accent: string; secondary: string; failed: string; completed: string; running: string; mutedChart: string }
const ToneContext = createContext<Tone>({ accent: '#8b5cf6', secondary: '#0891b2', failed: '#e11d48',
  completed: '#16a34a', running: '#2563eb', mutedChart: '#737373' })
const useTone = () => useContext(ToneContext)
const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70'
const actionClass = `flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/70 text-neutral-700 dark:bg-black/20 dark:text-neutral-200 hover:opacity-80 motion-safe:active:scale-95 transition-[color,background-color,opacity,transform] duration-[var(--ygg-motion-duration-fast)] ${focusClass}`
const initialFilters: LoggingFilters = { rangeDays: 30, projectId: null, conversationId: null, model: null,
  providerRunStatus: null, toolName: null, toolStatus: null, runStatus: null }
const sections = ['Overview', 'Models & tokens', 'Runs & tools', 'Data quality'] as const
const ranges = [7, 30, 90, 120, 180, 365]

export default function LoggingDashboard() {
  const navigate = useNavigate()
  const { theme, enabled } = useCustomChatTheme()
  const dark = useHtmlDarkMode()
  const color = (key: ColorKey) => enabled ? getThemeModeColor(theme.colors[key], dark) : undefined
  const tone: Tone = { page: color('settingsPaneBodyBg'), panel: color('settingsCustomThemesCardBg'),
    inner: color('settingsCustomThemesInnerCardBg'), text: color('toolJobsPrimaryText'), muted: color('toolJobsMutedText'),
    button: color('settingsCustomThemesButtonBg'), buttonText: color('settingsCustomThemesButtonText'),
    active: color('composerToggleActiveBg'), activeText: color('composerToggleActiveText'),
    error: color('toolJobsErrorBg'), errorText: color('toolJobsErrorText'),
    accent: color('settingsCustomThemesAccentText') || (dark ? '#a78bfa' : '#7c3aed'),
    secondary: color('toolJobsProgressRunning') || '#0891b2', failed: color('toolJobsProgressFailed') || '#e11d48',
    completed: color('toolJobsProgressCompleted') || '#16a34a', running: color('toolJobsProgressRunning') || '#2563eb',
    mutedChart: color('toolJobsMutedText') || (dark ? '#a3a3a3' : '#737373') }
  const [source, setSource] = useState<'cloud' | 'local'>(isCommunityMode ? 'local' : 'cloud')
  const [filters, setFilters] = useState<LoggingFilters>(initialFilters)
  const [section, setSection] = useState<(typeof sections)[number]>('Overview')
  const cloud = useCloudLoggingAnalytics(filters, !isCommunityMode && source === 'cloud')
  const local = useLocalLoggingAnalytics(filters, source === 'local')
  const query = source === 'local' ? local : cloud
  // Disabled cloud queries must not reveal cached account data after sign-out.
  const data = source === 'cloud' && !query.isEnabled ? undefined : query.data
  const available = data?.filters.available
  const fetching = query.isFetching
  const hasFilters = Object.entries(filters).some(([key, value]) => key !== 'rangeDays' && Boolean(value))
  const setFilter = (key: keyof LoggingFilters, value: string) => setFilters(prev => ({ ...prev, [key]: value || null,
    ...(key === 'projectId' ? { conversationId: null } : {}) }))
  const optionRows = (values: string[] = []) => values.map(value => ({ value, label: value }))
  const error = query.error instanceof Error ? query.error.message : query.error ? 'Unable to load analytics.' : null
  const updatedAt = data?.generatedAt ? Date.parse(data.generatedAt) : query.dataUpdatedAt

  return <ToneContext.Provider value={tone}>
    <main className='h-full overflow-y-auto bg-neutral-50/60 text-neutral-900 dark:bg-yBlack-900/60 dark:text-neutral-100'
      style={{ backgroundColor: tone.page, color: tone.text }} aria-busy={fetching}>
      <div className='mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-8'>
        <header className='flex flex-wrap items-center justify-between gap-4'>
          <div className='flex items-center gap-4'>
            <button type='button' className={actionClass} style={{ backgroundColor: tone.button, color: tone.buttonText }}
              title='Back' aria-label='Back' onClick={() => navigate(-1)}><ArrowLeft size={18} strokeWidth={2.25} /></button>
            <div>
              <Muted className='mb-1 flex items-center gap-2 text-xs uppercase tracking-widest'>
                <Activity size={14} /> Analytics workspace
              </Muted>
              <h1 className='text-3xl font-semibold tracking-tight'>Usage & reliability</h1>
              <Muted className='mt-1 text-sm'>Understand your activity, recorded costs, and execution health.</Muted>
            </div>
          </div>
          <div className='flex items-center gap-3'>
            <div className='text-right'>
              <Badge>{source === 'local' ? <Database size={13} /> : <Cloud size={13} />} {source === 'local' ? 'Local SQLite' : 'Cloud analytics'}</Badge>
              <Muted className='mt-1 text-xs'>
                {updatedAt > 0 ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not loaded yet'}
              </Muted>
            </div>
            <button type='button' className={`${actionClass} disabled:opacity-40`} style={{ backgroundColor: tone.button, color: tone.buttonText }}
              title='Refresh analytics' aria-label='Refresh analytics' disabled={fetching || !query.isEnabled}
              onClick={() => void query.refetch()}><RefreshCw size={18} strokeWidth={2.25} /></button>
          </div>
        </header>

        <Panel>
          <div className='grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6'>
            <Filter label='Period' value={String(filters.rangeDays)} onChange={value => setFilters(prev => ({ ...prev, rangeDays: Number(value) }))}
              options={ranges.map(value => ({ value: String(value), label: `Last ${value} days` }))} all={false} />
            <Filter label='Source' value={source} all={false} disabled={isCommunityMode}
              options={isCommunityMode ? [{ value: 'local', label: 'Local SQLite' }] : [{ value: 'cloud', label: 'Cloud' }, { value: 'local', label: 'Local SQLite' }]}
              onChange={value => { setSource(value as 'cloud' | 'local'); setFilters(prev => ({ ...initialFilters, rangeDays: prev.rangeDays })) }} />
            <Filter label='Project' value={filters.projectId} onChange={value => setFilter('projectId', value)}
              options={available?.projects.map(row => ({ value: row.id, label: row.name }))} />
            <Filter label='Conversation' value={filters.conversationId} onChange={value => setFilter('conversationId', value)}
              options={available?.conversations.map(row => ({ value: row.id, label: row.title || row.id }))} />
            <Filter label='Model' value={filters.model} onChange={value => setFilter('model', value)} options={optionRows(available?.models)} />
            <div className='flex items-end'>
              <button type='button' disabled={!hasFilters} className={`min-h-11 rounded-full px-4 text-sm hover:opacity-80 disabled:opacity-40 ${focusClass}`}
                style={{ backgroundColor: tone.button, color: tone.buttonText }}
                onClick={() => setFilters(prev => ({ ...initialFilters, rangeDays: prev.rangeDays }))}>Clear filters</button>
            </div>
          </div>
          <details className='mt-4'>
            <summary className={`flex w-fit cursor-pointer list-none items-center gap-2 rounded-full px-2 py-2 text-sm ${focusClass}`}>
              <SlidersHorizontal size={16} /> Execution filters <ChevronDown size={14} />
            </summary>
            <div className='mt-3 grid gap-3 sm:grid-cols-3'>
              <Filter label={source === 'local' ? 'Chat run status' : 'Provider run status'}
                value={source === 'local' ? filters.runStatus : filters.providerRunStatus}
                disabled={source === 'local' && data?.localRuns?.available !== true}
                onChange={value => setFilter(source === 'local' ? 'runStatus' : 'providerRunStatus', value)}
                options={optionRows(source === 'local' ? available?.runStatuses : available?.providerRunStatuses)} />
              <Filter label='Tool name' value={filters.toolName} onChange={value => setFilter('toolName', value)} options={optionRows(available?.toolNames)} />
              <Filter label='Execution / job status' value={filters.toolStatus} onChange={value => setFilter('toolStatus', value)} options={optionRows(available?.toolJobStatuses)} />
            </div>
            <Muted className='mt-3 text-xs leading-relaxed'>Run status filters chat runs only. Tool status filters tracked executions and background jobs, not requested calls.
              {source === 'local' && ' Background jobs have no model ownership and do not follow the model filter.'}</Muted>
          </details>
        </Panel>

        <nav aria-label='Analytics sections' className='flex flex-wrap gap-1 rounded-3xl bg-white/30 p-1.5 backdrop-blur-xl dark:bg-black/10'
          style={{ backgroundColor: tone.inner }}>
          {sections.map(item => <button key={item} type='button' aria-pressed={section === item} onClick={() => setSection(item)}
            className={`min-h-11 rounded-full px-5 text-sm font-medium transition-[background-color,color] duration-[var(--ygg-motion-duration-fast)] ${focusClass} ${section === item ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100' : 'hover:bg-white/40 dark:hover:bg-white/5'}`}
            style={section === item ? { backgroundColor: tone.active, color: tone.activeText } : { color: tone.muted }}>{item}</button>)}
        </nav>
        <div role='status' aria-live='polite' className='min-h-4 text-xs' style={{ color: tone.muted }}>
          {fetching ? data ? 'Refreshing analytics…' : 'Loading analytics…' : `Last ${data?.rangeDays || filters.rangeDays} days · UTC day buckets`}
        </div>
        {error && <div role='alert' className='flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 dark:bg-rose-950/30 dark:text-rose-200'
          style={{ backgroundColor: tone.error, color: tone.errorText }}><span>{error}</span>
          <button type='button' className={`rounded-full px-4 py-2 ${focusClass}`} onClick={() => void query.refetch()} disabled={fetching || !query.isEnabled}>Retry</button></div>}
        {!data && !fetching && !error && <Panel><Empty message={source === 'cloud' ? 'Sign in to load cloud analytics, or select Local SQLite.' : 'Analytics are not available yet.'} /></Panel>}
        {data && <>
          {data.summary.messagesTotal === 0 && (data.costRecords ?? data.models.topByCredits.length) === 0 &&
            (data.localRuns?.total || 0) === 0 && (data.executions?.root.total || 0) === 0 && data.tools.jobs.total === 0 &&
            <Panel><Empty message='No activity matches this period and scope. Try another period or clear the filters.' /></Panel>}
          {section === 'Overview' && <Overview data={data} local={source === 'local'} />}
          {section === 'Models & tokens' && <Models data={data} />}
          {section === 'Runs & tools' && <RunsAndTools data={data} />}
          {section === 'Data quality' && <Quality data={data} local={source === 'local'} />}
        </>}
      </div>
    </main>
  </ToneContext.Provider>
}

function Muted({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const tone = useTone()
  return <div className={`text-neutral-500 dark:text-neutral-400 ${className}`} style={{ color: tone.muted }}>{children}</div>
}
function Badge({ children }: { children: React.ReactNode }) {
  const tone = useTone()
  return <span className='inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1 text-xs dark:bg-white/5'
    style={{ backgroundColor: tone.inner, color: tone.muted }}>{children}</span>
}
function Panel({ children, title, subtitle, className = '' }: { children: React.ReactNode; title?: string; subtitle?: string; className?: string }) {
  const tone = useTone()
  return <section className={`min-w-0 rounded-3xl bg-white/60 p-5 backdrop-blur-xl dark:bg-black/15 sm:p-6 ${className}`}
    style={{ backgroundColor: tone.panel, color: tone.text }}>
    {title && <div className='mb-5'><h2 className='text-base font-semibold'>{title}</h2>{subtitle && <Muted className='mt-1 text-xs leading-relaxed'>{subtitle}</Muted>}</div>}
    {children}
  </section>
}
function Empty({ message }: { message: string }) {
  return <Muted className='flex min-h-32 items-center justify-center px-4 text-center text-sm leading-relaxed'>{message}</Muted>
}
function Filter({ label, value, options = [], onChange, all = true, disabled = false }: { label: string; value?: string | null;
  options?: Array<{ value: string; label: string }>; onChange: (value: string) => void; all?: boolean; disabled?: boolean }) {
  const tone = useTone()
  const retained = value && !options.some(row => row.value === value) ? [{ value, label: value }, ...options] : options
  return <label className='flex min-w-0 flex-col gap-2 text-xs'>
    <span style={{ color: tone.muted }}>{label}</span>
    <select value={value || ''} disabled={disabled} onChange={event => onChange(event.target.value)}
      className={`min-h-11 w-full rounded-2xl bg-neutral-100/70 px-3 pr-6 text-sm text-neutral-900 disabled:opacity-40 dark:bg-black/20 dark:text-neutral-100 dark:[color-scheme:dark] ${focusClass}`}
      style={{ backgroundColor: tone.inner, color: tone.text }}>
      {all && <option value='' style={{ backgroundColor: tone.panel, color: tone.text }}>All</option>}
      {retained.map(row => <option key={row.value} value={row.value} style={{ backgroundColor: tone.panel, color: tone.text }}>{row.label}</option>)}
    </select>
  </label>
}
function Metrics({ items }: { items: Array<{ label: string; value: string; detail?: string }> }) {
  const tone = useTone()
  return <div className='grid grid-cols-2 gap-3 xl:grid-cols-4'>
    {items.map(item => <div key={item.label} className='min-w-0 rounded-2xl bg-white/50 p-4 dark:bg-black/15'
      style={{ backgroundColor: tone.inner }}>
      <Muted className='text-xs'>{item.label}</Muted>
      <div className='my-2 break-words text-2xl font-semibold tracking-tight tabular-nums'>{item.value}</div>
      {item.detail && <Muted className='text-xs leading-relaxed'>{item.detail}</Muted>}
    </div>)}
  </div>
}
function DataTable({ headers, rows, empty = 'No records match this scope.' }: { headers: string[]; rows: React.ReactNode[][]; empty?: string }) {
  const tone = useTone()
  return <div className='max-h-96 overflow-auto rounded-2xl'>
    <table className='w-full text-sm tabular-nums'>
      <thead className='sticky top-0 bg-neutral-100/95 backdrop-blur-xl dark:bg-neutral-900/95' style={{ backgroundColor: tone.inner, color: tone.muted }}>
        <tr>{headers.map((header, index) => <th scope='col' key={header} className={`whitespace-nowrap px-3 py-3 text-xs font-medium ${index ? 'text-right' : 'text-left'}`}>{header}</th>)}</tr>
      </thead>
      <tbody>{rows.map((row, index) => <tr key={index} className='odd:bg-neutral-500/[0.035]'>
        {row.map((cell, column) => <td key={column} className={`px-3 py-3 ${column ? 'whitespace-nowrap text-right' : 'min-w-40 break-words'}`}>{cell}</td>)}
      </tr>)}
      {!rows.length && <tr><td colSpan={headers.length}><Empty message={empty} /></td></tr>}</tbody>
    </table>
  </div>
}

function Overview({ data, local }: { data: LoggingDashboardResponse; local: boolean }) {
  const tokens = usageHeadline(data)
  const costAvailable = data.availability?.costs !== false
  return <div className='space-y-5'>
    <Metrics items={[
      { label: 'Recorded credits', value: formatMetric(costAvailable ? data.summary.netCreditsConsumed : null), detail: 'Cost records · not a balance statement' },
      { label: tokens.label, value: formatMetric(tokens.value, 0), detail: tokens.detail },
      { label: 'Messages', value: formatMetric(data.summary.messagesTotal, 0), detail: `${formatMetric(data.summary.activeDays, 0)} active days` },
      { label: 'Completed chat runs', value: formatMetric(data.localRuns?.available ? data.localRuns.statusCounts.completed || 0 : null, 0), detail: 'Persisted main + subagent + tool streams' },
    ]} />
    <div className='grid gap-5 xl:grid-cols-2'>
      <Panel title='Spend over time' subtitle='Recorded credits per UTC day. Missing days have no recorded cost samples.'>
        <Chart rows={data.spend.daily} x='date' series={[{ key: local ? 'apiCredits' : 'netCreditsConsumed', label: 'Credits', color: 'accent' }]} kind='line' />
      </Panel>
      <Panel title='Conversation activity' subtitle='Stored messages per UTC day in the selected project, conversation, and model scope.'>
        <Chart rows={activityTimeline(data)} x='date' series={[{ key: 'messages', label: 'Messages', color: 'secondary' }]} kind='bar' />
      </Panel>
    </div>
    <Panel title='Activity at a glance' subtitle='Creation counts are separate from entities with messages in this period.'>
      <Metrics items={[
        { label: 'Active conversations', value: formatMetric(data.summary.activeConversations, 0), detail: `${formatMetric(data.summary.conversationsCreated, 0)} created in range` },
        { label: 'Active projects', value: formatMetric(data.summary.activeProjects, 0), detail: `${formatMetric(data.summary.projectsCreated, 0)} created in range` },
        { label: 'Unique tools', value: formatMetric(uniqueToolCount(data), 0), detail: 'Requests, invocations, and background jobs' },
        { label: 'Credits / cost record', value: formatMetric(costAvailable && data.costRecords ? data.summary.netCreditsConsumed / data.costRecords : null), detail: `${formatMetric(data.costRecords, 0)} records · not a generation count` },
      ]} />
      <div className='mt-5 flex flex-wrap gap-2'>{Object.entries(data.activity.messagesByRole).map(([role, count]) => <Badge key={role}>{role}: {formatMetric(count, 0)}</Badge>)}</div>
    </Panel>
    {local ? <Muted className='px-2 text-xs'>Local analytics do not supply your subscription, current balance, billing refunds, or provider reconciliation.</Muted> : <Billing data={data} />}
  </div>
}
function Models({ data }: { data: LoggingDashboardResponse }) {
  const totals = data.spend.totals
  const available = data.availability?.costs !== false
  const models = data.models.topByCredits
  return <div className='space-y-5'>
    <Metrics items={[
      { label: 'Approximate cost (USD)', value: available && totals ? `$${formatMetric(totals.approxCostUsd, 4)}` : '—', detail: 'Stored cost records only' },
      { label: 'Input tokens', value: formatMetric(available ? totals?.promptTokens : null, 0), detail: 'Recorded prompt component' },
      { label: 'Output tokens', value: formatMetric(available ? totals?.completionTokens : null, 0), detail: 'Recorded completion component' },
      { label: 'Reasoning breakdown', value: formatMetric(available ? totals?.reasoningTokens : null, 0), detail: 'Not assumed additive to output' },
    ]} />
    <div className='grid gap-5 xl:grid-cols-2'>
      <Panel title='Model spend' subtitle='Highest recorded credit usage; rankings use all models before limiting chart display.'>
        <Chart rows={models.slice().sort((a, b) => Number(b.totalActualCredits || 0) - Number(a.totalActualCredits || 0)).slice(0, 8)} x='model'
          series={[{ key: 'totalActualCredits', label: 'Credits', color: 'accent' }]} kind='bar' horizontal />
      </Panel>
      <Panel title='Recorded token mix' subtitle='Input and output components from provider-cost records. Reasoning is listed separately below.'>
        <Chart rows={data.models.tokenMixByModel.slice(0, 8)} x='model' kind='bar' horizontal
          series={[{ key: 'prompt', label: 'Input', color: 'accent' }, { key: 'completion', label: 'Output', color: 'secondary' }]} />
      </Panel>
    </div>
    <Panel title='Model breakdown' subtitle='Records are cost entries, not a count of chat runs.'>
      <DataTable headers={['Model', 'Cost records', 'Credits', 'Avg credits', 'Input', 'Output', 'Reasoning']}
        rows={models.map(row => { const mix = data.models.tokenMixByModel.find(item => item.model === row.model)
          return [String(row.model || 'unknown'), formatMetric(Number(row.runs || 0), 0), formatMetric(Number(row.totalActualCredits || 0)),
            formatMetric(Number(row.avgActualCredits || 0)), formatMetric(mix ? Number(mix.prompt) : null, 0),
            formatMetric(mix ? Number(mix.completion) : null, 0), formatMetric(mix ? Number(mix.reasoning) : null, 0)] })} />
    </Panel>
    <ReportedUsage data={data} />
  </div>
}
function ReportedUsage({ data }: { data: LoggingDashboardResponse }) {
  const usage = data.reportedUsage
  return <Panel title='Reported OpenAI usage & cache' subtitle='Last persisted usage block per assistant message. Samples may cover only a final response, not every turn in a run. These counts are never added to cost-record totals.'>
    {usage && usage.samples > 0 ? <>
      <Metrics items={[
        { label: 'Reported input', value: formatMetric(usage.inputTokens, 0), detail: `${formatMetric(usage.samples, 0)} distinct stored samples` },
        { label: 'Reported output', value: formatMetric(usage.outputTokens, 0), detail: `${formatMetric(usage.reasoningTokens, 0)} reasoning tokens included in output` },
        { label: 'Cached input', value: formatMetric(usage.cachedInputTokens, 0), detail: 'Provider-reported cache reads' },
        { label: 'Cached input share', value: formatPercent(usage.cachedInputPct), detail: 'Cached input / reported input · not cost savings' },
      ]} />
      <Muted className='mt-4 text-xs'>{formatMetric(usage.messagesWithUsage, 0)} / {formatMetric(usage.assistantMessages, 0)} assistant messages have usage blocks.
        {' '}{formatMetric(usage.duplicateSamples, 0)} duplicate responses excluded; {formatMetric(usage.unidentifiedSamples, 0)} samples have no response ID and cannot be response-deduplicated.</Muted>
    </> : <Empty message='No persisted OpenAI usage samples in this scope. Missing usage is not zero token consumption.' />}
  </Panel>
}
function Outcomes({ title, metrics }: { title: string; metrics?: OutcomeMetrics }) {
  return <Panel title={title} subtitle='Observed elapsed duration, including tools and waits; not model response latency.'>
    {metrics ? <>
      <Metrics items={[
        { label: 'Tracked', value: formatMetric(metrics.total, 0) },
        { label: 'Terminal failure rate', value: formatPercent(metrics.failureRatePct), detail: `${formatMetric(metrics.terminalTotal, 0)} terminal outcomes` },
        { label: 'Median elapsed', value: formatDuration(metrics.duration.p50Ms), detail: `${formatMetric(metrics.duration.samples, 0)} duration samples` },
        { label: 'P90 elapsed', value: formatDuration(metrics.duration.p90Ms), detail: `Average ${formatDuration(metrics.duration.averageMs)}` },
      ]} />
      <div className='mt-4 flex flex-wrap gap-2'>{Object.entries(metrics.statusCounts).map(([status, count]) => <Badge key={status}>{status}: {formatMetric(count, 0)}</Badge>)}</div>
    </> : <Empty message='This source does not supply durable execution metadata.' />}
  </Panel>
}
function RunsAndTools({ data }: { data: LoggingDashboardResponse }) {
  const executions = data.executions?.available ? data.executions : undefined
  const runs = data.localRuns?.available ? data.localRuns : undefined
  const rows = executions?.byTool || []
  const durationRows = rankTools(rows.filter(row => row.duration.samples > 0), row => row.duration.averageMs || 0)
    .map(row => ({ toolName: row.toolName, averageMs: row.duration.averageMs }))
  const failureRows = rankTools(rows.filter(row => row.terminalTotal >= 3), row => row.failureRatePct || 0)
  const jobs = toolJobRows(data)
  const batching = data.tools.batching
  return <div className='space-y-5'>
    <div className='grid gap-5 xl:grid-cols-2'><Outcomes title='Main chat runs' metrics={runs?.main} /><Outcomes title='Subagent runs' metrics={runs?.subagents} /></div>
    <div className='grid gap-5 xl:grid-cols-2'><Outcomes title='Root tool invocations' metrics={executions?.root} /><Outcomes title='Nested tool invocations' metrics={executions?.nested} /></div>
    <div className='grid gap-5 xl:grid-cols-2'>
      <Panel title='Execution trend' subtitle='Root and nested executions are distinct populations; do not add them to requested calls.'>
        <Chart rows={executions?.daily || []} x='date' kind='line' series={[{ key: 'root', label: 'Root', color: 'accent' }, { key: 'nested', label: 'Nested', color: 'secondary' }, { key: 'failed', label: 'Failed (both)', color: 'failed' }]} />
      </Panel>
      <Panel title='Slowest tracked tools' subtitle='Average elapsed duration, ranked across all tools with terminal duration samples.'>
        <Chart rows={durationRows} x='toolName' kind='bar' horizontal unit='duration' series={[{ key: 'averageMs', label: 'Average elapsed', color: 'secondary' }]} />
      </Panel>
      <Panel title='Tool reliability' subtitle='Failure percentage among terminal outcomes; at least three outcomes per tool.'>
        <Chart rows={failureRows.map(row => ({ toolName: row.toolName, failureRatePct: row.failureRatePct }))} x='toolName' kind='bar' horizontal unit='percent' series={[{ key: 'failureRatePct', label: 'Failure rate', color: 'failed' }]} />
      </Panel>
      <Panel title='Requested calls' subtitle='Stored assistant tool calls, not proof of execution. Background jobs and invocations are not matched request populations.'>
        <Chart rows={rankTools(jobs, row => row.requested).filter(row => row.requested > 0)} x='toolName' kind='bar' horizontal
          series={[{ key: 'requested', label: 'Requested', color: 'accent' }]} />
      </Panel>
    </div>
    <Panel title='Tracked execution breakdown' subtitle='Root and nested outcomes remain visible separately. No tracking coverage is inferred from requests.'>
      <DataTable headers={['Tool', 'Root', 'Nested', 'Completed', 'Failed', 'Aborted', 'Failure %', 'Avg elapsed', 'P90', 'Samples']}
        rows={rows.map(row => [row.toolName, formatMetric(row.rootTotal, 0), formatMetric(row.nestedTotal, 0), formatMetric(row.statusCounts.completed || 0, 0),
          formatMetric(row.statusCounts.failed || 0, 0), formatMetric(row.statusCounts.aborted || 0, 0), formatPercent(row.failureRatePct),
          formatDuration(row.duration.averageMs), formatDuration(row.duration.p90Ms), formatMetric(row.duration.samples, 0)])}
        empty={executions ? 'No tracked invocations match these filters.' : 'Durable invocations are unavailable from this source.'} />
    </Panel>
    <Panel title='Batching efficiency' subtitle='Structural calls avoided by multi_call and multi_edit expansion. This is not measured token, cost, cache, or time savings.'>
      {batching ? <>
        <Metrics items={[
          { label: 'Recorded tool calls', value: formatMetric(batching.batchedCalls, 0), detail: 'Includes standalone requests' },
          { label: 'Unbatched equivalent', value: formatMetric(batching.unbatchedEquivalentCalls, 0) },
          { label: 'Calls avoided', value: formatMetric(batching.savedCalls, 0) },
          { label: 'Avoided call share', value: formatPercent(batching.savedCallsPct) },
        ]} />
        <div className='mt-4'><DataTable headers={['Batch tool', 'Batches', 'Expanded calls', 'Calls avoided']}
          rows={batching.byBatchTool.map(row => [row.toolName, formatMetric(row.batches, 0), formatMetric(row.expandedCalls, 0), formatMetric(row.savedCalls, 0)])}
          empty='No multi_call or multi_edit batches in this scope.' /></div>
      </> : <Empty message='This analytics source does not supply batching data. Local and cloud populations are never mixed.' />}
    </Panel>
    <Panel title='Background jobs' subtitle='Separate asynchronous job tracking, not all tool executions. Model and chat-run-status filters do not apply to these jobs.'>
      {data.tools.jobs.available ? <>
        <Metrics items={[
          { label: 'Tracked jobs', value: formatMetric(data.tools.jobs.total, 0) },
          { label: 'Completed', value: formatMetric(data.tools.jobs.statusCounts.completed || 0, 0) },
          { label: 'Failed', value: formatMetric(data.tools.jobs.statusCounts.failed || 0, 0) },
          { label: 'Average runtime', value: formatDuration(data.tools.jobs.averageDurationMs) },
        ]} />
        <div className='mt-4'><DataTable headers={['Tool', 'Requested', 'Jobs', 'Failed jobs', 'Failure %', 'Avg runtime']}
          rows={jobs.map(row => [row.toolName, formatMetric(row.requested, 0), formatMetric(row.total, 0), formatMetric(row.failed, 0),
            formatPercent(row.completed + row.failed + row.cancelled > 0 ? row.failureRatePct : null), formatDuration(row.averageDurationMs)])} /></div>
      </> : <Empty message='Background-job tracking is unavailable.' />}
    </Panel>
  </div>
}
function Quality({ data, local }: { data: LoggingDashboardResponse; local: boolean }) {
  const quality = data.dataQuality
  return <div className='space-y-5'>
    <Panel title='Coverage, not certainty' subtitle='Analytics describe persisted samples. Missing records are not successful zero usage.'>
      <Metrics items={[
        { label: 'Assistant cost coverage', value: formatPercent(data.availability?.costs === false || !quality.assistantMessagesTotal ? null : quality.assistantMessagesWithCostPct),
          detail: `${formatMetric(quality.assistantMessagesWithCost, 0)} / ${formatMetric(quality.assistantMessagesTotal, 0)} assistant messages linked to cost records` },
        { label: 'Stored text tokens (est.)', value: formatMetric(data.summary.estimatedTotalTokens, 0), detail: 'Canonical text estimate · not cumulative generation usage' },
        { label: 'Branch points', value: formatMetric(data.activity.branching.branchPoints, 0), detail: 'Selected message subgraph' },
        { label: 'Maximum branch depth', value: formatMetric(data.activity.branching.maxDepth, 0), detail: `Average ${formatMetric(data.activity.branching.averageDepth)} · filtered-subgraph depth` },
      ]} />
    </Panel>
    <Panel title='Source availability' subtitle='Optional missing historical tables are explicit; other query failures surface as errors.'>
      <DataTable headers={['Source', 'Availability']} rows={local ? [
        ['Provider cost records', data.availability?.costs === true ? 'Available' : 'Unavailable / not reported'],
        ['Persisted chat runs', data.localRuns?.available ? 'Available' : 'Unavailable'],
        ['Durable tool invocations', data.executions?.available ? 'Available' : 'Unavailable'],
        ['Background jobs', data.tools.jobs.available ? 'Available' : 'Unavailable'],
        ['Subscription, balance & reconciliation', 'Not supplied by local analytics'],
      ] : [['Cloud analytics', 'Available'], ['Durable local execution metadata', 'Not included in cloud totals']]} />
      <Muted className='mt-4 text-sm leading-relaxed'>Cost-record numeric zeros can represent omitted usage, not measured free execution.
        Historical run and tool metadata may be incomplete. Reasoning counts may already be part of output tokens.
        Entity activity counts use stored messages; creation counts use entity creation dates.</Muted>
    </Panel>
    <ReportedUsage data={data} />
    {!local && <Panel title='Provider reconciliation' subtitle='Billing-provider records, distinct from local chat streams.'>
      <Metrics items={[
        { label: 'Provider records', value: formatMetric(data.providerRuns.quality.total, 0) },
        { label: 'Reconciled', value: formatPercent(data.providerRuns.quality.total ? data.providerRuns.quality.reconciledPct : null) },
        { label: 'Message link coverage', value: formatPercent(data.providerRuns.quality.total ? data.providerRuns.quality.withMessageLinkPct : null) },
        { label: 'P90 reconciliation lag', value: data.providerRuns.quality.total ? `${formatMetric(data.providerRuns.reconcileLagMinutes.p90)} min` : '—' },
      ]} />
    </Panel>}
  </div>
}
function Billing({ data }: { data: LoggingDashboardResponse }) {
  const plan = data.payments.currentPlan
  return <div className='grid gap-5 xl:grid-cols-2'>
    <Panel title='Subscription & balance' subtitle='Current account information, independent of selected activity filters.'>
      <DataTable headers={['Metric', 'Value']} rows={[
        ['Plan', plan?.planName || plan?.planCode || '—'], ['Status', plan?.subscriptionStatus || '—'],
        ['Credits balance', formatMetric(data.payments.currentCreditsBalance)], ['Credits / day', formatMetric(data.spend.burnRate.creditsPerDay)],
        ['Projected days remaining', formatMetric(data.spend.burnRate.projectedDaysRemaining)],
      ]} />
    </Panel>
    <Panel title='Allocations & top-ups' subtitle='Recorded billing history returned by the selected analytics source.'>
      <DataTable headers={['Type', 'Date', 'Credits']} rows={[
        ...data.payments.history.monthlyAllocation.map(row => ['Allocation', String(row.created_at || '').slice(0, 10), formatMetric(Number(row.credits || 0))]),
        ...data.payments.history.topups.map(row => ['Top-up', String(row.created_at || '').slice(0, 10), formatMetric(Number(row.credits || 0))]),
      ]} />
    </Panel>
  </div>
}

type Series = { key: string; label: string; color: 'accent' | 'secondary' | 'failed' }
function Chart({ rows, x, series, kind, horizontal = false, unit }: { rows: Array<Record<string, unknown>>;
  x: string; series: Series[]; kind: 'bar' | 'line'; horizontal?: boolean; unit?: 'percent' | 'duration' }) {
  const tone = useTone()
  const reduced = useReducedMotion()
  if (!rows.length) return <Empty message='No recorded samples for this chart in the selected scope.' />
  const axis = { tick: { fill: tone.mutedChart, fontSize: 11 }, axisLine: false, tickLine: false }
  const formatter = (value: number) => unit === 'percent' ? formatPercent(value) : unit === 'duration' ? formatDuration(value) : formatMetric(value)
  // Recharts 2 cannot discover children inside React 19 fragments. Keep them flat.
  const chartChildren = [
    <CartesianGrid key='grid' stroke={tone.mutedChart} strokeDasharray='3 5' opacity={0.12} horizontal={!horizontal} vertical={horizontal} />,
    <XAxis key='x-axis' {...axis} type={horizontal ? 'number' : 'category'}
      scale={!horizontal && x === 'date' ? 'point' : undefined} dataKey={horizontal ? undefined : x}
      tickFormatter={horizontal ? formatter : (value: string) => shortenLabel(String(value), x === 'date' ? 10 : 18)}
      domain={unit === 'percent' ? [0, 100] : undefined} />,
    <YAxis key='y-axis' {...axis} type={horizontal ? 'category' : 'number'} dataKey={horizontal ? x : undefined} width={horizontal ? 120 : 48}
      tickFormatter={horizontal ? (value: string) => shortenLabel(String(value), 18) : undefined} />,
    <Tooltip key='tooltip' content={<ChartTooltip unit={unit} />} cursor={{ fill: tone.mutedChart, opacity: 0.06 }} />,
    <Legend key='legend' wrapperStyle={{ fontSize: 12, color: tone.mutedChart }} />,
    ...series.map(item => kind === 'bar'
      ? <Bar key={item.key} dataKey={item.key} name={item.label} fill={tone[item.color]} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} isAnimationActive={!reduced} />
      : <Line key={item.key} dataKey={item.key} name={item.label} stroke={tone[item.color]} strokeWidth={2} dot={rows.length === 1 ? { r: 3 } : false} type='linear' isAnimationActive={!reduced} />),
  ]
  return <div role='img' aria-label={`${series.map(item => item.label).join(', ')} chart. ${rows.length} recorded buckets.`}>
    <div className='h-64 w-full min-w-0'><ResponsiveContainer width='100%' height='100%'>
      {kind === 'bar' ? <BarChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>{chartChildren}</BarChart>
        : <LineChart data={rows} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>{chartChildren}</LineChart>}
    </ResponsiveContainer></div>
    <Muted className='mt-2 text-xs'>{unit
      ? `${rows.length} tools shown · values are per-tool ${unit === 'percent' ? 'terminal failure rates' : 'average durations'}, not combined totals.`
      : series.map(item => `${item.label}: ${formatter(rows.reduce((sum, row) => sum + (typeof row[item.key] === 'number' ? Number(row[item.key]) : 0), 0))} across displayed buckets`).join(' · ')}</Muted>
  </div>
}
function ChartTooltip({ active, payload, label, unit }: { active?: boolean; payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string }>;
  label?: string | number; unit?: 'percent' | 'duration' }) {
  const tone = useTone()
  if (!active || !payload?.length) return null
  return <div className='max-w-80 rounded-2xl bg-white/95 px-4 py-3 text-xs backdrop-blur-xl dark:bg-neutral-900/95'
    style={{ backgroundColor: tone.panel, color: tone.text }}>
    <div className='mb-2 break-words font-medium'>{label}</div>
    {payload.map(row => <div key={row.dataKey || row.name} className='flex items-center justify-between gap-4 py-0.5'>
      <span style={{ color: row.color }}>{row.name}</span><span className='tabular-nums'>{unit === 'percent' ? formatPercent(row.value) : unit === 'duration' ? formatDuration(row.value) : formatMetric(row.value)}</span>
    </div>)}
  </div>
}
