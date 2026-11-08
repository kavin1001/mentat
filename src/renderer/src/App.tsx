import { useCallback, useEffect, useState } from 'react'
import type { CalendarEvent, Folder, MeetingSummary } from '../../shared/types'
import { api } from './api'
import { syncApi } from './syncApi'
import { MeetingView } from './MeetingView'
import { ChatPanel } from './ChatPanel'
import { SettingsView } from './SettingsView'
import { TemplatesView } from './TemplatesView'
import { Markdown } from './Markdown'

type View = { kind: 'meeting'; id: string; autoRecord?: boolean } | { kind: 'home' } | { kind: 'chat' } | { kind: 'settings' } | { kind: 'templates' }

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export function App() {
  const [view, setView] = useState<View>({ kind: 'home' })
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [folderId, setFolderId] = useState<string | undefined>()
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [brief, setBrief] = useState<{ ev: CalendarEvent; text: string | null } | null>(null)
  // Electron does not implement window.prompt(), so new folders are named inline.
  const [newFolder, setNewFolder] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setMeetings(await api.meetings.list({ folderId, query: query || undefined }))
    setFolders(await api.folders.list())
  }, [folderId, query])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    api.google.events().then(setEvents).catch(() => setEvents([]))
    const offs = [
      api.events.onCalendar(setEvents),
      syncApi.onDataChanged(() => void refresh()),
      api.events.onError((m) => setToast(m)),
      api.events.onOpenMeeting((id, opts) => {
        setView({ kind: 'meeting', id, autoRecord: opts.autoRecord })
        void refresh()
      })
    ]
    return () => offs.forEach((o) => o())
  }, [refresh])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const newMeeting = async () => {
    const m = await api.meetings.create(folderId ? { folderIds: [folderId] } : undefined)
    await refresh()
    setView({ kind: 'meeting', id: m.id })
  }

  const openEvent = async (ev: CalendarEvent) => {
    const m = await api.meetings.fromEvent(ev)
    await refresh()
    setView({ kind: 'meeting', id: m.id })
  }

  const showBrief = async (ev: CalendarEvent) => {
    setBrief({ ev, text: null })
    try {
      setBrief({ ev, text: await api.ai.brief(ev) })
    } catch (e) {
      setBrief({ ev, text: `Could not build a brief: ${(e as Error).message}` })
    }
  }

  const addFolder = async () => {
    const name = newFolder?.trim()
    setNewFolder(null)
    if (name) {
      await api.folders.create(name)
      void refresh()
    }
  }

  const upcoming = events.filter((e) => new Date(e.end).getTime() > Date.now()).slice(0, 4)
  const groups: [string, MeetingSummary[]][] = []
  for (const m of meetings) {
    const label = dayLabel(m.startedAt ?? m.createdAt)
    const g = groups.find((x) => x[0] === label)
    if (g) g[1].push(m)
    else groups.push([label, [m]])
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand drag">
          <span className="brand-mark">◐</span> Mentat
        </div>
        <button className="btn primary wide" onClick={newMeeting}>
          + New note
        </button>
        <input className="search" placeholder="Search notes and transcripts" value={query} onChange={(e) => setQuery(e.target.value)} />

        {upcoming.length > 0 && (
          <section>
            <h4>Coming up</h4>
            {upcoming.map((ev) => (
              <div key={ev.id} className="event">
                <button className="event-main" onClick={() => openEvent(ev)}>
                  <span className="event-time">{timeOf(ev.start)}</span>
                  <span className="event-title">{ev.title}</span>
                </button>
                <button className="link small" title="Brief me from past meetings" onClick={() => showBrief(ev)}>
                  Brief
                </button>
              </div>
            ))}
          </section>
        )}

        <section>
          <h4>
            Folders <button className="link small" onClick={() => setNewFolder('')}>+ New</button>
          </h4>
          {newFolder !== null && (
            <input
              className="search"
              autoFocus
              placeholder="Folder name"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addFolder()
                if (e.key === 'Escape') setNewFolder(null)
              }}
              onBlur={() => setNewFolder(null)}
            />
          )}
          <button className={`nav ${!folderId ? 'active' : ''}`} onClick={() => setFolderId(undefined)}>
            All notes
          </button>
          {folders.map((f) => (
            <button key={f.id} className={`nav ${folderId === f.id ? 'active' : ''}`} onClick={() => setFolderId(f.id)}>
              ▸ {f.name}
            </button>
          ))}
        </section>

        <section className="meeting-list">
          {groups.map(([label, ms]) => (
            <div key={label}>
              <h4>{label}</h4>
              {ms.map((m) => (
                <button key={m.id} className={`meeting-item ${view.kind === 'meeting' && view.id === m.id ? 'active' : ''}`} onClick={() => setView({ kind: 'meeting', id: m.id })}>
                  <span className="mi-title">{m.title}</span>
                  <span className="mi-meta">
                    {timeOf(m.startedAt ?? m.createdAt)}
                    {m.hasTranscript ? ' · transcript' : ''}
                    {m.hasEnhanced ? ' · notes' : ''}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {!meetings.length && <p className="muted small">No notes yet. Start one, or open a meeting from your calendar.</p>}
        </section>

        <footer className="sidebar-footer">
          <button className={`nav ${view.kind === 'chat' ? 'active' : ''}`} onClick={() => setView({ kind: 'chat' })}>
            ✦ Ask across meetings
          </button>
          <button className={`nav ${view.kind === 'templates' ? 'active' : ''}`} onClick={() => setView({ kind: 'templates' })}>
            ☰ Templates
          </button>
          <button className={`nav ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
            ⚙ Settings
          </button>
        </footer>
      </aside>

      <main className="main">
        {view.kind === 'meeting' && (
          <MeetingView
            key={view.id}
            id={view.id}
            autoRecord={view.autoRecord}
            folders={folders}
            onChanged={refresh}
            onDeleted={() => {
              setView({ kind: 'home' })
              void refresh()
            }}
            onError={setToast}
          />
        )}
        {view.kind === 'home' && (
          <div className="home">
            <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}</h1>
            <p className="muted">Mentat listens to your computer's audio, with no bot in the call. Jot what matters; Claude fills in the rest from the full transcript.</p>
            <button className="btn primary" onClick={newMeeting}>
              Start a note
            </button>
          </div>
        )}
        {view.kind === 'chat' && (
          <div className="page">
            <h2>Ask across all your meetings</h2>
            <ChatPanel scope={{}} placeholder="What did we decide about pricing last month?" onError={setToast} />
          </div>
        )}
        {view.kind === 'settings' && <SettingsView onError={setToast} />}
        {view.kind === 'templates' && <TemplatesView />}
      </main>

      {brief && (
        <div className="modal-backdrop" onClick={() => setBrief(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Brief: {brief.ev.title}</h3>
            {brief.text === null ? <p className="muted">Reading your past meetings…</p> : <Markdown text={brief.text} />}
            <div className="row end">
              <button className="btn" onClick={() => setBrief(null)}>
                Close
              </button>
              <button className="btn primary" onClick={() => { void openEvent(brief.ev); setBrief(null) }}>
                Open note
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {/* Drop Electron's IPC wrapper so the user sees only the actual message. */}
          {toast.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}
        </div>
      )}
    </div>
  )
}
