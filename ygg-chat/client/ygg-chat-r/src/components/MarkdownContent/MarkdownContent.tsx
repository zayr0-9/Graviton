import React from 'react'
import ReactMarkdown, { type ExtraProps } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { SHARED_TEXT_MARKDOWN_CLASS } from '../ChatMessage/chatMessageShared'
import { MermaidDiagram, getMermaidSource, isMermaidCodeBlock, prepareMermaidMarkdown } from '../MermaidDiagram'
import { MarkdownTable } from './MarkdownTable'
import { getMarkdownThemeVars, useCustomChatTheme, useHtmlDarkMode } from '../ThemeManager/themeConfig'

interface MarkdownContentProps {
  content: string
  className?: string
  style?: React.CSSProperties
}

const MarkdownPre: React.FC<React.HTMLAttributes<HTMLPreElement> & ExtraProps> = ({ node: _node, children, ...props }) => {
  // ReactMarkdown's syntax-tree node is not a native DOM attribute.
  void _node
  const codeChild = React.Children.toArray(children).find(isMermaidCodeBlock)
  if (codeChild) return <MermaidDiagram chart={getMermaidSource(codeChild)} />
  return <pre {...props}>{children}</pre>
}

const MARKDOWN_COMPONENTS = { pre: MarkdownPre, table: MarkdownTable }

/**
 * Shared compact Markdown renderer for read-only app surfaces such as plans and conversation previews.
 * It deliberately does not enable raw HTML.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className = '', style }) => {
  const { theme, enabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()
  const themeStyle = enabled ? getMarkdownThemeVars(theme, isDarkMode) : undefined

  return (
    <div
      className={`${SHARED_TEXT_MARKDOWN_CLASS} !pb-0 !text-[0.8125em] sm:!text-[0.8125em] xl:!text-[0.8125em] 2xl:!text-[0.8125em] 3xl:!text-[0.8125em] ${className}`}
      style={{ ...themeStyle, ...style }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
        components={MARKDOWN_COMPONENTS}
      >
        {prepareMermaidMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
}

export default MarkdownContent
