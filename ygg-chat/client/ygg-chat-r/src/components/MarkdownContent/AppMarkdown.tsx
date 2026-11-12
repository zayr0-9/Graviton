import { useMemo } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import { MarkdownLink, markdownUrlTransform } from '../MarkdownLink/MarkdownLink'

const componentsWithLink = new WeakMap<Components, Components>()
const LINK_ONLY: Components = { a: MarkdownLink }

/** Adds MarkdownLink once per component map, so memoized maps keep a stable identity. */
function withMarkdownLink(components: Components | null | undefined): Components {
  if (!components) return LINK_ONLY
  let merged = componentsWithLink.get(components)
  if (!merged) {
    merged = { ...components, a: MarkdownLink }
    componentsWithLink.set(components, merged)
  }
  return merged
}

/**
 * The only ReactMarkdown entry point in the app. Every surface (chat, agents pill, subagent
 * transcripts, Heimdall, plans, settings, diffs) gets the same link sanitizer and the same click
 * handling, so a link can never navigate the Electron window itself.
 */
export function AppMarkdown({ components, urlTransform: _ignored, ...props }: Options) {
  void _ignored
  const merged = useMemo(() => withMarkdownLink(components), [components])
  return <ReactMarkdown {...props} components={merged} urlTransform={markdownUrlTransform} />
}

export default AppMarkdown
