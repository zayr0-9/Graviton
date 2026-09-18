import React, { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BaseModel } from '../../../../../shared/types'
import {
  CODING_MODELS,
  COMPANY_PREFIXES,
  COMPANY_TAB_ORDER,
  NEW_MODELS,
  RESEARCH_MODELS,
  TOP_MODELS,
} from '../../config/modelLists'
import { Button } from '../Button/button'
import { ModelInfoModal } from '../ModelInfoModal/ModelInfoModal'

interface ExpandedModelViewProps {
  isOpen: boolean
  onClose: () => void
  models: BaseModel[]
  provider?: string | null
  selectedModelName?: string
  onSelect: (modelName: string) => void
  disabledOptions?: string[]
}

type TabId = 'top' | 'new' | 'coding' | 'research' | 'image-gen' | 'all' | string // string for company names

interface Tab {
  id: TabId
  label: string
}

export const ExpandedModelView: React.FC<ExpandedModelViewProps> = ({
  isOpen,
  onClose,
  models,
  provider,
  selectedModelName,
  onSelect,
  disabledOptions = [],
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('top')
  const [searchTerm, setSearchTerm] = useState('')
  const [showModelInfo, setShowModelInfo] = useState(false)
  const [selectedModelForInfo, setSelectedModelForInfo] = useState<BaseModel | null>(null)

  // Build tabs: Top, New, Image Gen, Companies..., All
  const tabs: Tab[] = useMemo(() => {
    const baseTabs: Tab[] = [
      { id: 'top', label: 'Top' },
      // { id: 'new', label: 'New' },
      { id: 'coding', label: 'Coding' },
      { id: 'research', label: 'Research' },
      { id: 'image-gen', label: 'Image Gen' },
    ]

    // Add company tabs in order
    const companyTabs = COMPANY_TAB_ORDER.map(company => ({
      id: company,
      label: company,
    }))

    return [...baseTabs, { id: 'all', label: 'All' }, ...companyTabs]
  }, [])

  // Filter models based on active tab and search
  const filteredModels = useMemo(() => {
    let result: BaseModel[] = []

    switch (activeTab) {
      case 'top':
        // Show models in TOP_MODELS list, preserving order
        result = TOP_MODELS.map(name => models.find(m => m.name === name)).filter(Boolean) as BaseModel[]
        break
      case 'new':
        // Show models in NEW_MODELS list, preserving order
        result = NEW_MODELS.map(name => models.find(m => m.name === name)).filter(Boolean) as BaseModel[]
        break
      case 'coding':
        // Show models optimized for coding
        result = CODING_MODELS.map(name => models.find(m => m.name === name)).filter(Boolean) as BaseModel[]
        break
      case 'research':
        // Show models optimized for research
        result = RESEARCH_MODELS.map(name => models.find(m => m.name === name)).filter(Boolean) as BaseModel[]
        break
      case 'image-gen':
        // Show models that can generate images (outputModalities includes 'image')
        result = models.filter(m => m.outputModalities?.includes('image'))
        break
      case 'all':
        result = models
        break
      default:
        // Company tab - filter by prefix
        const prefix = COMPANY_PREFIXES[activeTab]
        if (prefix) {
          result = models.filter(m => m.name.startsWith(prefix))
        }
        break
    }

    // Apply search filter
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase()
      result = result.filter(
        m =>
          m.name.toLowerCase().includes(term) ||
          m.displayName?.toLowerCase().includes(term) ||
          m.description?.toLowerCase().includes(term)
      )
    }

    return result
  }, [activeTab, models, searchTerm])

  // Format context length for display
  const formatContextLength = (length: number): string => {
    if (!length) return ''
    if (length >= 1000000) return `${(length / 1000000).toFixed(1)}M`
    if (length >= 1000) return `${Math.round(length / 1000)}K`
    return String(length)
  }

  // Base costs for relative pricing (in credits per 1M tokens)
  const BASE_PROMPT_COST = 1.25
  // const BASE_COMPLETION_COST = 10.0

  // Format pricing as I/O multipliers relative to base cost
  const formatPricing = (promptCost: number, completionCost: number): string | null => {
    if (!promptCost && !completionCost) return null

    // Convert to per-1M-tokens cost (costs are stored as per-token)
    const promptPer1M = promptCost * 1000000
    // const completionPer1M = completionCost * 1000000

    // Calculate multipliers relative to base
    const inputMultiplier = promptPer1M / BASE_PROMPT_COST
    // const outputMultiplier = completionPer1M / BASE_COMPLETION_COST

    // Format multipliers (show 1 decimal if needed, otherwise whole number)
    const formatMultiplier = (m: number): string => {
      if (m === 0) return '0'
      if (m < 0.1) return m.toFixed(2)
      if (m < 1) return m.toFixed(1)
      if (m >= 100) return Math.round(m).toString()
      return m % 1 === 0 ? m.toString() : m.toFixed(1)
    }

    return `${formatMultiplier(inputMultiplier)}`
    // return `${formatMultiplier(inputMultiplier)}/${formatMultiplier(outputMultiplier)}`
  }

  const handleModelSelect = (modelName: string) => {
    if (disabledOptions.includes(modelName)) return
    onSelect(modelName)
    // onClose()
  }

  if (!isOpen) return null

  return (
    <>
      {createPortal(
        <div
          className='fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm'
          onClick={onClose}
        >
          <div
            className='bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col overflow-hidden'
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className='shrink-0 border-b border-neutral-200 dark:border-neutral-800 px-6 py-4 flex items-center justify-between'>
              <h2 className='text-xl font-semibold text-neutral-900 dark:text-neutral-100'>Select Model</h2>
              <button
                onClick={onClose}
                className='text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors'
                aria-label='Close modal'
              >
                <i className='bx bx-x text-2xl' />
              </button>
            </div>

            {/* Tabs */}
            <div className='shrink-0 border-b border-neutral-200 dark:border-neutral-800 px-4 overflow-x-auto thin-scrollbar'>
              <div className='flex gap-1 py-2'>
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all whitespace-nowrap ${
                      activeTab === tab.id
                        ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100'
                        : 'text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Search */}
            <div className='shrink-0 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800'>
              <div className='relative'>
                <i className='bx bx-search absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400' />
                <input
                  type='text'
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder='Search models...'
                  className='w-full pl-10 pr-4 py-2 text-sm rounded-lg text-stone-800 dark:text-neutral-200 border border-neutral-300 dark:border-neutral-700 bg-transparent focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:focus:ring-neutral-600'
                  autoFocus
                />
              </div>
            </div>

            {/* Table Header */}
            <div className='shrink-0 px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50'>
              <div className='flex items-center gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide'>
                <div className='flex-1 min-w-0 pl-4'>Name</div>
                <div className='w-10 text-center pr-13' title='Reasoning/Thinking'>
                  Think
                </div>
                <div className='w-10 text-center pr-13' title='Image Support'>
                  Image Input
                </div>
                {/* <div className='w-10 text-center' title='Structured Outputs'>
              Structured Output
            </div> */}
                <div className='w-16 text-center pr-13'>Cost</div>
                <div className='w-16 text-center pr-13'>Context</div>
                <div className='w-8'></div>
              </div>
            </div>

            {/* Model List */}
            <div className='flex-1 overflow-y-auto thin-scrollbar px-4 py-2'>
              {filteredModels.length === 0 ? (
                <div className='text-center py-8 text-neutral-500 dark:text-neutral-400'>
                  {activeTab === 'new' && NEW_MODELS.length === 0
                    ? 'No new models configured. Edit config/modelLists.ts to add models.'
                    : activeTab === 'top' && TOP_MODELS.length === 0
                      ? 'No top models configured. Edit config/modelLists.ts to add models.'
                      : activeTab === 'coding' && CODING_MODELS.length === 0
                        ? 'No coding models configured. Edit config/modelLists.ts to add models.'
                        : activeTab === 'research' && RESEARCH_MODELS.length === 0
                          ? 'No research models configured. Edit config/modelLists.ts to add models.'
                          : activeTab === 'image-gen'
                            ? 'No image generation models available.'
                            : 'No models found'}
                </div>
              ) : (
                <div className='space-y-1'>
                  {filteredModels.map(model => {
                    const isSelected = model.name === selectedModelName
                    const isDisabled = disabledOptions.includes(model.name)

                    return (
                      <button
                        key={model.name}
                        onClick={() => handleModelSelect(model.name)}
                        disabled={isDisabled}
                        className={`w-full text-left px-4 py-2.5 rounded-xl transition-all ${
                          isSelected
                            ? 'bg-neutral-200 dark:bg-neutral-700'
                            : isDisabled
                              ? 'opacity-50 cursor-not-allowed'
                              : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                        }`}
                      >
                        <div className='flex items-center gap-2'>
                          {/* Name column */}
                          <div className='relative flex-1 min-w-0'>
                            <div className='flex items-center gap-2'>
                              <span className='font-medium text-neutral-900 dark:text-neutral-100 truncate overflow-left'>
                                {model.displayName || model.name}
                              </span>
                              {isSelected && (
                                <span className='absolute text-xs px-1.5 py-0.5 -bottom-5 -left-4 rounded bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'>
                                  Selected
                                </span>
                              )}
                              {isDisabled && <i className='bx bx-lock-alt text-neutral-400' />}
                            </div>
                            <div className='text-xs text-neutral-500 dark:text-neutral-400 truncate'>{model.name}</div>
                          </div>

                          {/* Reasoning column */}
                          <div className='w-10 text-center'>
                            {model.thinking ? (
                              <i className='bx bx-brain text-xl text-purple-600 dark:text-purple-400' />
                            ) : (
                              <span className='text-neutral-300 dark:text-neutral-600'>-</span>
                            )}
                          </div>

                          {/* Image column */}
                          <div className='w-10 text-center'>
                            {model.supportsImages ? (
                              <i className='bx bx-image text-xl text-blue-600 dark:text-blue-400' />
                            ) : (
                              <span className='text-neutral-300 dark:text-neutral-600'>-</span>
                            )}
                          </div>

                          {/* Structured Outputs column */}
                          {/* <div className='w-10 text-center'>
                        {model.supportsStructuredOutputs ? (
                          <i className='bx bx-code-block text-xl text-orange-600 dark:text-orange-400' />
                        ) : (
                          <span className='text-neutral-300 dark:text-neutral-600'>-</span>
                        )}
                      </div> */}

                          {/* Cost column */}
                          <div className='w-16 text-center'>
                            {formatPricing(model.promptCost, model.completionCost) ? (
                              <span className='text-xs px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'>
                                {formatPricing(model.promptCost, model.completionCost)}x
                              </span>
                            ) : (
                              <span className='text-neutral-300 dark:text-neutral-600'>-</span>
                            )}
                          </div>

                          {/* Context column */}
                          <div className='w-16 text-center'>
                            {model.contextLength > 0 ? (
                              <span className='text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'>
                                {formatContextLength(model.contextLength)}
                              </span>
                            ) : (
                              <span className='text-neutral-300 dark:text-neutral-600'>-</span>
                            )}
                          </div>

                          {/* Info button */}
                          <div
                            className='w-8 text-center'
                            onClick={e => {
                              e.stopPropagation()
                              setSelectedModelForInfo(model)
                              setShowModelInfo(true)
                            }}
                          >
                            <button
                              type='button'
                              className='p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-lg transition-colors'
                              aria-label='View model details'
                            >
                              <i className='bx bx-dots-vertical-rounded text-neutral-600 dark:text-neutral-400' />
                            </button>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className='shrink-0 border-t border-neutral-200 dark:border-neutral-800 px-6 py-4 flex items-center justify-between'>
              <span className='text-sm text-neutral-500 dark:text-neutral-400'>
                {filteredModels.length} model{filteredModels.length !== 1 ? 's' : ''}
              </span>
              <Button variant='outline2' size='medium' onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
      <ModelInfoModal
        model={selectedModelForInfo}
        provider={provider}
        isOpen={showModelInfo}
        onClose={() => setShowModelInfo(false)}
      />
    </>
  )
}
