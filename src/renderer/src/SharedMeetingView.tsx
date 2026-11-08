// A meeting someone shared with you through a workspace. Read-only: the notes belong to them.
import { useEffect, useState } from 'react'
import type { Meeting } from '../../shared/types'
import { fmtTime, transcriptTurns } from '../../shared/format'
import { wsApi } from './wsApi'

export function SharedMeetingView({ workspaceId, workspaceName, id }: { workspaceId: string; workspaceName: string; id: string }) {
  const [m, setM] = useState<Meeting | null | undefined>(undefined)
  const [tab, setTab] = useState<'enhanced' | 'notes'>('enhanced')
  const [showTranscript, setShowTranscript] = useState(true)

  useEffect(() => {
    void wsApi.meeting(workspaceId, id).then(setM)
  }, [workspaceId, id])

  if (m === undefined) return <div className="page muted">Loading…</div>
  if (m === null) return <div className="page muted">This meeting is no longer shared with you.</div>

  const turns = transcriptTurns(m.transcript)
  const when = new Date(m.startedAt ?? m.createdAt)
  const showEnhanced = tab === 'enhanced' && m.enhanced
  // In a shared meeting "Me" is whoever recorded it.
  const who = (label: string) => (label === 'Me' ? (m.sharedBy ?? 'Them') : label)

  return (
    <div className="meeting">
      <div className="meeting-doc">
        <header className="meeting-header">
          <h1 className="title-input">{m.title}</h1>
          <div className="meta-row">
            <span className="pill">{when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            <span className="pill">
              Shared in {workspaceName}
              {m.sharedBy ? ` by ${m.sharedBy}` : ''}
            </span>
            {m.attendees.slice(0, 5).map((a) => (
              <span key={a.email} className="pill" title={a.email}>
                {a.name ?? a.email.split('@')[0]}
              </span>
            ))}
            <div className="spacer" />
            <button className={`btn ghost ${showTranscript ? 'active' : ''}`} onClick={() => setShowTranscript(!showTranscript)}>
              Transcript {turns.length ? `(${turns.length})` : ''}
            </button>
          </div>
          <div className="tabs">
            {m.enhanced && (
              <button className={tab === 'enhanced' ? 'active' : ''} onClick={() => setTab('enhanced')}>
                Enhanced notes
              </button>
            )}
            <button className={tab === 'notes' || !m.enhanced ? 'active' : ''} onClick={() => setTab('notes')}>
              {m.sharedBy ? `${m.sharedBy}’s notes` : 'Notes'}
            </button>
          </div>
        </header>
        {showEnhanced ? (
          <article className="enhanced">
            <p className="summary">{m.enhanced!.summary}</p>
            {m.enhanced!.sections
              .filter((s) => s.bullets.length)
              .map((s) => (
                <section key={s.heading}>
                  <h3>{s.heading}</h3>
                  <ul>
                    {s.bullets.map((b, i) => (
                      <li key={i} className={b.origin}>
                        {b.text}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            {m.enhanced!.actionItems.length > 0 && (
              <section>
                <h3>Action items</h3>
                <ul>
                  {m.enhanced!.actionItems.map((a, i) => (
                    <li key={i}>
                      {a.owner && <strong>{a.owner}: </strong>}
                      {a.text}
                      {a.due && <span className="muted"> · {a.due}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </article>
        ) : (
          <article className="enhanced" style={{ whiteSpace: 'pre-wrap' }}>
            {m.notes.trim() || <span className="muted">No notes.</span>}
          </article>
        )}
      </div>
      {showTranscript && (
        <aside className="side-panel">
          <div className="side-head">
            <strong>Transcript</strong>
          </div>
          <div className="transcript">
            {!turns.length && <p className="muted small">This meeting has no transcript.</p>}
            {turns.map((t, i) => (
              <div key={i} className={`turn ${t.label === 'Me' ? 'me' : 'them'}`}>
                <div className="turn-meta">
                  {who(t.label)} · {fmtTime(t.start)}
                </div>
                <div>{t.text}</div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  )
}
