import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'

export const STREAMING_THINKING_WORDS = [
  'Thinking',
  'Reading',
  'Tracing',
  'Checking',
  'Reviewing',
  'Inspecting',
  'Planning',
  'Composing',
  'Working',
]
export const STREAMING_THINKING_WORD_INTERVAL_MS = 3200

/** Shared cadence for the legacy indicator and attached agent activity. */
export function useStreamingThinkingWord(enabled = true) {
  const [wordIndex, setWordIndex] = useState(0)
  const shouldReduceMotion = useReducedMotion()
  useEffect(() => {
    if (!enabled || shouldReduceMotion || typeof window === 'undefined') return
    const intervalId = window.setInterval(() => {
      setWordIndex(previous => (previous + 1) % STREAMING_THINKING_WORDS.length)
    }, STREAMING_THINKING_WORD_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [enabled, shouldReduceMotion])
  return STREAMING_THINKING_WORDS[wordIndex]
}
