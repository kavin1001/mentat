import { useEffect, useRef, useState } from 'react'
import type { Folder, Meeting, Speaker, Template } from '../../shared/types'
import { fmtTime, transcriptToText, transcriptTurns } from '../../shared/format'
import { api } from './api'
import { wsApi, type WorkspacesStatus } from './wsApi'
import { startCapture, type CaptureHandle } from './audio'
import { ChatPanel } from './ChatPanel'
import { NoteEditor } from './NoteEditor'
import { confirmDeleteNote, confirmDialog } from './Dialogs'
import { beginTranscription, endTranscription, ensureModel, onTranscriber } from './transcriber'

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
  const [speaking, setSpeaking] = useState<Record<Speaker, boolean>>({ me: false, them: false })
  const [partial, setPartial] = useState<Record<Speaker, string>>({ me: '', them: '' })
  const [renaming, setRenaming] = useState<{ index: number; value: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const [enhancing, setEnhancing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [ws, setWs] = useState<WorkspacesStatus['workspaces']>([])
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
      wsApi.status().then((w) => setWs(w.workspaces.filter((x) => x.role !== 'viewer' && !x.pending))).catch(() => undefined)
      const status = await api.recording.status()
      if (status?.meetingId === id) setRecording(true)
      else if (autoRecord) void start()
    })()
    const offs = [
      api.events.onFinal((mid, seg) => {
        if (mid !== id) return
        setM((prev) => (prev ? { ...prev, transcript: [...prev.transcript, seg].sort((a, b) => a.start - b.start) } : prev))
        setPartial((p) => ({ ...p, [seg.speaker]: '' }))
      }),
      // Uploaded to Drive in the background (e.g. right after recording): show the Drive link and folder.
      api.events.onMeetingChanged((mid) => {
        if (mid !== id) return
        void api.meetings.get(id).then((fresh) => fresh && setM((prev) => (prev ? { ...prev, drive: fresh.drive, folderIds: fresh.folderIds } : prev)))
      }),
      api.events.onReset((mid, transcript) => mid === id && setM((prev) => (prev ? { ...prev, transcript } : prev))),
      // The call this meeting was recording has ended (or Stop was picked in the menu bar).
      api.events.onAutoStop((mid) => mid === id && void stopRef.current()),
      onTranscriber((msg) => {
        if (msg.type === 'speaking') {
          setSpeaking((p) => ({ ...p, [msg.speaker]: msg.active }))
          if (msg.active) setPartial((p) => ({ ...p, [msg.speaker]: '' }))
        } else if (msg.type === 'partial') setPartial((p) => ({ ...p, [msg.speaker]: msg.text }))
        else if (msg.type === 'progress' && msg.total) setModelStatus(`Downloading speech model ${Math.round((msg.loaded / msg.total) * 100)}%`)
        else if (msg.type === 'error') onError(msg.message)
      })
    ]
    return () => {
      offs.forEach((o) => o())
      clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Close the ⋯ menu on any click outside it, or Escape.
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.menu-wrap') && setMenu(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

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
      const s = await api.settings.get()
      setModelStatus('Loading speech model…')
      await ensureModel(s.sttModel, s.language, s.diarize ?? true)
      setModelStatus(null)
      const { offset } = await api.recording.start(id)
      beginTranscription(id, offset)
      capture.current = await startCapture((a, b) => setLevels([a, b]))
      setSystemAudio(capture.current.hasSystemAudio)
      setRecording(true)
    } catch (e) {
      setModelStatus(null)
      onError((e as Error).message)
      capture.current?.stop()
      capture.current = null
      await api.recording.stop()
    }
  }

  const stop = async () => {
    capture.current?.stop()
    capture.current = null
    setRecording(false)
    setLevels([0, 0])
    setModelStatus('Finishing transcript…')
    await endTranscription()
    setModelStatus(null)
    setSpeaking({ me: false, them: false })
    setPartial({ me: '', them: '' })
    await api.recording.stop()
  }

  const stopRef = useRef(stop)
  stopRef.current = stop

  const enhance = async () => {
    if (recording) await stop()
    setEnhancing(true)
    try {
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

  const turns = transcriptTurns(m.transcript, m.speakerNames)
  const saveSpeakerName = () => {
    if (!renaming) return
    const names = { ...(m.speakerNames ?? {}) }
    if (renaming.value.trim()) names[renaming.index] = renaming.value.trim()
    else delete names[renaming.index]
    patch({ speakerNames: names })
    setRenaming(null)
  }
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
            {(m.workspaceIds?.length ?? 0) > 0 && <span className="pill">Shared</span>}
            {m.drive && (
              <a className="pill link" href={m.drive.webViewLink} target="_blank" rel="noreferrer" title="Open in Google Drive">
                Drive{m.drive.folderPath?.length ? `: ${m.drive.folderPath.join(' / ')}` : ''} ↗
              </a>
            )}
            <div className="spacer" />
            <div className="menu-wrap">
              <button className="btn ghost" onClick={() => setMenu(!menu)}>
                ⋯
              </button>
              {menu && (
                <div className="menu">
                  <button onClick={() => act(async () => setM(await api.drive.sync(id)))}>Save to Google Drive</button>
                  <button onClick={() => act(async () => setM(await api.drive.sync(id, true)))}>Re-file in Drive (let Claude pick again)</button>
                  <button
                    onClick={() =>
                      act(async () => {
                        const emails =
                          m.attendees.length && (await confirmDialog('Also email a view link to the attendees?', { detail: m.attendees.map((a) => a.email).join(', '), confirmLabel: 'Email them', cancelLabel: 'Just copy the link' }))
                            ? m.attendees.map((a) => a.email)
                            : []
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
                  {ws.length > 0 && <hr />}
                  {ws.map((w) => {
                    const viaFolder = m.folderIds.some((f) => folders.find((x) => x.id === f)?.workspaceIds?.includes(w.id))
                    const direct = !!m.workspaceIds?.includes(w.id)
                    if (viaFolder && !direct) return <button key={w.id} disabled>Shared in {w.name} (through its folder)</button>
                    return (
                      <button
                        key={w.id}
                        onClick={() =>
                          act(async () => {
                            await wsApi.shareMeeting(w.id, id, !direct)
                            setM(await api.meetings.get(id))
                            onError(direct ? `Stopped sharing in ${w.name}.` : `Shared with everyone in ${w.name}, including the transcript.`)
                          })
                        }
                      >
                        {direct ? `Stop sharing in ${w.name}` : `Share to ${w.name} (notes + transcript)`}
                      </button>
                    )
                  })}
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
                        const ok = await confirmDeleteNote(m.title, !!m.drive?.docId)
                        if (!ok) return
                        // Don't let a pending autosave write the note back after it is gone.
                        clearTimeout(saveTimer.current)
                        // Finishing the transcript can take a while (or stall); never let it block the delete.
                        if (recording) await Promise.race([stop(), new Promise((r) => setTimeout(r, 3000))])
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
          <NoteEditor
            value={m.notes}
            placeholder="Write notes as the meeting happens. Just the bits that matter to you; Mentat fills in the rest from the transcript."
            onChange={(notes) => patch({ notes }, true)}
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
          <button className={`rec ${recording ? 'on' : ''}`} disabled={!!modelStatus} onClick={recording ? stop : start} title={recording ? 'Stop recording' : 'Start recording'}>
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
          {modelStatus && <span className="small muted">{modelStatus}</span>}
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
            <div className="side-actions">
              {panel === 'transcript' && (
                <button
                  className="btn ghost"
                  title="Copy the whole transcript with speaker names"
                  disabled={!turns.length}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(transcriptToText(m.transcript, m.speakerNames))
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    } catch (e) {
                      onError(`Couldn't copy the transcript: ${(e as Error).message}`)
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
              <button className="btn ghost" onClick={() => setPanel(null)}>
                ✕
              </button>
            </div>
          </div>
          {panel === 'transcript' ? (
            <div className="transcript">
              {!turns.length && <p className="muted small">The full transcript appears here as people talk. Speech is transcribed on this computer and saved locally; no bot joins the call.</p>}
              {turns.map((t, i) => (
                <div key={i} className={`turn ${t.speaker}`}>
                  <div className="turn-meta">
                    {t.speaker === 'them' && renaming?.index === (t.speakerIndex ?? 0) ? (
                      <input
                        className="rename"
                        autoFocus
                        value={renaming.value}
                        placeholder="Name"
                        onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                        onBlur={saveSpeakerName}
                        onKeyDown={(e) => (e.key === 'Enter' ? saveSpeakerName() : e.key === 'Escape' && setRenaming(null))}
                      />
                    ) : t.speaker === 'them' ? (
                      <button className="speaker-name" title="Click to name this speaker" onClick={() => setRenaming({ index: t.speakerIndex ?? 0, value: m.speakerNames?.[t.speakerIndex ?? 0] ?? '' })}>
                        {t.label}
                      </button>
                    ) : (
                      t.label
                    )}{' '}
                    · {fmtTime(t.start)}
                  </div>
                  <div>{t.text}</div>
                </div>
              ))}
              {(['me', 'them'] as Speaker[]).map(
                (s) =>
                  speaking[s] && (
                    <div key={s} className={`turn ${s} partial`}>
                      <div className="turn-meta">{s === 'me' ? 'Me' : 'Them'} · live</div>
                      <div>{partial[s] || '…'}</div>
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
