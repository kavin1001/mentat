import type { RecordStore } from '@mentat/sync-core'
import type { Folder, Meeting } from './types'

export function sortedMeetings(store: RecordStore, opts: { query?: string; folderId?: string } = {}): Meeting[] {
  let ms = store.list<Meeting>('meeting')
  if (opts.folderId) ms = ms.filter((m) => m.folderIds?.includes(opts.folderId!))
  const q = opts.query?.trim().toLowerCase()
  if (q)
    ms = ms.filter((m) =>
      [m.title, m.notes, m.enhanced?.summary ?? '', ...(m.attendees ?? []).map((a) => `${a.name ?? ''} ${a.email}`), ...(m.transcript ?? []).map((t) => t.text)]
        .join('\n')
        .toLowerCase()
        .includes(q)
    )
  return ms.sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))
}

export function folders(store: RecordStore): Folder[] {
  return store.list<Folder>('folder').sort((a, b) => a.name.localeCompare(b.name))
}

export function preview(m: Meeting): string {
  const t = m.enhanced?.summary || m.notes || (m.transcript ?? []).slice(0, 3).map((s) => s.text).join(' ')
  return t.replace(/\s+/g, ' ').trim().slice(0, 140)
}

export function newId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function blankMeeting(): Meeting {
  const now = new Date().toISOString()
  return { id: newId(), title: 'Untitled note', createdAt: now, updatedAt: now, startedAt: now, attendees: [], folderIds: [], notes: '', transcript: [] }
}

export function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** Phone notes start untitled; show their first line instead until the user names them. */
export function displayTitle(m: Meeting): string {
  if (m.title && m.title !== 'Untitled note' && m.title !== 'Untitled meeting') return m.title
  const first = (m.notes ?? '').split('\n').map((l) => l.replace(/^[-*#\s]+/, '').trim()).find(Boolean)
  return first ? first.slice(0, 80) : m.title || 'Untitled'
}
