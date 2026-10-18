import React from 'react'
import type { Components, ExtraProps } from 'react-markdown'

/** Apply scrollbar styling to the scrolling pre itself, not just its parent. */
export const MarkdownCodeBlock: React.FC<React.HTMLAttributes<HTMLPreElement> & ExtraProps> = ({
  node: _node,
  className = '',
  ...props
}) => {
  void _node
  return <pre {...props} className={`thin-scrollbar ${className}`.trim()} />
}

export const SCROLLABLE_MARKDOWN_COMPONENTS: Components = { pre: MarkdownCodeBlock }
