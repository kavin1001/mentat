// In-memory record store with pluggable persistence, used by the mobile app (and tests) as its
// LocalAdapter. One store per sync target (paired computer or cloud profile).
import type { LocalAdapter, PendingChange } from './client'
import { resolveRecords, tombstone, type RecordKind, type SyncRecord } from './records'

export interface StoredRecord {
  record: SyncRecord
  /** Server seq last synced at (0 = never synced). */
  base: number
  /** Changed locally and not yet accepted by the server. */
  pending: boolean
}

export interface RecordPersistence {
  saveRecord(s: StoredRecord): Promise<void>
  removeRecord(kind: RecordKind, id: string): Promise<void>
  saveCursor(cursor: number): Promise<void>
}

export const memoryPersistence = (): RecordPersistence => ({
  saveRecord: async () => {},
  removeRecord: async () => {},
  saveCursor: async () => {}
})

const k = (kind: RecordKind, id: string) => `${kind}:${id}`

export class RecordStore implements LocalAdapter {
  private map = new Map<string, StoredRecord>()
  private listeners = new Set<() => void>()
  private notifyQueued = false

  constructor(
    private persistence: RecordPersistence = memoryPersistence(),
    initial: StoredRecord[] = [],
    private cursor = 0
  ) {
    for (const s of initial) this.map.set(k(s.record.kind, s.record.id), s)
  }

  // ---------- reading ----------
  get<T>(kind: RecordKind, id: string): T | undefined {
    const s = this.map.get(k(kind, id))
    return s && !s.record.deleted ? (s.record.data as T) : undefined
  }

  list<T>(kind: RecordKind): T[] {
    const out: T[] = []
    for (const s of this.map.values()) if (s.record.kind === kind && !s.record.deleted) out.push(s.record.data as T)
    return out
  }

  pendingCount(): number {
    let n = 0
    for (const s of this.map.values()) if (s.pending) n++
    return n
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      for (const l of this.listeners) l()
    })
  }

  // ---------- local edits ----------
  /** Saves a local edit. `data` must carry `id`; meetings should carry their own updatedAt. */
  async put<T extends { id: string; updatedAt?: string }>(kind: RecordKind, data: T): Promise<T> {
    const updatedAt = new Date().toISOString()
    const saved = (kind === 'meeting' ? { ...data, updatedAt } : data) as T
    const prev = this.map.get(k(kind, data.id))
    const s: StoredRecord = { record: { v: 1, kind, id: data.id, updatedAt, data: saved }, base: prev?.base ?? 0, pending: true }
    this.map.set(k(kind, data.id), s)
    await this.persistence.saveRecord(s)
    this.changed()
    return saved
  }

  async remove(kind: RecordKind, id: string): Promise<void> {
    const prev = this.map.get(k(kind, id))
    if (!prev) return
    if (prev.base === 0) {
      // Never reached the server: just forget it.
      this.map.delete(k(kind, id))
      await this.persistence.removeRecord(kind, id)
    } else {
      const s: StoredRecord = { record: tombstone(kind, id), base: prev.base, pending: true }
      this.map.set(k(kind, id), s)
      await this.persistence.saveRecord(s)
    }
    this.changed()
  }

  // ---------- LocalAdapter ----------
  async getCursor() {
    return this.cursor
  }
  async setCursor(seq: number) {
    this.cursor = seq
    await this.persistence.saveCursor(seq)
  }

  async pendingChanges(): Promise<PendingChange[]> {
    const out: PendingChange[] = []
    for (const s of this.map.values()) if (s.pending) out.push({ record: s.record, baseSeq: s.base })
    return out
  }

  async applyRemote(incoming: SyncRecord, seq: number): Promise<void> {
    const prev = this.map.get(k(incoming.kind, incoming.id))
    const local = prev?.pending ? prev.record : undefined
    // Records not edited locally simply take the server copy; edited ones go through LWW + merge.
    const { result, needsPush } = local ? resolveRecords(local, incoming, 'incoming') : { result: incoming, needsPush: false }
    const s: StoredRecord = { record: result, base: seq, pending: needsPush }
    this.map.set(k(incoming.kind, incoming.id), s)
    await this.persistence.saveRecord(s)
    this.changed()
  }

  async markPushed(record: SyncRecord, seq: number): Promise<void> {
    const cur = this.map.get(k(record.kind, record.id))
    if (!cur) return
    // Still pending if edited again while the push was in flight.
    const s: StoredRecord = { ...cur, base: seq, pending: cur.record !== record }
    this.map.set(k(record.kind, record.id), s)
    await this.persistence.saveRecord(s)
  }

  /**
   * Prepares for a different sync target (unpairing, signing out, or switching computer/profile):
   * forgets everything that came from the old one, keeps edits that never got synced, and starts over.
   */
  async resetForNewTarget(): Promise<void> {
    for (const [key, s] of [...this.map]) {
      if (s.pending && !s.record.deleted) {
        const kept: StoredRecord = { ...s, base: 0 }
        this.map.set(key, kept)
        await this.persistence.saveRecord(kept)
      } else {
        this.map.delete(key)
        await this.persistence.removeRecord(s.record.kind, s.record.id)
      }
    }
    await this.setCursor(0)
    this.changed()
  }

  /** Wipes everything. */
  async clear(): Promise<void> {
    for (const s of this.map.values()) await this.persistence.removeRecord(s.record.kind, s.record.id)
    this.map.clear()
    await this.setCursor(0)
    this.changed()
  }
}
