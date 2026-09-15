import React from 'react'

const normalizeMermaidSource = (children: React.ReactNode): string =>
  React.Children.toArray(children)
    .map(child => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
    .replace(/\n$/, '')

export const isMermaidCodeBlock = (
  node: React.ReactNode
): node is React.ReactElement<{ className?: string; children?: React.ReactNode }> =>
  React.isValidElement<{ className?: string; children?: React.ReactNode }>(node) &&
  /(?:^|\s)language-mermaid(?:\s|$)/i.test(node.props.className ?? '')

export const getMermaidSource = (node: React.ReactNode): string => {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return ''
  return normalizeMermaidSource(node.props.children)
}

interface OpenFence {
  marker: '`' | '~'
  length: number
  mermaidLanguageOffset: number | null
  mermaidLanguageLength: number
}

const parseFenceLine = (line: string) => {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/)
  if (!match) return null

  const marker = match[2][0] as '`' | '~'
  const info = match[3]
  // CommonMark does not treat a backtick fence with backticks in its info string as an opening fence.
  if (marker === '`' && info.includes('`')) return null

  return { indentation: match[1], fence: match[2], marker, info }
}

/**
 * Prevents ReactMarkdown from treating an unterminated Mermaid fence as renderable while text streams.
 * Completed fences are returned byte-for-byte unchanged. Only an unmatched Mermaid opener at EOF has
 * its language changed to `mermaid-pending`, which keeps it in the ordinary code-block renderer until
 * a matching closing fence arrives in a later text delta.
 */
export const prepareMermaidMarkdown = (markdown: string): string => {
  let openFence: OpenFence | null = null
  let offset = 0
  const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []

  for (const lineWithEnding of lines) {
    if (!lineWithEnding) continue
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/, '')
    const parsed = parseFenceLine(line)

    if (openFence) {
      const isClosingFence =
        parsed !== null &&
        parsed.marker === openFence.marker &&
        parsed.fence.length >= openFence.length &&
        /^[ \t]*$/.test(parsed.info)
      if (isClosingFence) openFence = null
    } else if (parsed) {
      const leadingWhitespaceLength = parsed.info.match(/^[ \t]*/)?.[0].length ?? 0
      const language = parsed.info.slice(leadingWhitespaceLength).match(/^[^\s]+/)?.[0] ?? ''
      const isMermaid = /^mermaid$/i.test(language)
      const languageOffset =
        offset + parsed.indentation.length + parsed.fence.length + leadingWhitespaceLength

      openFence = {
        marker: parsed.marker,
        length: parsed.fence.length,
        mermaidLanguageOffset: isMermaid ? languageOffset : null,
        mermaidLanguageLength: isMermaid ? language.length : 0,
      }
    }

    offset += lineWithEnding.length
  }

  if (openFence?.mermaidLanguageOffset === null || !openFence) return markdown
  const start = openFence.mermaidLanguageOffset
  const end = start + openFence.mermaidLanguageLength
  return `${markdown.slice(0, start)}mermaid-pending${markdown.slice(end)}`
}
