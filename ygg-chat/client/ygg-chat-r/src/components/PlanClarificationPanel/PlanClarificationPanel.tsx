import { CircleHelp } from 'lucide-react'
import React, { useMemo, useState } from 'react'
import type {
  PlanClarificationAnswer,
  PlanClarificationOption,
  PlanClarificationRequest,
} from '../../features/chats/planToolTypes'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

interface PlanClarificationPanelProps {
  request: PlanClarificationRequest
  onSubmit: (answers: PlanClarificationAnswer[]) => void
  onCancel: () => void
}

type SelectionState = Record<
  string,
  {
    optionId: string
    manualText: string
  }
>

const getOptionId = (option: PlanClarificationOption): string => option.id || option.label

export const PlanClarificationPanel: React.FC<PlanClarificationPanelProps> = ({ request, onSubmit, onCancel }) => {
  const [selectionByQuestionId, setSelectionByQuestionId] = useState<SelectionState>({})
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const questions = useMemo(() => request.questions.map(question => {
    if (question.options?.some(option => option.manual)) return question
    const options = question.options || []
    let manualId = 'manual'
    while (options.some(option => getOptionId(option) === manualId)) manualId += '-answer'
    return {
      ...question,
      options: [...options, {
        id: manualId,
        label: question.manualLabel?.trim() || 'Write my own answer',
        manual: true,
      }],
    }
  }), [request.questions])

  const panelStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
      }
    : undefined
  const innerStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
      }
    : undefined
  const titleStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode) }
    : undefined
  const mutedTextStyle: React.CSSProperties | undefined = customThemeEnabled
    ? { color: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode) }
    : undefined
  const badgeStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesBadgeText, isDarkMode),
      }
    : undefined
  const selectedOptionStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
      }
    : undefined
  const manualInputStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesListBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
      }
    : undefined
  const secondaryButtonStyle: React.CSSProperties | undefined = customThemeEnabled
    ? {
        backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
        color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
      }
    : undefined
  const primaryButtonStyle: React.CSSProperties | undefined = customThemeEnabled
    ? canSubmitStyle(customTheme, isDarkMode)
    : undefined

  const canSubmit = useMemo(() => {
    return questions.every(question => {
      const questionId = question.id || question.question
      const selected = selectionByQuestionId[questionId]
      if (!selected?.optionId) return false
      const option = question.options?.find(candidate => getOptionId(candidate) === selected.optionId)
      if (option?.manual) return selected.manualText.trim().length > 0
      return Boolean(option)
    })
  }, [questions, selectionByQuestionId])

  const updateSelection = (questionId: string, option: PlanClarificationOption) => {
    setSelectionByQuestionId(prev => ({
      ...prev,
      [questionId]: {
        optionId: getOptionId(option),
        manualText: prev[questionId]?.manualText || '',
      },
    }))
  }

  const updateManualText = (questionId: string, optionId: string, manualText: string) => {
    setSelectionByQuestionId(prev => ({
      ...prev,
      [questionId]: {
        optionId,
        manualText,
      },
    }))
  }

  const handleSubmit = () => {
    const answers: PlanClarificationAnswer[] = questions.map(question => {
      const questionId = question.id || question.question
      const selected = selectionByQuestionId[questionId]
      const option = question.options?.find(candidate => getOptionId(candidate) === selected?.optionId)
      const manual = Boolean(option?.manual)
      const answer = manual ? selected?.manualText.trim() || '' : option?.description || option?.label || ''
      return {
        questionId,
        question: question.question,
        selectedOptionId: option?.id,
        selectedOptionLabel: option?.label,
        manual,
        answer,
      }
    })
    onSubmit(answers)
  }

  return (
    <div
      className='mx-1 rounded-[22px] bg-white/45 px-3 py-2.5 backdrop-blur-xl animate-in fade-in slide-in-from-bottom-1 duration-200 dark:bg-black/20'
      style={panelStyle}
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <span
              className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:bg-orange-500/15 dark:text-orange-200'
              style={selectedOptionStyle}
              aria-hidden='true'
            >
              <CircleHelp size={16} strokeWidth={2.25} />
            </span>
            <div className='min-w-0'>
              <h3 className='text-sm font-semibold text-neutral-800 dark:text-neutral-100' style={titleStyle}>
                Plan clarification
              </h3>
              <p className='mt-0.5 text-[11px] leading-4 text-neutral-500 dark:text-neutral-400' style={mutedTextStyle}>
                Choose how the plan should continue.
              </p>
            </div>
          </div>
        </div>
        <span
          className='shrink-0 rounded-full bg-neutral-200/70 px-2 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-neutral-800/70 dark:text-neutral-300'
          style={badgeStyle}
        >
          {questions.length} question{questions.length === 1 ? '' : 's'}
        </span>
      </div>

      <div
        className='mt-2 max-h-72 space-y-2 overflow-y-auto rounded-[18px] bg-white/35 p-1.5 pr-2 thin-scrollbar dark:bg-black/15'
        style={innerStyle}
      >
        {questions.map((question, questionIndex) => {
          const questionId = question.id || question.question
          const selected = selectionByQuestionId[questionId]
          const manualOption = question.options!.find(option => option.manual)!

          return (
            <div key={questionId} className='rounded-2xl px-1.5 py-1.5'>
              <div className='flex items-start gap-2.5'>
                <span
                  className='mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200/80 text-[10px] font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
                  style={badgeStyle}
                >
                  {questionIndex + 1}
                </span>
                <div className='min-w-0 flex-1'>
                  <p className='text-sm font-medium leading-5 text-neutral-800 dark:text-neutral-100' style={titleStyle}>
                    {question.question}
                  </p>
                  {question.description && (
                    <p className='mt-0.5 text-xs leading-4 text-neutral-500 dark:text-neutral-400' style={mutedTextStyle}>
                      {question.description}
                    </p>
                  )}
                </div>
              </div>

              <div className='mt-2 space-y-1'>
                {(question.options || []).map(option => {
                  const optionId = getOptionId(option)
                  const checked = selected?.optionId === optionId
                  return (
                    <button
                      key={optionId}
                      type='button'
                      onClick={() => updateSelection(questionId, option)}
                      aria-pressed={checked}
                      className={`w-full rounded-2xl px-2.5 py-2 text-left transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70 active:scale-[0.99] ${
                        checked
                          ? 'bg-blue-500/10 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100'
                          : 'bg-transparent text-neutral-700 hover:bg-white/45 dark:text-neutral-200 dark:hover:bg-white/5'
                      }`}
                      style={checked ? selectedOptionStyle : undefined}
                    >
                      <div className='flex items-start gap-2'>
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full transition-colors ${
                            checked ? 'bg-current' : 'bg-neutral-300 dark:bg-neutral-600'
                          }`}
                        />
                        <span className='min-w-0'>
                          <span className='block text-[13px] font-medium leading-4'>{option.label}</span>
                          {option.description && (
                            <span
                              className={`mt-0.5 block text-[11px] leading-4 ${
                                checked
                                  ? 'text-current opacity-75'
                                  : 'text-neutral-500 dark:text-neutral-400'
                              }`}
                              style={!checked ? mutedTextStyle : undefined}
                            >
                              {option.description}
                            </span>
                          )}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>

              <textarea
                rows={1}
                aria-label={`Your answer: ${question.question}`}
                value={selected?.manualText || ''}
                ref={element => {
                  if (!element) return
                  element.style.height = 'auto'
                  element.style.height = `${element.scrollHeight}px`
                }}
                onChange={event => updateManualText(questionId, getOptionId(manualOption), event.target.value)}
                placeholder='Write your own answer...'
                className='mt-2 max-h-[76px] w-full resize-none overflow-y-auto rounded-2xl border-0 bg-white/55 px-3 py-2 text-sm leading-5 text-neutral-800 outline-none backdrop-blur-xl transition-colors placeholder:text-neutral-400 focus:bg-white/75 focus:ring-2 focus:ring-blue-400/30 dark:bg-black/20 dark:text-neutral-100 dark:focus:bg-black/30 dark:focus:ring-orange-400/25'
                style={manualInputStyle}
              />
            </div>
          )
        })}
      </div>

      <div className='mt-2 flex items-center justify-end gap-1.5'>
        <button
          type='button'
          onClick={onCancel}
          className='rounded-full px-3 py-1.5 text-xs font-medium text-neutral-500 transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70 hover:bg-white/45 hover:text-neutral-800 active:scale-95 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100'
          style={secondaryButtonStyle}
        >
          Cancel
        </button>
        <button
          type='button'
          onClick={handleSubmit}
          disabled={!canSubmit}
          className='rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-[background-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 dark:focus-visible:ring-orange-400/70 hover:bg-blue-500 active:scale-95 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500'
          style={canSubmit ? primaryButtonStyle : secondaryButtonStyle && { ...secondaryButtonStyle, opacity: 0.5 }}
        >
          Submit answers
        </button>
      </div>
    </div>
  )
}

const canSubmitStyle = (customTheme: ReturnType<typeof useCustomChatTheme>['theme'], isDarkMode: boolean): React.CSSProperties => ({
  backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonBg, isDarkMode),
  color: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonText, isDarkMode),
})
