// Change tracking for sync over the desktop's plain-file store (~/Mentat).
//
// Meetings can be changed by the app, by the MCP server, or by hand, so instead of hooking every write
// the index scans the files, hashes each record and gives every change a monotonically increasing
// sequence number. A record that disappears from disk becomes a tombstone. State lives in ~/Mentat/.sync/.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRecords, stableStringify, type RecordKind, type SyncRecord } from '@mentat/sync-core'
import type { Store } from '../../shared/store'
import type { Folder, Meeting, Template } from '../../shared/types'

export interface IndexEntry {
  kind: RecordKind
  id: string
  hash: string
  /** Local sequence number of the last change (served to paired phones). */
  seq: number
  updatedAt: string
  deleted?: boolean
  mtimeMs?: number
  /** Cloud relay seq this record was last synced at. */
  cloudBase?: number
  /** Hash last pushed to / received from the cloud. */
  cloudHash?: string
}

interface IndexState {
  v: 1
  deviceId: string
  seq: number
  cloudCursor: number
  /** "serverUrl|username" of the cloud profile the cloud fields below refer to. */
  cloudIdentity?: string
  entries: Record<string, IndexEntry>
}

const ek = (kind: RecordKind, id: string) => `${kind}:${id}`
const hashOf = (data: unknown) => createHash('sha256').update(stableStringify(data)).digest('hex')
const DELETED = 'deleted'

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export class LocalIndex {
  readonly dir: string
  private path: string
  state: IndexState

  constructor(readonly store: Store) {
    this.dir = join(store.dataDir, '.sync')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.path = join(this.dir, 'index.json')
    this.state = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as IndexState)
      : { v: 1, deviceId: randomUUID(), seq: 0, cloudCursor: 0, entries: {} }
  }

  persist(): void {
    writeAtomic(this.path, JSON.stringify(this.state))
  }

  get latest(): number {
    return this.state.seq
  }

  entries(): IndexEntry[] {
    return Object.values(this.state.entries)
  }

  private bump(e: Omit<IndexEntry, 'seq'> & { seq?: number }): IndexEntry {
    const prev = this.state.entries[ek(e.kind, e.id)]
    const entry: IndexEntry = { ...prev, ...e, seq: ++this.state.seq }
    this.state.entries[ek(e.kind, e.id)] = entry
    return entry
  }

  private foldersPath() {
    return join(this.store.dataDir, 'folders.json')
  }
  private readFolders(): Folder[] {
    return existsSync(this.foldersPath()) ? (JSON.parse(readFileSync(this.foldersPath(), 'utf8')) as Folder[]) : []
  }
  private customTemplates(): Template[] {
    return this.store.listTemplates().filter((t) => !t.builtIn)
  }

  /** Picks up changes made on disk since the last scan. Returns how many records changed. */
  scan(): number {
    let changed = 0
    const seen = new Set<string>()
    const now = new Date().toISOString()

    // Meetings: stat first, only re-read files whose mtime moved.
    for (const f of readdirSync(this.store.meetingsDir)) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      const key = ek('meeting', id)
      seen.add(key)
      const path = join(this.store.meetingsDir, f)
      let mtimeMs: number
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {
        continue
      }
      const prev = this.state.entries[key]
      if (prev && !prev.deleted && prev.mtimeMs === mtimeMs) continue
      let m: Meeting
      try {
        m = JSON.parse(readFileSync(path, 'utf8')) as Meeting
      } catch {
        continue // mid-write or corrupt; try next scan
      }
      const hash = hashOf(m)
      if (prev && prev.hash === hash) {
        prev.mtimeMs = mtimeMs
        continue
      }
      this.bump({ kind: 'meeting', id, hash, updatedAt: m.updatedAt || now, deleted: false, mtimeMs })
      changed++
    }

    const small = (kind: RecordKind, items: { id: string }[]) => {
      for (const it of items) {
        const key = ek(kind, it.id)
        seen.add(key)
        const hash = hashOf(it)
        const prev = this.state.entries[key]
        if (prev && !prev.deleted && prev.hash === hash) continue
        this.bump({ kind, id: it.id, hash, updatedAt: now, deleted: false })
        changed++
      }
    }
    small('folder', this.readFolders())
    small('template', this.customTemplates())

    for (const [key, e] of Object.entries(this.state.entries)) {
      if (e.deleted || seen.has(key)) continue
      this.bump({ kind: e.kind, id: e.id, hash: DELETED, updatedAt: now, deleted: true, mtimeMs: undefined })
      changed++
    }
    if (changed) this.persist()
    return changed
  }

  /** The current record for an entry, read from disk (or a tombstone). */
  record(kind: RecordKind, id: string): SyncRecord | undefined {
    const e = this.state.entries[ek(kind, id)]
    if (!e) return undefined
    if (e.deleted) return { v: 1, kind, id, updatedAt: e.updatedAt, deleted: true }
    let data: unknown
    if (kind === 'meeting') data = this.store.getMeeting(id)
    else if (kind === 'folder') data = this.readFolders().find((f) => f.id === id)
    else data = this.customTemplates().find((t) => t.id === id)
    if (!data) return { v: 1, kind, id, updatedAt: e.updatedAt, deleted: true }
    return { v: 1, kind, id, updatedAt: e.updatedAt, data }
  }

  changesSince(since: number, limit: number): { entries: IndexEntry[]; more: boolean } {
    const all = this.entries()
      .filter((e) => e.seq > since)
      .sort((a, b) => a.seq - b.seq)
    return { entries: all.slice(0, limit), more: all.length > limit }
  }

  /** Writes a record to disk exactly as given and records it as a new local change. */
  write(rec: SyncRecord): IndexEntry {
    const { kind, id } = rec
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad record id: ${id}`)
    if (kind === 'meeting') {
      if (rec.deleted) this.store.deleteMeeting(id)
      else this.store.saveMeeting({ ...(rec.data as Meeting), id, updatedAt: rec.updatedAt }, { keepUpdatedAt: true })
    } else if (kind === 'folder') {
      const rest = this.readFolders().filter((f) => f.id !== id)
      writeAtomic(this.foldersPath(), JSON.stringify(rec.deleted ? rest : [...rest, { ...(rec.data as Folder), id }], null, 2))
    } else if (kind === 'template') {
      if (rec.deleted) this.store.deleteTemplate(id)
      else this.store.saveTemplate({ ...(rec.data as Template), id, builtIn: undefined })
    }
    let mtimeMs: number | undefined
    if (kind === 'meeting' && !rec.deleted) mtimeMs = statSync(join(this.store.meetingsDir, `${id}.json`)).mtimeMs
    const hash = rec.deleted ? DELETED : hashOf(kind === 'meeting' ? this.store.getMeeting(id) : rec.data)
    const e = this.bump({ kind, id, hash, updatedAt: rec.updatedAt, deleted: !!rec.deleted, mtimeMs })
    this.persist()
    return e
  }

  /** Merges an incoming record with the local copy (see resolveRecords) and writes the result if it changed. */
  apply(incoming: SyncRecord): { entry: IndexEntry | undefined; result: SyncRecord; needsPush: boolean } {
    const local = this.record(incoming.kind, incoming.id)
    // This computer is the authority for its own transcripts (it appends and removes echo segments).
    const { result, needsPush, localChanged } = resolveRecords(local, incoming, 'local')
    const entry = localChanged ? this.write(result) : this.state.entries[ek(incoming.kind, incoming.id)]
    return { entry, result, needsPush }
  }

  hashFor(rec: SyncRecord): string {
    return rec.deleted ? DELETED : hashOf(rec.data)
  }

  entry(kind: RecordKind, id: string): IndexEntry | undefined {
    return this.state.entries[ek(kind, id)]
  }
}
