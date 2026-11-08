// In-app confirm dialog and right-click menus. Native window.confirm() is unreliable in Electron (it can be
// swallowed on macOS and blocks the renderer), so every "are you sure?" goes through here instead.
import { useEffect, useState } from 'react'
import { api } from './api'

interface ConfirmRequest {
  message: string
  detail?: string
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  resolve: (ok: boolean) => void
}

let show: ((r: ConfirmRequest) => void) | null = null

/** Ask the user to confirm. Resolves true for the confirm button, false for cancel, Escape or a click outside. */
export function confirmDialog(
  message: string,
  opts: { detail?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false)
    show({ message, detail: opts.detail, confirmLabel: opts.confirmLabel ?? 'OK', cancelLabel: opts.cancelLabel ?? 'Cancel', danger: !!opts.danger, resolve })
  })
}

/** Mount once, near the root of each window. */
export function DialogHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null)
  useEffect(() => {
    show = (r) => setReq(r)
    return () => {
      show = null
    }
  }, [])
  useEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false)
      if (e.key === 'Enter') done(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (!req) return null
  const done = (ok: boolean) => {
    setReq(null)
    req.resolve(ok)
  }
  return (
    <div className="modal-backdrop" onClick={() => done(false)}>
      <div className="modal confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{req.message}</h3>
        {req.detail && <p className="muted">{req.detail}</p>}
        <div className="row end">
          <button className="btn" onClick={() => done(false)}>
            {req.cancelLabel}
          </button>
          <button className={`btn ${req.danger ? 'danger-fill' : 'primary'}`} autoFocus onClick={() => done(true)}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The one "delete this note?" question, used from the sidebar and from the note itself. */
export async function confirmDeleteNote(title: string, inDrive: boolean): Promise<boolean> {
  const s = await api.settings.get().catch(() => null)
  const drive = !inDrive
    ? ''
    : s?.driveDeleteWithNote === false
      ? ' Its copy in Google Drive stays there.'
      : ' Its Google Docs in Drive move to the Drive trash, where you can restore them for 30 days.'
  return confirmDialog(`Delete “${title}”?`, {
    detail: `Its notes and full transcript are removed from this computer (and from your other devices if sync is on).${drive}`,
    confirmLabel: 'Delete',
    danger: true
  })
}

export interface MenuItem {
  label: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
}

/** A small floating menu at (x, y) that closes on any outside click, scroll or Escape. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  // Keep the menu on screen.
  const left = Math.min(x, window.innerWidth - 230)
  const top = Math.min(y, window.innerHeight - (items.length * 32 + 16))
  return (
    <div className="menu context-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it, i) =>
        it.separator ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick?.()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
