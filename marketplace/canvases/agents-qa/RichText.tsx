import type { ReactNode } from 'react'
import { parseBlocks, parseInline, type Inline } from './markdown.ts'

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'code':
        return <code key={index}>{node.text}</code>
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>
      case 'link':
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" title={node.href}>
            {renderInline(node.children)}
          </a>
        )
    }
  })
}

/** Inline Markdown only, for one-line fields. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{renderInline(parseInline(text))}</>
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      {parseBlocks(text).map((block, index) => {
        switch (block.kind) {
          case 'p':
            return <p key={index}>{renderInline(parseInline(block.lines.join(' ')))}</p>
          case 'code':
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            )
          case 'ul':
          case 'ol': {
            const List = block.kind
            return (
              <List key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(parseInline(item))}</li>
                ))}
              </List>
            )
          }
        }
      })}
    </div>
  )
}
