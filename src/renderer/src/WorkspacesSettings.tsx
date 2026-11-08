// Settings → "Shared workspaces". Needs cloud features (a profile on a sync relay). The owner invites
// people with single-use codes; viewers read shared notes and transcripts, editors can also share their
// own meetings, and everyone's Claude (through the Mentat MCP server) can read what they have access to.
import { useEffect, useState } from 'react'
import type { Folder } from '../../shared/types'
import { api } from './api'
import { wsApi, type WorkspaceInviteView, type WorkspaceMemberView, type WorkspacesStatus } from './wsApi'

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function WorkspacesSettings({ onError }: { onError: (m: string) => void }) {
  const [st, setSt] = useState<WorkspacesStatus | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ members: WorkspaceMemberView[]; invites: WorkspaceInviteView[] } | null>(null)
  const [newName, setNewName] = useState('')
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: string; role: string } | null>(null)
  const [inviteRole, setInviteRole] = useState<'viewer' | 'editor'>('viewer')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void wsApi.status().then(setSt)
    void api.folders.list().then(setFolders)
    return wsApi.onStatus(setSt)
  }, [])

  const loadDetail = async (id: string) => {
    try {
      setDetail(await wsApi.detail(id))
    } catch (e) {
      onError(clean(e))
    }
  }

  useEffect(() => {
    setDetail(null)
    setInvite(null)
    if (open) void loadDetail(open)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!st) return null

  const run = async (fn: () => Promise<WorkspacesStatus | void>, refreshDetail = false) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r) {
        setSt(r)
        if (r.lastError) onError(r.lastError)
      }
      setFolders(await api.folders.list())
      if (refreshDetail && open) await loadDetail(open)
    } catch (e) {
      onError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  if (!st.available)
    return (
      <section className="card">
        <h3>Shared workspaces</h3>
        <p className="muted small">
          Share meetings, enhanced notes and full transcripts with your team, and let each person’s Claude read what’s shared with them. Workspaces
          use your cloud profile, so turn on cloud features above first. Nothing is shared until you choose to.
        </p>
      </section>
    )

  const ws = st.workspaces.find((w) => w.id === open)

  return (
    <section className="card">
      <h3>Shared workspaces</h3>
      <p className="muted small">
        Everyone in a workspace can read the meetings shared to it, including enhanced notes and full transcripts, in Mentat and through Claude
        (the Mentat MCP server). Everything is encrypted on your computer; the sync server can’t read it. Your key fingerprint is{' '}
        <code>{st.fingerprint}</code>.
      </p>
      {st.lastError && <p className="warn small">{st.lastError}</p>}

      {st.workspaces.length > 0 && (
        <ul className="device-list">
          {st.workspaces.map((w) => (
            <li key={w.id} className="row">
              <button className="link" onClick={() => setOpen(open === w.id ? null : w.id)}>
                {open === w.id ? '▾' : '▸'} <b>{w.name}</b>
              </button>
              <span className="pill">{w.role}</span>
              <span className="muted small">
                {w.memberCount} {w.memberCount === 1 ? 'member' : 'members'}
                {w.role !== 'owner' ? ` · owner ${w.owner}` : ''}
                {w.receivedCount ? ` · ${w.receivedCount} shared with you` : ''}
                {w.pending ? ' · waiting for keys' : ''}
              </span>
              {w.error && <span className="warn small">{w.error}</span>}
            </li>
          ))}
        </ul>
      )}

      {ws && (
        <div className="card" style={{ background: 'var(--paper)' }}>
          {ws.role !== 'viewer' ? (
            <>
              <h4>What you share here</h4>
              <p className="muted small">Every meeting in a checked folder is shared, including its transcript. You can also share single meetings from a meeting’s ⋯ menu.</p>
              {folders.length === 0 && <p className="muted small">You have no folders yet.</p>}
              {folders.map((f) => (
                <label key={f.id} className="check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={ws.sharedFolderIds.includes(f.id)}
                    onChange={(e) => run(() => wsApi.shareFolder(ws.id, f.id, e.target.checked))}
                  />
                  {f.name}
                </label>
              ))}
              {ws.sharedMeetingIds.length > 0 && <p className="muted small">Plus {ws.sharedMeetingIds.length} meeting(s) shared one by one.</p>}
            </>
          ) : (
            <p className="muted small">You have view-only access: you can read what others share here, but not add your own meetings.</p>
          )}

          <h4>Members</h4>
          {!detail ? (
            <p className="muted small">Loading…</p>
          ) : (
            <ul className="device-list">
              {detail.members.map((m) => (
                <li key={m.username} className="row">
                  <span>
                    {m.username}
                    {m.username === st.me ? ' (you)' : ''}
                  </span>
                  {ws.role === 'owner' && m.role !== 'owner' ? (
                    <select className="select" value={m.role} disabled={busy} onChange={(e) => run(() => wsApi.setRole(ws.id, m.username, e.target.value as 'editor' | 'viewer'), true)}>
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                    </select>
                  ) : (
                    <span className="pill">{m.role}</span>
                  )}
                  <span className="muted small" title="Compare with the fingerprint in their Settings to be sure it’s them">
                    key {m.fingerprint}
                  </span>
                  {ws.role === 'owner' && !m.verified && <span className="warn small">key not verified</span>}
                  <span className="spacer" />
                  {ws.role === 'owner' && m.role !== 'owner' && (
                    <button
                      className="link danger"
                      disabled={busy}
                      onClick={() =>
                        confirm(`Remove ${m.username}? They lose access, their copies are deleted from their computer on its next sync, and the workspace key is replaced.`) &&
                        run(() => wsApi.removeMember(ws.id, m.username), true)
                      }
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {ws.role === 'owner' && (
            <>
              <h4>Invite someone</h4>
              <p className="muted small">
                They need a Mentat profile on the same sync server. Each code works once, for 7 days. Send it privately: it carries the key to this
                workspace.
              </p>
              <div className="row">
                <select className="select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'viewer' | 'editor')}>
                  <option value="viewer">Viewer: can read</option>
                  <option value="editor">Editor: can read and share their meetings</option>
                </select>
                <button
                  className="btn"
                  disabled={busy || ws.pending}
                  onClick={() =>
                    run(async () => {
                      const r = await wsApi.invite(ws.id, inviteRole)
                      setInvite({ ...r, role: inviteRole })
                    }, true)
                  }
                >
                  Create invite code
                </button>
              </div>
              {invite && (
                <div className="pair-box">
                  <textarea readOnly className="code" style={{ width: '100%', height: 70 }} value={invite.code} onFocus={(e) => e.target.select()} />
                  <button className="btn" onClick={() => navigator.clipboard.writeText(invite.code)}>
                    Copy
                  </button>
                </div>
              )}
              {detail && detail.invites.some((i) => !i.usedBy) && (
                <ul className="device-list">
                  {detail.invites
                    .filter((i) => !i.usedBy)
                    .map((i) => (
                      <li key={i.id} className="row">
                        <span className="muted small">
                          Unused {i.role} invite, made {day(i.createdAt)}, expires {day(i.expiresAt)}
                        </span>
                        <span className="spacer" />
                        <button className="link danger" disabled={busy} onClick={() => run(() => wsApi.revokeInvite(ws.id, i.id), true)}>
                          Revoke
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <span className="spacer" />
            {ws.role === 'owner' ? (
              <button
                className="link danger"
                disabled={busy}
                onClick={() => confirm(`Delete “${ws.name}” for everyone? Your own notes stay on your computer.`) && run(() => wsApi.remove(ws.id))}
              >
                Delete workspace
              </button>
            ) : (
              <button
                className="link danger"
                disabled={busy}
                onClick={() => confirm(`Leave “${ws.name}”? Its shared meetings are removed from this computer.`) && run(() => wsApi.leave(ws.id))}
              >
                Leave workspace
              </button>
            )}
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New workspace name" style={{ maxWidth: 240 }} />
        <button
          className="btn"
          disabled={busy || !newName.trim()}
          onClick={() =>
            run(async () => {
              const r = await wsApi.create(newName)
              setNewName('')
              return r
            })
          }
        >
          Create workspace
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste an invite code (mentat-invite:…)" />
        <button
          className="btn"
          disabled={busy || !code.trim()}
          onClick={() =>
            run(async () => {
              const r = await wsApi.join(code)
              setCode('')
              return r
            })
          }
        >
          Join
        </button>
        <button className="btn ghost" disabled={busy || st.syncing} onClick={() => run(() => wsApi.sync())}>
          {st.syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
    </section>
  )
}
