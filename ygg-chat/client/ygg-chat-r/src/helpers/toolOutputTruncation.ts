export const TOOL_OUTPUT_TRUNCATION_ENABLED_KEY = 'chat:truncateToolOutput'
export const TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT = 'chat:truncateToolOutputChange'
export const TOOL_OUTPUT_PREVIEW_CHARACTER_LIMIT = 2_000

export type TruncatedToolOutput = {
  text: string
  truncated: boolean
  omittedCharacters: number
}

export const loadToolOutputTruncationEnabled = (): boolean => {
  try {
    const stored = localStorage.getItem(TOOL_OUTPUT_TRUNCATION_ENABLED_KEY)
    if (stored === 'true') return true
    if (stored === 'false') return false
  } catch {
    // Fall through to the default when storage is unavailable.
  }
  return true
}

export const saveToolOutputTruncationEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(TOOL_OUTPUT_TRUNCATION_ENABLED_KEY, String(enabled))
    window.dispatchEvent(new CustomEvent<boolean>(TOOL_OUTPUT_TRUNCATION_CHANGE_EVENT, { detail: enabled }))
  } catch {
    // The Settings pane keeps its in-memory state when storage is unavailable.
  }
}

export const truncateToolOutput = (
  value: string,
  limit: number = TOOL_OUTPUT_PREVIEW_CHARACTER_LIMIT
): TruncatedToolOutput => {
  const characters = Array.from(value)
  const safeLimit = Math.max(0, Math.floor(limit))

  if (characters.length <= safeLimit) {
    return { text: value, truncated: false, omittedCharacters: 0 }
  }

  const headLength = Math.ceil(safeLimit / 2)
  const tailLength = Math.floor(safeLimit / 2)
  const omittedCharacters = characters.length - safeLimit
  const marker = `\n… ${omittedCharacters.toLocaleString('en-US')} characters omitted …\n`
  const head = characters.slice(0, headLength).join('')
  const tail = tailLength > 0 ? characters.slice(-tailLength).join('') : ''

  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    omittedCharacters,
  }
}
