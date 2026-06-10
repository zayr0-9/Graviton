export type PlanAction = 'create' | 'list' | 'read' | 'edit' | 'display' | 'clarify'

export const DEFAULT_PLAN_MANUAL_OPTION_LABEL = 'None of the above — tell Ygg what to do instead'

export interface PlanClarificationOption {
  id?: string
  label: string
  description?: string
  manual?: boolean
}

export interface PlanClarificationQuestion {
  id?: string
  question: string
  description?: string
  options?: PlanClarificationOption[]
  manualLabel?: string
}

export interface PlanClarificationAnswer {
  questionId: string
  question: string
  selectedOptionId?: string
  selectedOptionLabel?: string
  manual?: boolean
  answer: string
}

export interface PlanClarificationResult {
  clarified: boolean
  cancelled?: boolean
  questions: number
  answers: PlanClarificationAnswer[]
}

export interface PlanClarificationRequest {
  id: string
  questions: PlanClarificationQuestion[]
  conversationId?: string
  messageId?: string
  streamId?: string
  toolCallId?: string
}

function normalizeQuestionId(raw: string | undefined, index: number): string {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `question-${index + 1}`
}

function normalizeOptionId(raw: string | undefined, label: string, index: number): string {
  const normalized = String(raw || label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || `option-${index + 1}`
}

export function normalizePlanClarificationQuestions(
  questions: PlanClarificationQuestion[] | undefined
): PlanClarificationQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('questions must be a non-empty array for plan_md clarify action')
  }

  return questions.map((question, questionIndex) => {
    const text = String(question?.question || '').trim()
    if (!text) throw new Error(`questions[${questionIndex}].question is required`)

    const options = Array.isArray(question.options) ? question.options : []
    const normalizedOptions: PlanClarificationOption[] = options.map((option, optionIndex) => {
      const label = String(option?.label || '').trim()
      if (!label) throw new Error(`questions[${questionIndex}].options[${optionIndex}].label is required`)
      return {
        id: normalizeOptionId(option.id, label, optionIndex),
        label,
        ...(option.description ? { description: String(option.description) } : {}),
      }
    })

    const manualLabel =
      String(question.manualLabel || DEFAULT_PLAN_MANUAL_OPTION_LABEL).trim() || DEFAULT_PLAN_MANUAL_OPTION_LABEL
    normalizedOptions.push({ id: 'manual', label: manualLabel, manual: true })

    return {
      id: normalizeQuestionId(question.id, questionIndex),
      question: text,
      ...(question.description ? { description: String(question.description) } : {}),
      options: normalizedOptions,
    }
  })
}
