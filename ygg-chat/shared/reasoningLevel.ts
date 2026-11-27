/**
 * A branch's chosen reasoning level, recorded as `meta.reasoningLevel` on the rows a run
 * persists. It is the user's choice for the branch, kept even while the selected model
 * cannot think, so switching back to a thinking model restores it.
 */
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

export const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value)
