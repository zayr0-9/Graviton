import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { SHARED_TEXT_MARKDOWN_CLASS } from '../ChatMessage/chatMessageShared'

interface MarkdownContentProps {
  content: string
  className?: string
  style?: React.CSSProperties
}

/**
 * Shared compact Markdown renderer for read-only app surfaces such as plans and conversation previews.
 * It deliberately does not enable raw HTML.
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className = '', style }) => (
  <div
    className={`${SHARED_TEXT_MARKDOWN_CLASS} !pb-0 !text-[0.8125em] sm:!text-[0.8125em] xl:!text-[0.8125em] 2xl:!text-[0.8125em] 3xl:!text-[0.8125em] ${className}`}
    style={style}
  >
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
      {content}
    </ReactMarkdown>
  </div>
)

export default MarkdownContent
