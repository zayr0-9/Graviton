const sentMessageHistory: string[] = []

export const recordSentMessage = (content: string): void => {
  if (!content.trim()) return
  sentMessageHistory.push(content)
}

export const getSentMessageHistory = (): readonly string[] => Object.freeze([...sentMessageHistory])

export const clearSentMessageHistoryForTests = (): void => {
  sentMessageHistory.length = 0
}
