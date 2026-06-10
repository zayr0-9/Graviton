import React, { useMemo, useState } from 'react'
import type {
  PlanClarificationAnswer,
  PlanClarificationOption,
  PlanClarificationRequest,
} from '../../features/chats/planToolTypes'

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

export const PlanClarificationPanel: React.FC<PlanClarificationPanelProps> = ({ request, onSubmit, onCancel }) => {
  const [selectionByQuestionId, setSelectionByQuestionId] = useState<SelectionState>({})

  const questions = request.questions

  const canSubmit = useMemo(() => {
    return questions.every(question => {
      const questionId = question.id || question.question
      const selected = selectionByQuestionId[questionId]
      if (!selected?.optionId) return false
      const option = question.options?.find(candidate => candidate.id === selected.optionId)
      if (option?.manual) return selected.manualText.trim().length > 0
      return Boolean(option)
    })
  }, [questions, selectionByQuestionId])

  const updateSelection = (questionId: string, option: PlanClarificationOption) => {
    setSelectionByQuestionId(prev => ({
      ...prev,
      [questionId]: {
        optionId: option.id || option.label,
        manualText: prev[questionId]?.manualText || '',
      },
    }))
  }

  const updateManualText = (questionId: string, manualText: string) => {
    setSelectionByQuestionId(prev => ({
      ...prev,
      [questionId]: {
        optionId: prev[questionId]?.optionId || 'manual',
        manualText,
      },
    }))
  }

  const handleSubmit = () => {
    const answers: PlanClarificationAnswer[] = questions.map(question => {
      const questionId = question.id || question.question
      const selected = selectionByQuestionId[questionId]
      const option = question.options?.find(candidate => candidate.id === selected?.optionId)
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
    <div className='mx-1 rounded-[18px] border border-blue-200/80 dark:border-blue-500/25 bg-blue-50/80 dark:bg-blue-950/20 px-3 py-2 backdrop-blur-sm shadow-[0_12px_32px_-18px_rgba(59,130,246,0.55)]'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <i className='bx bx-git-branch text-lg text-blue-600 dark:text-blue-300' aria-hidden='true'></i>
            <h3 className='text-sm font-semibold text-neutral-800 dark:text-neutral-100'>Plan clarification</h3>
          </div>
          <p className='mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400'>
            The model needs a few choices before it continues the plan.
          </p>
        </div>
        <span className='shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-200'>
          {questions.length} question{questions.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className='mt-2 max-h-72 space-y-2 overflow-y-auto rounded-2xl bg-white/55 p-1.5 pr-2 thin-scrollbar dark:bg-neutral-950/20'>
        {questions.map((question, questionIndex) => {
          const questionId = question.id || question.question
          const selected = selectionByQuestionId[questionId]
          const selectedOption = question.options?.find(option => option.id === selected?.optionId)
          const manualSelected = Boolean(selectedOption?.manual)

          return (
            <div key={questionId} className='rounded-xl px-1.5 py-1 dark:bg-transparent'>
              <div className='flex items-start gap-2'>
                <span className='mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white dark:bg-blue-500'>
                  {questionIndex + 1}
                </span>
                <div className='min-w-0 flex-1'>
                  <p className='text-sm font-medium text-neutral-800 dark:text-neutral-100'>{question.question}</p>
                  {question.description && (
                    <p className='mt-0.5 text-xs text-neutral-500 dark:text-neutral-400'>{question.description}</p>
                  )}
                </div>
              </div>

              <div className='mt-1.5 space-y-0.5'>
                {(question.options || []).map(option => {
                  const optionId = option.id || option.label
                  const checked = selected?.optionId === optionId
                  return (
                    <button
                      key={optionId}
                      type='button'
                      onClick={() => updateSelection(questionId, option)}
                      className={`w-full rounded-lg px-1.5 py-1 text-left transition-colors ${
                        checked
                          ? 'bg-blue-100/70 dark:bg-blue-500/15'
                          : 'bg-transparent hover:bg-blue-50/60 dark:hover:bg-blue-500/10'
                      }`}
                    >
                      <div className='flex items-start gap-1.5'>
                        <span
                          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                            checked ? 'bg-blue-600 dark:bg-blue-300' : 'bg-neutral-300 dark:bg-neutral-600'
                          }`}
                        />
                        <span className='min-w-0'>
                          <span className='block text-[13px] font-medium text-neutral-800 dark:text-neutral-100'>
                            {option.label}
                          </span>
                          {option.description && (
                            <span className='block text-[11px] leading-4 text-neutral-500 dark:text-neutral-400'>
                              {option.description}
                            </span>
                          )}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>

              {manualSelected && (
                <textarea
                  value={selected?.manualText || ''}
                  onChange={event => updateManualText(questionId, event.target.value)}
                  placeholder='Tell the model what you want instead...'
                  className='mt-1.5 min-h-18 w-full resize-y rounded-xl border-0 bg-white/70 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:bg-white dark:bg-neutral-950/40 dark:text-neutral-100 dark:focus:bg-neutral-950/60'
                />
              )}
            </div>
          )
        })}
      </div>

      <div className='mt-2 flex items-center justify-end gap-2'>
        <button
          type='button'
          onClick={onCancel}
          className='rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
        >
          Cancel
        </button>
        <button
          type='button'
          onClick={handleSubmit}
          disabled={!canSubmit}
          className='rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500'
        >
          Submit answers
        </button>
      </div>
    </div>
  )
}
