// Web build (used for previews in a browser): same API backed by localStorage.
import type { RecordPersistence, StoredRecord } from '@mentat/sync-core'

const PREFIX = 'mentat:rec:'

export async function loadAll(): Promise<{ records: StoredRecord[]; cursor: number }> {
  const records: StoredRecord[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    if (k.startsWith(PREFIX)) records.push(JSON.parse(localStorage.getItem(k)!) as StoredRecord)
  }
  return { records, cursor: Number(localStorage.getItem('mentat:cursor') ?? 0) }
}

export const filePersistence: RecordPersistence = {
  async saveRecord(s) {
    localStorage.setItem(`${PREFIX}${s.record.kind}:${s.record.id}`, JSON.stringify(s))
  },
  async removeRecord(kind, id) {
    localStorage.removeItem(`${PREFIX}${kind}:${id}`)
  },
  async saveCursor(cursor) {
    localStorage.setItem('mentat:cursor', String(cursor))
  }
}
