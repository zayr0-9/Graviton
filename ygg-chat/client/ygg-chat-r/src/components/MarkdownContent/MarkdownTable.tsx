import type { ComponentProps } from 'react'
import type { ExtraProps } from 'react-markdown'

/** Keep native table semantics and GFM alignment inside a keyboard-scrollable surface. */
export const MarkdownTable = ({ node: _node, children, ...props }: ComponentProps<'table'> & ExtraProps) => {
  // ReactMarkdown's syntax-tree node is not a native DOM attribute.
  void _node
  return (
    <div
      className='chat-markdown-table-scroll thin-scrollbar'
      tabIndex={0}
      role='region'
      aria-label='Markdown table'
    >
      <table {...props}>{children}</table>
    </div>
  )
}
