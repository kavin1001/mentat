import { useCallback, useEffect, useState } from 'react'
import type { CalendarEvent, Folder, LocalWorkspace, MeetingSummary } from '../../shared/types'
import { api } from './api'
import { syncApi } from './syncApi'
import { wsApi } from './wsApi'
import { MeetingView } from './MeetingView'
import { SharedMeetingView } from './SharedMeetingView'
import { ChatPanel } from './ChatPanel'
import { SettingsView } from './SettingsView'
import { TemplatesView } from './TemplatesView'
import { Markdown } from './Markdown'
import { ContextMenu, DialogHost, confirmDeleteNote, confirmDialog, type MenuItem } from './Dialogs'

type View =
  | { kind: 'meeting'; id: string; autoRecord?: boolean }
  | { kind: 'shared'; workspaceId: string; id: string }
  | { kind: 'home' } | { kind: 'chat' } | { kind: 'settings' } | { kind: 'templates' }

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
  // Set when browsing a shared workspace instead of your own notes.
  const [workspaceId, setWorkspaceId] = useState<string | undefined>()
  const [workspaces, setWorkspaces] = useState<LocalWorkspace[]>([])
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [brief, setBrief] = useState<{ ev: CalendarEvent; text: string | null } | null>(null)
  // Electron does not implement window.prompt(), so new folders are named inline.
  const [newFolder, setNewFolder] = useState<string | null>(null)
  // Right-click (or ⋯) menu on a note or folder in the sidebar, and inline renaming.
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<{ kind: 'meeting' | 'folder'; id: string; value: string } | null>(null)

  const refresh = useCallback(async () => {
    const ws = await wsApi.local()
    setWorkspaces(ws)
    const browsing = workspaceId && ws.some((w) => w.id === workspaceId) ? workspaceId : undefined
    if (workspaceId && !browsing) setWorkspaceId(undefined)
    setMeetings(browsing ? await wsApi.meetings(browsing, query || undefined) : await api.meetings.list({ folderId, query: query || undefined }))
    setFolders(await api.folders.list())
  }, [folderId, workspaceId, query])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    api.google.events().then(setEvents).catch(() => setEvents([]))
    const offs = [
      api.events.onCalendar(setEvents),
      syncApi.onDataChanged(() => void refresh()),
      api.events.onMeetingChanged(() => void refresh()),
      wsApi.onStatus(() => void refresh()),
      api.events.onError((m) => setToast(m)),
      api.events.onOpenMeeting((id, opts) => {
        setView({ kind: 'meeting', id, autoRecord: opts.autoRecord })
        void refresh()
      })
    ]
    return () => offs.forEach((o) => o())
  }, [refresh])

  // Nudge toward Google Drive on the home screen until it is connected.
  const [googleConnected, setGoogleConnected] = useState(true)
  useEffect(() => {
    if (view.kind === 'home') api.google.status().then((g) => setGoogleConnected(g.connected)).catch(() => undefined)
  }, [view.kind])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const newMeeting = async () => {
    setWorkspaceId(undefined)
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

  const deleteMeeting = async (m: { id: string; title: string; inDrive?: boolean }) => {
    const ok = await confirmDeleteNote(m.title, !!m.inDrive)
    if (!ok) return
    try {
      await api.meetings.remove(m.id)
      if ((view.kind === 'meeting' || view.kind === 'shared') && view.id === m.id) setView({ kind: 'home' })
      await refresh()
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const deleteFolder = async (f: Folder) => {
    const ok = await confirmDialog(`Delete the folder “${f.name}”?`, {
      detail: 'The notes inside are kept and move back to All notes.',
      confirmLabel: 'Delete folder',
      danger: true
    })
    if (!ok) return
    await api.folders.remove(f.id)
    if (folderId === f.id) setFolderId(undefined)
    await refresh()
  }

  const saveRename = async () => {
    const r = renaming
    setRenaming(null)
    const name = r?.value.trim()
    if (!r || !name) return
    try {
      if (r.kind === 'folder') await api.folders.rename(r.id, name)
      else await api.meetings.update(r.id, { title: name })
      await refresh()
    } catch (e) {
      setToast((e as Error).message)
    }
  }

  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setCtx({ x: e.clientX, y: e.clientY, items })
  }

  const meetingMenu = (m: MeetingSummary): MenuItem[] =>
    workspaceId
      ? [{ label: 'Open', onClick: () => setView({ kind: 'shared', workspaceId, id: m.id }) }]
      : [
          { label: 'Open', onClick: () => setView({ kind: 'meeting', id: m.id }) },
          { label: 'Rename', onClick: () => setRenaming({ kind: 'meeting', id: m.id, value: m.title }) },
          { separator: true, label: '' },
          { label: 'Move to: No folder', disabled: !m.folderIds.length, onClick: () => void api.meetings.update(m.id, { folderIds: [] }).then(refresh) },
          ...folders.map((f) => ({
            label: `Move to: ${f.name}`,
            disabled: m.folderIds[0] === f.id,
            onClick: () => void api.meetings.update(m.id, { folderIds: [f.id] }).then(refresh)
          })),
          { separator: true, label: '' },
          { label: 'Delete note', danger: true, onClick: () => void deleteMeeting(m) }
        ]

  const folderMenu = (f: Folder): MenuItem[] => [
    { label: 'Rename', onClick: () => setRenaming({ kind: 'folder', id: f.id, value: f.name }) },
    { label: 'Delete folder', danger: true, onClick: () => void deleteFolder(f) }
  ]

  const renameInput = (
    <input
      className="rename-input"
      autoFocus
      value={renaming?.value ?? ''}
      onChange={(e) => setRenaming((r) => (r ? { ...r, value: e.target.value } : r))}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void saveRename()
        if (e.key === 'Escape') setRenaming(null)
      }}
      onBlur={() => void saveRename()}
    />
  )

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
          <button className={`nav ${!folderId && !workspaceId ? 'active' : ''}`} onClick={() => { setFolderId(undefined); setWorkspaceId(undefined) }}>
            All notes
          </button>
          {folders.map((f) =>
            renaming?.kind === 'folder' && renaming.id === f.id ? (
              <div key={f.id}>{renameInput}</div>
            ) : (
              <div key={f.id} className="sidebar-row" onContextMenu={(e) => openMenu(e, folderMenu(f))}>
                <button className={`nav ${folderId === f.id && !workspaceId ? 'active' : ''}`} onClick={() => { setFolderId(f.id); setWorkspaceId(undefined) }}>
                  ▸ {f.name}
                  {f.workspaceIds?.length ? <span className="muted small"> · shared</span> : null}
                </button>
                <button className="row-more" title="Rename or delete folder" onClick={(e) => openMenu(e, folderMenu(f))}>
                  ⋯
                </button>
              </div>
            )
          )}
        </section>

        {workspaces.length > 0 && (
          <section>
            <h4>Workspaces</h4>
            {workspaces.map((w) => (
              <button key={w.id} className={`nav ${workspaceId === w.id ? 'active' : ''}`} onClick={() => setWorkspaceId(w.id)} title={`Owner: ${w.owner} · you are ${w.role === 'owner' ? 'the owner' : `a ${w.role}`}`}>
                ◇ {w.name}
              </button>
            ))}
          </section>
        )}

        <section className="meeting-list">
          {groups.map(([label, ms]) => (
            <div key={label}>
              <h4>{label}</h4>
              {ms.map((m) =>
                renaming?.kind === 'meeting' && renaming.id === m.id ? (
                  <div key={m.id}>{renameInput}</div>
                ) : (
                <div key={m.id} className="sidebar-row" onContextMenu={(e) => openMenu(e, meetingMenu(m))}>
                <button
                  className={`meeting-item ${(view.kind === 'meeting' || view.kind === 'shared') && view.id === m.id ? 'active' : ''}`}
                  onClick={() => setView(workspaceId ? { kind: 'shared', workspaceId, id: m.id } : { kind: 'meeting', id: m.id })}
                >
                  <span className="mi-title">{m.title}</span>
                  <span className="mi-meta">
                    {timeOf(m.startedAt ?? m.createdAt)}
                    {m.sharedBy ? ` · ${m.sharedBy}` : ''}
                    {m.hasTranscript ? ' · transcript' : ''}
                    {m.hasEnhanced ? ' · notes' : ''}
                  </span>
                </button>
                {!workspaceId && (
                  <button className="row-more" title="Rename, move or delete" onClick={(e) => openMenu(e, meetingMenu(m))}>
                    ⋯
                  </button>
                )}
                </div>
                )
              )}
            </div>
          ))}
          {!meetings.length && (
            <p className="muted small">{workspaceId ? 'Nothing has been shared in this workspace yet.' : 'No notes yet. Start one, or open a meeting from your calendar.'}</p>
          )}
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
        {view.kind === 'shared' && (
          <SharedMeetingView
            key={`${view.workspaceId}:${view.id}`}
            workspaceId={view.workspaceId}
            workspaceName={workspaces.find((w) => w.id === view.workspaceId)?.name ?? 'a shared workspace'}
            id={view.id}
          />
        )}
        {view.kind === 'home' && (
          <div className="home">
            <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}</h1>
            <p className="muted">Mentat listens to your computer's audio, with no bot in the call. Jot what matters; Claude fills in the rest from the full transcript.</p>
            <button className="btn primary" onClick={newMeeting}>
              Start a note
            </button>
            {!googleConnected && (
              <div className="card home-card">
                <h3>Save your notes to Google Drive</h3>
                <p className="muted small">
                  One click connects your Google account. Mentat then files every note and transcript in Drive, Claude can look things up in your Drive
                  files, and upcoming meetings show up here.
                </p>
                <button className="btn" onClick={() => setView({ kind: 'settings' })}>
                  Connect Google Drive
                </button>
              </div>
            )}
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
      {ctx && <ContextMenu {...ctx} onClose={() => setCtx(null)} />}
      <DialogHost />
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {/* Drop Electron's IPC wrapper so the user sees only the actual message. */}
          {toast.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}
        </div>
      )}
    </div>
  )
}
