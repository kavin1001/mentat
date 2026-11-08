import { useRef, useState } from 'react'
import type { ChatMessage } from '../../shared/types'
import { api } from './api'
import { Markdown } from './Markdown'

const MEETING_SUGGESTIONS = ['What are my action items?', 'Summarise what they said about timelines', 'Write a TL;DR for Slack', 'What questions went unanswered?']
const ALL_SUGGESTIONS = ['What did I commit to this week?', 'Which customers mentioned pricing?', 'Summarise my meetings from yesterday', 'Prep me for my next call']

export function ChatPanel({ scope, placeholder, onError }: { scope: { meetingId?: string }; placeholder: string; onError: (m: string) => void }) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const ask = async (q: string) => {
    if (!q.trim() || busy) return
    const next: ChatMessage[] = [...history, { role: 'user', content: q.trim() }]
    setHistory([...next, { role: 'assistant', content: '' }])
    setInput('')
    setBusy(true)
    try {
      let acc = ''
      const final = await api.ai.chat(next, scope, (d) => {
        acc += d
        setHistory([...next, { role: 'assistant', content: acc }])
        endRef.current?.scrollIntoView({ block: 'end' })
      })
      setHistory([...next, { role: 'assistant', content: final || acc }])
    } catch (e) {
      onError((e as Error).message)
      setHistory(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chat">
      <div className="chat-log">
        {!history.length && (
          <div className="suggestions">
            {(scope.meetingId ? MEETING_SUGGESTIONS : ALL_SUGGESTIONS).map((s) => (
              <button key={s} className="chip" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === 'assistant' ? m.content ? <Markdown text={m.content} /> : <span className="muted">Thinking…</span> : m.content}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(input)
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={placeholder} disabled={busy} />
        <button className="btn primary" disabled={busy || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  )
}
