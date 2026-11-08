// On-device persistence for synced records: one JSON file per record under the app's documents folder.
// Secrets (pairing secret, cloud key and token) are kept separately in the OS keychain (see connection.ts).
import { Directory, File, Paths } from 'expo-file-system'
import type { RecordKind, RecordPersistence, StoredRecord } from '@mentat/sync-core'

const root = () => new Directory(Paths.document, 'mentat')
const recordsDir = () => new Directory(root(), 'records')
const fileFor = (kind: RecordKind, id: string) => new File(recordsDir(), `${kind}__${id}.json`)
const cursorFile = () => new File(root(), 'cursor.json')

function ensure() {
  const d = recordsDir()
  if (!d.exists) d.create({ intermediates: true, idempotent: true })
}

export async function loadAll(): Promise<{ records: StoredRecord[]; cursor: number }> {
  ensure()
  const records: StoredRecord[] = []
  for (const entry of recordsDir().list()) {
    if (!(entry instanceof File) || !entry.name.endsWith('.json')) continue
    try {
      records.push(JSON.parse(await entry.text()) as StoredRecord)
    } catch {
      // ignore a corrupt file; the next sync from scratch will restore it
    }
  }
  const c = cursorFile()
  const cursor = c.exists ? Number(JSON.parse(await c.text()).cursor) || 0 : 0
  return { records, cursor }
}

export const filePersistence: RecordPersistence = {
  async saveRecord(s: StoredRecord) {
    ensure()
    const f = fileFor(s.record.kind, s.record.id)
    f.write(JSON.stringify(s))
  },
  async removeRecord(kind, id) {
    const f = fileFor(kind, id)
    if (f.exists) f.delete()
  },
  async saveCursor(cursor: number) {
    ensure()
    cursorFile().write(JSON.stringify({ cursor }))
  }
}
