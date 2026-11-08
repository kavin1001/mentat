import { Fragment, type ReactNode } from 'react'

// Small, safe Markdown renderer (headings, bullets, bold, italics, code) for Claude's replies.
function inline(s: string): ReactNode[] {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return <em key={i}>{p.slice(1, -1)}</em>
    return <Fragment key={i}>{p}</Fragment>
  })
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let list: ReactNode[] = []
  const flush = () => {
    if (list.length) blocks.push(<ul key={`ul${blocks.length}`}>{list}</ul>)
    list = []
  }
  text.split('\n').forEach((line, i) => {
    const li = line.match(/^\s*(?:[-*]|\d+\.) (.*)$/)
    if (li) {
      list.push(<li key={i}>{inline(li[1])}</li>)
      return
    }
    flush()
    const h = line.match(/^(#{1,4}) (.*)$/)
    if (h) blocks.push(<h4 key={i}>{inline(h[2])}</h4>)
    else if (line.startsWith('> ')) blocks.push(<blockquote key={i}>{inline(line.slice(2))}</blockquote>)
    else if (line.trim()) blocks.push(<p key={i}>{inline(line)}</p>)
  })
  flush()
  return <div className="md">{blocks}</div>
}
