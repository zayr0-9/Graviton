import React, { useMemo, useState } from 'react'

import { useFilteredModels, useModels } from '../../hooks/useQueries'
import { ExpandedModelView } from '../ExpandedModelView/ExpandedModelView'
import { ModelFilterUI } from '../ModelFilterUI/ModelFilterUI'
import { Select } from '../Select/Select'

type ModelSelectControlProps = {
  provider: string | null
  selectedModelName?: string
  onChange: (modelName: string) => void
  className?: string
  placeholder?: string
  size?: 'small' | 'medium' | 'large'
  blur?: 'low' | 'high'
  showFilters?: boolean
  footerContent?: React.ReactNode
}

export const ModelSelectControl: React.FC<ModelSelectControlProps> = ({
  provider,
  selectedModelName,
  onChange,
  className,
  placeholder = 'Select a model...',
  size = 'medium',
  blur = 'low',
  showFilters = false,
  footerContent,
}) => {
  const { data: modelsData } = useModels(provider)
  const { filteredModels, filters, sortOptions, applyFilters, clearFilters, applySorting, refreshFavorites } =
    useFilteredModels(provider)

  // State for expanded model view modal
  const [expandedViewOpen, setExpandedViewOpen] = useState(false)

  const models = modelsData?.models || []
  const userIsFreeTier = modelsData?.userIsFreeTier ?? false

  const disabledModelOptions = useMemo(() => {
    if (!userIsFreeTier) return []
    return models.filter(m => !m.isFreeTier).map(m => m.name)
  }, [userIsFreeTier, models])

  const sortedFilteredModels = useMemo(() => {
    if (!userIsFreeTier) return filteredModels

    const freeModels = filteredModels.filter(m => m.isFreeTier)
    const paidModels = filteredModels.filter(m => !m.isFreeTier)
    return [...freeModels, ...paidModels]
  }, [filteredModels, userIsFreeTier])

  const modelData = useMemo(
    () => Object.fromEntries(sortedFilteredModels.map(m => [m.name, m])),
    [sortedFilteredModels]
  )

  return (
    <>
      <Select
        value={selectedModelName || ''}
        modelProvider={provider}
        onChange={onChange}
        options={sortedFilteredModels.map(m => m.name)}
        placeholder={placeholder}
        blur={blur}
        disabled={sortedFilteredModels.length === 0}
        disabledOptions={disabledModelOptions}
        className={className}
        searchBarVisible={true}
        modelData={modelData}
        onFavoritesChange={refreshFavorites}
        filterUI={
          showFilters === false ? undefined : (
            <ModelFilterUI
              filters={filters}
              sortOptions={sortOptions}
              onFiltersChange={applyFilters}
              onSortChange={applySorting}
              onClearFilters={clearFilters}
            />
          )
        }
        modelSelect={true}
        footerContent={footerContent}
        size={size}
        showExpandButton={true}
        onExpandClick={() => setExpandedViewOpen(true)}
        totalOptionsCount={sortedFilteredModels.length}
      />

      <ExpandedModelView
        isOpen={expandedViewOpen}
        onClose={() => setExpandedViewOpen(false)}
        models={sortedFilteredModels}
        provider={provider}
        selectedModelName={selectedModelName}
        onSelect={onChange}
        disabledOptions={disabledModelOptions}
      />
    </>
  )
}
