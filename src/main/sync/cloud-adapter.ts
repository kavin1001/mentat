// Connects the desktop's LocalIndex to the generic SyncClient for cloud sync.
import type { LocalAdapter, PendingChange, SyncRecord } from '@mentat/sync-core'
import type { LocalIndex } from './local-index'

export class DesktopCloudAdapter implements LocalAdapter {
  appliedRemote = 0

  constructor(private index: LocalIndex) {}

  async getCursor() {
    return this.index.state.cloudCursor
  }
  async setCursor(seq: number) {
    this.index.state.cloudCursor = seq
    this.index.persist()
  }

  async pendingChanges(): Promise<PendingChange[]> {
    this.index.scan()
    const out: PendingChange[] = []
    for (const e of this.index.entries()) {
      if (e.cloudHash === e.hash) continue
      if (e.deleted && e.cloudHash === undefined) {
        // Created and deleted before it ever reached the cloud: nothing to tell anyone.
        e.cloudHash = e.hash
        continue
      }
      const record = this.index.record(e.kind, e.id)
      if (record) out.push({ record, baseSeq: e.cloudBase ?? 0 })
    }
    return out
  }

  async applyRemote(record: SyncRecord, seq: number) {
    const before = this.index.entry(record.kind, record.id)?.hash
    this.index.apply(record)
    const e = this.index.entry(record.kind, record.id)
    if (e) {
      e.cloudBase = seq
      // If the local copy won or was merged, its hash differs from the cloud's and it stays pending.
      e.cloudHash = this.index.hashFor(record)
      if (e.hash !== before) this.appliedRemote++
    }
    this.index.persist()
  }

  async markPushed(record: SyncRecord, seq: number) {
    const e = this.index.entry(record.kind, record.id)
    if (!e) return
    e.cloudBase = seq
    e.cloudHash = this.index.hashFor(record)
    this.index.persist()
  }
}
