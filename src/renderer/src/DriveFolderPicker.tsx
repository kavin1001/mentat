// Pick the Google Drive folder Mentat uploads into: browse My Drive folder by folder, optionally make a new one.
import { useEffect, useState } from 'react'
import { api } from './api'

interface Crumb {
  id: string
  name: string
}

export function DriveFolderPicker({ onPick, onClose }: { onPick: (id: string, label: string) => void; onClose: () => void }) {
  const [path, setPath] = useState<Crumb[]>([{ id: 'root', name: 'My Drive' }])
  const [folders, setFolders] = useState<Crumb[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState<string | null>(null)
  const here = path[path.length - 1]

  const load = async (id: string) => {
    setFolders(null)
    setError(null)
    try {
      setFolders(await api.drive.folders(id))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  useEffect(() => {
    void load(here.id)
  }, [here.id])

  const create = async () => {
    const name = newName?.trim()
    setNewName(null)
    if (!name) return
    try {
      const id = await api.drive.createFolder(name, here.id)
      setPath([...path, { id, name }])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <h3>Choose where Mentat saves notes</h3>
        <div className="crumbs">
          {path.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <span className="muted"> / </span>}
              <button className="link" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>
                {c.name}
              </button>
            </span>
          ))}
        </div>
        <div className="folder-list">
          {error && <p className="danger small">{error}</p>}
          {!folders && !error && <p className="muted small">Loading folders…</p>}
          {folders?.length === 0 && <p className="muted small">No folders in here.</p>}
          {folders?.map((f) => (
            <button key={f.id} className="folder-row" onClick={() => setPath([...path, f])}>
              ▸ {f.name}
            </button>
          ))}
        </div>
        {newName !== null ? (
          <input
            className="search"
            autoFocus
            placeholder="New folder name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
              if (e.key === 'Escape') setNewName(null)
            }}
          />
        ) : null}
        <div className="row end">
          <button className="btn ghost" onClick={() => setNewName('')}>
            + New folder here
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={here.id === 'root'} title={here.id === 'root' ? 'Open or create a folder first' : ''} onClick={() => onPick(here.id, path.map((c) => c.name).join(' / '))}>
            Save notes here
          </button>
        </div>
      </div>
    </div>
  )
}
