import { useEffect, useRef, useState } from 'react'
import type { Folder, Meeting, Speaker, Template } from '../../shared/types'
import { fmtTime, transcriptTurns } from '../../shared/format'
import { api } from './api'
import { startCapture, type CaptureHandle } from './audio'
import { ChatPanel } from './ChatPanel'

interface Props {
  id: string
  autoRecord?: boolean
  folders: Folder[]
  onChanged: () => void
  onDeleted: () => void
  onError: (msg: string) => void
}

export function MeetingView({ id, autoRecord, folders, onChanged, onDeleted, onError }: Props) {
  const [m, setM] = useState<Meeting | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateId, setTemplateId] = useState<string>('')
  const [tab, setTab] = useState<'notes' | 'enhanced'>('notes')
  const [panel, setPanel] = useState<'transcript' | 'chat' | null>(null)
  const [recording, setRecording] = useState(false)
  const [systemAudio, setSystemAudio] = useState(true)
  const [levels, setLevels] = useState<[number, number]>([0, 0])
  const [partial, setPartial] = useState<Record<Speaker, string>>({ me: '', them: '' })
  const [enhancing, setEnhancing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const capture = useRef<CaptureHandle | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    void (async () => {
      const meeting = await api.meetings.get(id)
      setM(meeting)
      if (meeting?.enhanced) setTab('enhanced')
      const ts = await api.templates.list()
      setTemplates(ts)
      const s = await api.settings.get()
      setTemplateId(meeting?.enhanced?.templateId ?? s.defaultTemplateId)
      const status = await api.recording.status()
      if (status?.meetingId === id) setRecording(true)
      else if (autoRecord) void start()
    })()
    const offs = [
      api.events.onFinal((mid, seg) => {
        if (mid !== id) return
        setM((prev) => (prev ? { ...prev, transcript: [...prev.transcript, seg] } : prev))
        setPartial((p) => ({ ...p, [seg.speaker]: '' }))
      }),
      api.events.onPartial((mid, speaker, text) => mid === id && setPartial((p) => ({ ...p, [speaker]: text })))
    ]
    return () => {
      offs.forEach((o) => o())
      clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Stop capture if the user navigates away mid-recording.
  useEffect(() => () => capture.current?.stop(), [])

  const patch = (p: Partial<Meeting>, debounce = false) => {
    setM((prev) => (prev ? { ...prev, ...p } : prev))
    clearTimeout(saveTimer.current)
    const run = () => api.meetings.update(id, p).then(onChanged)
    if (debounce) saveTimer.current = setTimeout(run, 600)
    else void run()
  }

  const start = async () => {
    try {
      await api.app.permissions()
      await api.recording.start(id)
      capture.current = await startCapture((a, b) => setLevels([a, b]))
      setSystemAudio(capture.current.hasSystemAudio)
      setRecording(true)
    } catch (e) {
      onError((e as Error).message)
      await api.recording.stop()
    }
  }

  const stop = async () => {
    capture.current?.stop()
    capture.current = null
    await api.recording.stop()
    setRecording(false)
    setLevels([0, 0])
    setPartial({ me: '', them: '' })
  }

  const enhance = async () => {
    if (recording) await stop()
    setEnhancing(true)
    try {
      // Give the transcriber a moment to deliver its last segments.
      await new Promise((r) => setTimeout(r, recording ? 4000 : 0))
      const updated = await api.ai.enhance(id, templateId)
      setM(updated)
      setTab('enhanced')
      onChanged()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setEnhancing(false)
    }
  }

  const act = async (fn: () => Promise<unknown>) => {
    setMenu(false)
    try {
      await fn()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  if (!m) return <div className="page muted">Loading…</div>

  const turns = transcriptTurns(m.transcript)
  const when = new Date(m.startedAt ?? m.createdAt)

  return (
    <div className="meeting">
      <div className="meeting-doc">
        <header className="meeting-header">
          <input className="title-input" value={m.title} onChange={(e) => patch({ title: e.target.value }, true)} />
          <div className="meta-row">
            <span className="pill">{when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            {m.attendees.slice(0, 5).map((a) => (
              <span key={a.email} className="pill" title={a.email}>
                {a.name ?? a.email.split('@')[0]}
              </span>
            ))}
            {m.attendees.length > 5 && <span className="pill">+{m.attendees.length - 5}</span>}
            <select
              className="pill select"
              value={m.folderIds[0] ?? ''}
              onChange={(e) => patch({ folderIds: e.target.value ? [e.target.value] : [] })}
            >
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {m.drive && (
              <a className="pill link" href={m.drive.webViewLink} target="_blank" rel="noreferrer">
                Google Doc ↗
              </a>
            )}
            <div className="spacer" />
            <div className="menu-wrap">
              <button className="btn ghost" onClick={() => setMenu(!menu)}>
                ⋯
              </button>
              {menu && (
                <div className="menu">
                  <button onClick={() => act(async () => setM(await api.drive.sync(id)))}>Sync to Google Drive</button>
                  <button
                    onClick={() =>
                      act(async () => {
                        const emails = confirm('Also email a view link to the attendees?') ? m.attendees.map((a) => a.email) : []
                        const updated = await api.drive.share(id, emails)
                        setM(updated)
                        await navigator.clipboard.writeText(updated.drive!.webViewLink)
                        onError('Share link copied to clipboard.')
                      })
                    }
                  >
                    Share link (Google Doc)
                  </button>
                  <button onClick={() => act(async () => setEmail(await api.ai.followUp(id)))}>Draft follow-up email</button>
                  <hr />
                  <button onClick={() => act(() => api.exportMeeting(id, 'md'))}>Export notes + transcript (.md)</button>
                  <button onClick={() => act(() => api.exportMeeting(id, 'txt'))}>Export transcript (.txt)</button>
                  <button onClick={() => act(() => api.exportMeeting(id, 'srt'))}>Export transcript (.srt)</button>
                  <button onClick={() => act(() => api.exportMeeting(id, 'json'))}>Export everything (.json)</button>
                  <hr />
                  <button
                    className="danger"
                    onClick={() =>
                      act(async () => {
                        if (!confirm('Delete this note and its transcript?')) return
                        if (recording) await stop()
                        await api.meetings.remove(id)
                        onDeleted()
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
          {m.enhanced && (
            <div className="tabs">
              <button className={tab === 'enhanced' ? 'active' : ''} onClick={() => setTab('enhanced')}>
                Enhanced notes
              </button>
              <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
                My notes
              </button>
            </div>
          )}
        </header>

        {tab === 'notes' || !m.enhanced ? (
          <textarea
            className="notepad"
            placeholder={'Write notes as the meeting happens…\n\nJust the bits that matter to you. Mentat fills in the rest from the transcript.'}
            value={m.notes}
            onChange={(e) => patch({ notes: e.target.value }, true)}
          />
        ) : (
          <article className="enhanced">
            <p className="summary">{m.enhanced.summary}</p>
            {m.enhanced.sections
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
            {m.enhanced.actionItems.length > 0 && (
              <section>
                <h3>Action items</h3>
                <ul className="todos">
                  {m.enhanced.actionItems.map((a, i) => (
                    <li key={i}>
                      <input type="checkbox" /> {a.owner && <strong>{a.owner}: </strong>}
                      {a.text}
                      {a.due && <span className="muted"> · {a.due}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="legend muted small">
              <span className="dot user" /> from your notes <span className="dot ai" /> added by Claude from the transcript
            </p>
          </article>
        )}

        <div className="dock">
          <button className={`rec ${recording ? 'on' : ''}`} onClick={recording ? stop : start} title={recording ? 'Stop recording' : 'Start recording'}>
            <span className="rec-dot" />
            {recording ? 'Stop' : m.transcript.length ? 'Resume' : 'Record'}
          </button>
          {recording && (
            <div className="levels" title="Me / Them">
              <span style={{ transform: `scaleY(${0.15 + levels[0] * 3})` }} />
              <span className={systemAudio ? '' : 'off'} style={{ transform: `scaleY(${0.15 + levels[1] * 3})` }} />
            </div>
          )}
          {recording && !systemAudio && <span className="small warn">Mic only: allow Screen Recording for system audio</span>}
          <button className={`btn ghost ${panel === 'transcript' ? 'active' : ''}`} onClick={() => setPanel(panel === 'transcript' ? null : 'transcript')}>
            Transcript {m.transcript.length ? `(${turns.length})` : ''}
          </button>
          <button className={`btn ghost ${panel === 'chat' ? 'active' : ''}`} onClick={() => setPanel(panel === 'chat' ? null : 'chat')}>
            Ask Claude
          </button>
          <div className="spacer" />
          <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={enhance} disabled={enhancing || (!m.transcript.length && !m.notes.trim() && !recording)}>
            {enhancing ? 'Enhancing…' : m.enhanced ? 'Regenerate' : '✦ Enhance notes'}
          </button>
        </div>
      </div>

      {panel && (
        <aside className="side-panel">
          <div className="side-head">
            <strong>{panel === 'transcript' ? 'Transcript' : 'Ask about this meeting'}</strong>
            <button className="btn ghost" onClick={() => setPanel(null)}>
              ✕
            </button>
          </div>
          {panel === 'transcript' ? (
            <div className="transcript">
              {!turns.length && !partial.me && !partial.them && <p className="muted small">The full transcript appears here as people talk. It is saved locally and never needs a bot in the call.</p>}
              {turns.map((t, i) => (
                <div key={i} className={`turn ${t.label === 'Me' ? 'me' : 'them'}`}>
                  <div className="turn-meta">
                    {t.label} · {fmtTime(t.start)}
                  </div>
                  <div>{t.text}</div>
                </div>
              ))}
              {(['me', 'them'] as Speaker[]).map(
                (s) =>
                  partial[s] && (
                    <div key={s} className={`turn ${s} partial`}>
                      <div className="turn-meta">{s === 'me' ? 'Me' : 'Them'} · live</div>
                      <div>{partial[s]}</div>
                    </div>
                  )
              )}
            </div>
          ) : (
            <ChatPanel scope={{ meetingId: id }} placeholder="Ask anything about this meeting" onError={onError} />
          )}
        </aside>
      )}

      {email !== null && (
        <div className="modal-backdrop" onClick={() => setEmail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Follow-up email</h3>
            <textarea className="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <div className="row end">
              <button className="btn" onClick={() => setEmail(null)}>
                Close
              </button>
              <button
                className="btn"
                onClick={() => {
                  const subj = email.match(/^Subject:\s*(.*)$/m)?.[1] ?? m.title
                  const body = email.replace(/^Subject:.*\n+/m, '')
                  window.open(`mailto:${m.attendees.map((a) => a.email).join(',')}?subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(body)}`)
                }}
              >
                Open in mail app
              </button>
              <button className="btn primary" onClick={() => navigator.clipboard.writeText(email)}>
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
