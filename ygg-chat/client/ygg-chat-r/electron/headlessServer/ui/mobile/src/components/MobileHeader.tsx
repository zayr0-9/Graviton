import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  LocalUserProfile,
  MobileCustomTool,
  MobileOperationMode,
  MobileProviderName,
  MobileReasoningEffort,
} from '../types'
import { ProfilePicker } from './ProfilePicker'
import { ToolTogglePanel } from './ToolTogglePanel'
import { Badge, Button, Input, Select, Textarea } from './ui'

interface MobileHeaderProps {
  providerName: MobileProviderName
  providerOptions: MobileProviderName[]
  modelName: string
  modelOptions: string[]
  statusText: string
  agentTextFontSizePx: number
  minAgentTextFontSizePx: number
  maxAgentTextFontSizePx: number
  onAgentTextFontSizeChange: (value: number) => void
  operationMode: MobileOperationMode
  includeOperationModePrompts: boolean
  thinkingEnabled: boolean
  reasoningEffort: MobileReasoningEffort
  onOperationModeToggle: () => void
  onIncludeOperationModePromptsChange: (enabled: boolean) => void
  onThinkingEnabledChange: (enabled: boolean) => void
  onReasoningEffortChange: (value: MobileReasoningEffort) => void
  users: LocalUserProfile[]
  selectedUserId: string | null
  onProviderChange: (value: MobileProviderName) => void
  onModelChange: (value: string) => void
  onUserSelect: (userId: string) => void
  selectorsDisabled?: boolean
  openAiAuthenticated: boolean
  openRouterAuthenticated: boolean
  zaiAuthenticated: boolean
  openAiBusy: boolean
  hasPendingOpenAiFlow: boolean
  onOpenAiLoginStart: () => void
  onOpenAiLoginComplete: () => void
  onOpenAiLogout: () => void
  onZaiTokenSet: () => void
  onZaiTokenClear: () => void
  customTools: MobileCustomTool[]
  customToolBusyNames: string[]
  customToolsLoading: boolean
  onRefreshCustomTools: () => void
  onToggleCustomTool: (toolName: string, enabled: boolean) => void
  activeConversationId: string | null
  conversationSystemPromptInput: string
  conversationContextInput: string
  conversationCwdInput: string
  onConversationSystemPromptInputChange: (value: string) => void
  onConversationContextInputChange: (value: string) => void
  onConversationCwdInputChange: (value: string) => void
  onSaveConversationSettings: () => void
  savingConversationSettings: boolean
  onOpenProjectConversationPicker: () => void
  canOpenProjectConversationPicker: boolean
  onOpenBranchTree: () => void
  canOpenBranchTree: boolean
  onOpenPathPicker: () => void
  canOpenPathPicker: boolean
}

const PROVIDER_LABELS: Record<MobileProviderName, string> = {
  openaichatgpt: 'OpenAI ChatGPT',
  openrouter: 'OpenRouter',
  lmstudio: 'LM Studio',
  zai: 'Z.AI / GLM',
  bedrock: 'AWS Bedrock',
}

const REASONING_EFFORT_LABELS: Record<MobileReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
}

const REASONING_EFFORT_OPTIONS: MobileReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

export const MobileHeader: React.FC<MobileHeaderProps> = ({
  providerName,
  providerOptions,
  modelName,
  modelOptions,
  statusText,
  agentTextFontSizePx,
  minAgentTextFontSizePx,
  maxAgentTextFontSizePx,
  onAgentTextFontSizeChange,
  operationMode,
  includeOperationModePrompts,
  thinkingEnabled,
  reasoningEffort,
  onOperationModeToggle,
  onIncludeOperationModePromptsChange,
  onThinkingEnabledChange,
  onReasoningEffortChange,
  users,
  selectedUserId,
  onProviderChange,
  onModelChange,
  onUserSelect,
  selectorsDisabled = false,
  openAiAuthenticated,
  openRouterAuthenticated,
  zaiAuthenticated,
  openAiBusy,
  hasPendingOpenAiFlow,
  onOpenAiLoginStart,
  onOpenAiLoginComplete,
  onOpenAiLogout,
  onZaiTokenSet,
  onZaiTokenClear,
  customTools,
  customToolBusyNames,
  customToolsLoading,
  onRefreshCustomTools,
  onToggleCustomTool,
  activeConversationId,
  conversationSystemPromptInput,
  conversationContextInput,
  conversationCwdInput,
  onConversationSystemPromptInputChange,
  onConversationContextInputChange,
  onConversationCwdInputChange,
  onSaveConversationSettings,
  savingConversationSettings,
  onOpenProjectConversationPicker,
  canOpenProjectConversationPicker,
  onOpenBranchTree,
  canOpenBranchTree,
  onOpenPathPicker,
  canOpenPathPicker,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [conversationSettingsExpanded, setConversationSettingsExpanded] = useState(false)

  const filteredModelOptions = useMemo(() => {
    const query = modelSearch.trim().toLowerCase()
    if (!query) return modelOptions

    const matches = modelOptions.filter(model => model.toLowerCase().includes(query))
    if (matches.includes(modelName) || !modelName) return matches
    return [modelName, ...matches]
  }, [modelOptions, modelName, modelSearch])

  const authStatus = useMemo(() => {
    if (providerName === 'openaichatgpt') {
      return {
        label: `OpenAI ${openAiAuthenticated ? 'connected' : 'not connected'}`,
        className: openAiAuthenticated ? 'connected' : 'disconnected',
      }
    }
    if (providerName === 'openrouter') {
      return {
        label: `OpenRouter ${openRouterAuthenticated ? 'connected' : 'not connected'}`,
        className: openRouterAuthenticated ? 'connected' : 'disconnected',
      }
    }
    if (providerName === 'zai') {
      return {
        label: `Z.AI ${zaiAuthenticated ? 'connected' : 'not connected'}`,
        className: zaiAuthenticated ? 'connected' : 'disconnected',
      }
    }
    return {
      label: 'LM Studio local provider',
      className: 'connected',
    }
  }, [providerName, openAiAuthenticated, openRouterAuthenticated, zaiAuthenticated])

  useEffect(() => {
    if (!settingsOpen) {
      setModelSearch('')
      return
    }

    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }

    window.addEventListener('keydown', handleEscape)

    return () => {
      document.body.style.overflow = previousBodyOverflow
      window.removeEventListener('keydown', handleEscape)
    }
  }, [settingsOpen])

  useEffect(() => {
    setModelSearch('')
  }, [providerName])

  const settingsPortal =
    settingsOpen && typeof document !== 'undefined'
      ? createPortal(
          <div className='mobile-settings-portal-root'>
            <button
              type='button'
              aria-label='Close settings panel'
              className='mobile-settings-portal-backdrop'
              onClick={() => setSettingsOpen(false)}
            />

            <section className='mobile-settings-portal' role='dialog' aria-modal='true' aria-label='Chat settings'>
              <header className='mobile-settings-portal-header'>
                <div>
                  <h2>Chat settings</h2>
                  <p>Pick model + profile, then continue chatting.</p>
                </div>
                <Button variant='outline' size='sm' onClick={() => setSettingsOpen(false)}>
                  Done
                </Button>
              </header>

              <div className='mobile-settings-portal-body'>
                <div className='mobile-settings-select-grid'>
                  <label className='mobile-settings-field'>
                    <span>Provider</span>
                    <Select
                      value={providerName}
                      onChange={event => onProviderChange(event.target.value as MobileProviderName)}
                      disabled={selectorsDisabled}
                    >
                      {providerOptions.map(provider => (
                        <option key={provider} value={provider}>
                          {PROVIDER_LABELS[provider]}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <label className='mobile-settings-field'>
                    <span>Model</span>
                    <Input
                      type='text'
                      value={modelSearch}
                      onChange={event => setModelSearch(event.target.value)}
                      placeholder='Search models…'
                      disabled={selectorsDisabled || modelOptions.length <= 1}
                    />
                    <span className='mobile-settings-field-hint'>
                      {filteredModelOptions.length} of {modelOptions.length} models
                    </span>
                    <Select
                      value={modelName}
                      onChange={event => onModelChange(event.target.value)}
                      disabled={selectorsDisabled}
                    >
                      {filteredModelOptions.map(model => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <ProfilePicker
                    users={users}
                    selectedUserId={selectedUserId}
                    onSelect={onUserSelect}
                    disabled={selectorsDisabled}
                    compact
                  />
                </div>

                <section className='mobile-settings-mode-prompts' aria-label='Default operation mode prompts'>
                  <div>
                    <strong>Default mode prompts</strong>
                    <p>Include built-in Chat/Agent instructions before project and conversation prompts.</p>
                  </div>
                  <label className='mobile-settings-toggle-row'>
                    <input
                      type='checkbox'
                      checked={includeOperationModePrompts}
                      onChange={event => onIncludeOperationModePromptsChange(event.target.checked)}
                      disabled={selectorsDisabled}
                    />
                    <span>{includeOperationModePrompts ? 'Enabled' : 'Disabled'}</span>
                  </label>
                </section>

                <section className='mobile-settings-thinking-options' aria-label='Thinking options'>
                  <div className='mobile-settings-thinking-options-header'>
                    <div>
                      <strong>Thinking options</strong>
                      <p>Send reasoning preferences to providers/models that support thinking.</p>
                    </div>
                    <label className='mobile-settings-toggle-row'>
                      <input
                        type='checkbox'
                        checked={thinkingEnabled}
                        onChange={event => onThinkingEnabledChange(event.target.checked)}
                        disabled={selectorsDisabled}
                      />
                      <span>{thinkingEnabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                  </div>
                  <label className='mobile-settings-field mobile-settings-thinking-effort-field'>
                    <span>Reasoning effort</span>
                    <Select
                      value={reasoningEffort}
                      onChange={event => onReasoningEffortChange(event.target.value as MobileReasoningEffort)}
                      disabled={selectorsDisabled || !thinkingEnabled}
                    >
                      {REASONING_EFFORT_OPTIONS.map(option => (
                        <option key={option} value={option}>
                          {option === reasoningEffort
                            ? `${REASONING_EFFORT_LABELS[option]} (Selected)`
                            : REASONING_EFFORT_LABELS[option]}
                        </option>
                      ))}
                    </Select>
                  </label>
                </section>

                <section className='mobile-settings-font-zoom' aria-label='Assistant text zoom'>
                  <div className='mobile-settings-font-zoom-header'>
                    <span>Agent text zoom</span>
                    <strong>{agentTextFontSizePx}px</strong>
                  </div>
                  <div className='mobile-settings-font-zoom-row'>
                    <span aria-hidden='true'>A</span>
                    <Input
                      type='range'
                      min={minAgentTextFontSizePx}
                      max={maxAgentTextFontSizePx}
                      step={1}
                      value={agentTextFontSizePx}
                      onChange={event => onAgentTextFontSizeChange(Number(event.target.value))}
                      aria-label='Agent message text font size'
                      className='mobile-settings-font-zoom-slider'
                    />
                    <span aria-hidden='true'>A</span>
                  </div>
                  <p>Controls the font size for assistant text responses.</p>
                </section>

                <div className='mobile-settings-auth-row'>
                  <Badge className={`mobile-auth-pill ${authStatus.className}`} variant='outline'>
                    {authStatus.label}
                  </Badge>

                  {providerName === 'openaichatgpt' ? (
                    !openAiAuthenticated ? (
                      <>
                        <Button onClick={onOpenAiLoginStart} disabled={openAiBusy} variant='secondary' size='sm'>
                          Sign in OpenAI
                        </Button>
                        <Button
                          onClick={onOpenAiLoginComplete}
                          disabled={openAiBusy || !hasPendingOpenAiFlow}
                          variant='outline'
                          size='sm'
                        >
                          Complete sign-in
                        </Button>
                      </>
                    ) : (
                      <Button onClick={onOpenAiLogout} disabled={openAiBusy} variant='outline' size='sm'>
                        Sign out OpenAI
                      </Button>
                    )
                  ) : providerName === 'openrouter' ? (
                    <span className='mobile-conversation-cwd-hint'>OpenRouter uses your stored app token.</span>
                  ) : providerName === 'zai' ? (
                    zaiAuthenticated ? (
                      <>
                        <Button onClick={onZaiTokenSet} variant='secondary' size='sm'>
                          Replace Z.AI key
                        </Button>
                        <Button onClick={onZaiTokenClear} variant='outline' size='sm'>
                          Clear Z.AI key
                        </Button>
                      </>
                    ) : (
                      <Button onClick={onZaiTokenSet} variant='secondary' size='sm'>
                        Enter Z.AI API key
                      </Button>
                    )
                  ) : (
                    <span className='mobile-conversation-cwd-hint'>LM Studio uses your local runtime. No remote auth needed.</span>
                  )}
                </div>

                <section className='mobile-settings-collapsible'>
                  <button
                    type='button'
                    className='mobile-settings-collapsible-toggle'
                    onClick={() => setConversationSettingsExpanded(previous => !previous)}
                    aria-expanded={conversationSettingsExpanded}
                  >
                    <span>
                      <strong>Prompt, context, and cwd</strong>
                      <small>Project prompt/context plus conversation cwd</small>
                    </span>
                    <span aria-hidden='true'>{conversationSettingsExpanded ? '▾' : '▸'}</span>
                  </button>

                  {conversationSettingsExpanded ? (
                    <div className='mobile-settings-collapsible-body'>
                      <label className='mobile-settings-field' htmlFor='conversation-system-prompt-input'>
                        <span>System prompt</span>
                        <Textarea
                          id='conversation-system-prompt-input'
                          value={conversationSystemPromptInput}
                          onChange={event => onConversationSystemPromptInputChange(event.target.value)}
                          placeholder='Optional system prompt for this conversation'
                          rows={4}
                          disabled={!activeConversationId || selectorsDisabled || savingConversationSettings}
                        />
                      </label>

                      <label className='mobile-settings-field' htmlFor='conversation-context-input'>
                        <span>Context</span>
                        <Textarea
                          id='conversation-context-input'
                          value={conversationContextInput}
                          onChange={event => onConversationContextInputChange(event.target.value)}
                          placeholder='Optional conversation context or notes'
                          rows={5}
                          disabled={!activeConversationId || selectorsDisabled || savingConversationSettings}
                        />
                      </label>

                      <div className='mobile-conversation-cwd mobile-conversation-cwd--in-settings'>
                        <label htmlFor='conversation-cwd-input'>Conversation working directory (cwd)</label>
                        <div className='mobile-conversation-cwd-row'>
                          <Input
                            id='conversation-cwd-input'
                            type='text'
                            value={conversationCwdInput}
                            onChange={event => onConversationCwdInputChange(event.target.value)}
                            placeholder='e.g. D:\\projects\\my-repo'
                            disabled={!activeConversationId || selectorsDisabled || savingConversationSettings}
                          />
                          <Button
                            onClick={onSaveConversationSettings}
                            disabled={!activeConversationId || selectorsDisabled || savingConversationSettings}
                            variant='outline'
                            size='sm'
                          >
                            {savingConversationSettings ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                        <span className='mobile-conversation-cwd-hint'>
                          Used as tool execution root for this conversation. Leave empty to fall back to project cwd.
                        </span>
                      </div>
                    </div>
                  ) : null}
                </section>

                <div className='mobile-settings-tools-wrap'>
                  <ToolTogglePanel
                    tools={customTools}
                    busyToolNames={customToolBusyNames}
                    loading={customToolsLoading}
                    disabled={selectorsDisabled}
                    onRefresh={onRefreshCustomTools}
                    onToggleTool={onToggleCustomTool}
                  />
                </div>
              </div>
            </section>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <header className='mobile-header'>
        <div className='mobile-header-top'>
          <div className='mobile-header-brand'>
            <h1>Graviton</h1>
            <p className='mobile-status'>
              <span className='mobile-status-dot' aria-hidden='true' />
              {statusText}
            </p>
          </div>

          <div className='mobile-header-actions'>
            <Button
              variant='ghost'
              size='sm'
              className='mobile-header-icon-button'
              onClick={onOpenBranchTree}
              disabled={!canOpenBranchTree}
              aria-label='Open branch tree'
              title='Open branch tree'
            >
              ⎇
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className={`mobile-header-mode-button ${operationMode === 'plan' ? 'is-chat' : 'is-agent'}`}
              onClick={onOperationModeToggle}
              disabled={selectorsDisabled}
              aria-label={operationMode === 'plan' ? 'Switch to Agent Mode' : 'Switch to Chat Mode'}
              title={operationMode === 'plan' ? 'Chat Mode: planning/read-only' : 'Agent Mode: tool execution'}
            >
              {operationMode === 'plan' ? 'Chat' : 'Agent'}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='mobile-header-icon-button'
              onClick={onOpenProjectConversationPicker}
              disabled={!canOpenProjectConversationPicker}
              aria-label='Switch project or conversation'
              title='Switch project or conversation'
            >
              ☰
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='mobile-header-icon-button'
              onClick={() => setSettingsOpen(true)}
              aria-haspopup='dialog'
              aria-expanded={settingsOpen}
              aria-label='Open chat settings'
              title='Open chat settings'
            >
              ⚙
            </Button>
          </div>
        </div>

        <div className='mobile-header-summary mobile-header-summary--compact'>
          <div className='mobile-header-summary-item'>
            <span>{PROVIDER_LABELS[providerName]} · {operationMode === 'plan' ? 'Chat Mode' : 'Agent Mode'}</span>
            <strong>{modelName}</strong>
            <Button
              variant='ghost'
              size='sm'
              className='mobile-header-path-button'
              onClick={onOpenPathPicker}
              disabled={!canOpenPathPicker}
              title={canOpenPathPicker ? 'Browse files/folders and insert path' : 'Set conversation/project cwd first'}
              aria-label='Open file path picker'
            >
              ＋
            </Button>
          </div>
        </div>
      </header>

      {settingsPortal}
    </>
  )
}
