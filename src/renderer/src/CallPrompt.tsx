// The small "call detected" card that floats in the corner of the screen.
import { useEffect, useState } from 'react'

const inv = <T,>(ch: string) => window.mentat.invoke(ch) as Promise<T>

export function CallPrompt() {
  const [info, setInfo] = useState<{ app: string; title: string | null } | null>(null)
  useEffect(() => {
    document.body.classList.add('call-prompt-body')
    void inv<{ app: string; title: string | null } | null>('call:info').then(setInfo)
  }, [])
  if (!info) return null
  return (
    <div className="call-prompt">
      <div className="call-prompt-text">
        <strong>{info.title ?? `${info.app} call`}</strong>
        <span className="muted small">{info.title ? `${info.app} call` : 'Take notes with Mentat?'}</span>
      </div>
      <div className="call-prompt-actions">
        <button className="btn" onClick={() => void inv('call:dismiss')}>
          Not now
        </button>
        <button className="btn primary" onClick={() => void inv('call:accept')}>
          Take notes
        </button>
      </div>
    </div>
  )
}
