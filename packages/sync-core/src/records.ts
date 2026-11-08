// What syncs. Every synced object is a SyncRecord: a meeting, a folder or a custom template,
// or a tombstone for one that was deleted. The record's data is the exact JSON object the desktop
// app stores (see src/shared/types.ts), so new optional fields on those types sync without changes here.

export type RecordKind = 'meeting' | 'folder' | 'template'
export const RECORD_KINDS: RecordKind[] = ['meeting', 'folder', 'template']

export interface SyncRecord<T = unknown> {
  v: 1
  kind: RecordKind
  id: string
  /** ISO time of the last change. Conflicts resolve last-writer-wins on this value. */
  updatedAt: string
  deleted?: boolean
  data?: T
}

export function tombstone(kind: RecordKind, id: string, at = new Date().toISOString()): SyncRecord {
  return { v: 1, kind, id, updatedAt: at, deleted: true }
}

/** Stable JSON (sorted keys) so two devices compute the same hash for the same content. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  )
}

/**
 * Last-writer-wins. Returns true when `incoming` should replace `local`.
 * Ties (same updatedAt, different content) break on the content itself so every device picks the same winner.
 */
export function incomingWins(local: SyncRecord | undefined, incoming: SyncRecord): boolean {
  if (!local) return true
  if (incoming.updatedAt !== local.updatedAt) return incoming.updatedAt > local.updatedAt
  const a = stableStringify(incoming)
  const b = stableStringify(local)
  return a !== b && a > b
}

interface MeetingLike {
  transcript?: unknown[]
  updatedAt?: string
}

function laterIso(after: string): string {
  const now = new Date().toISOString()
  if (now > after) return now
  return new Date(Date.parse(after) + 1).toISOString()
}

/**
 * Which side's transcript to keep when two versions of a meeting meet. Only computers write transcripts
 * (they append while recording and also remove echo segments), so the desktop keeps its own ('local')
 * and the phone takes the one that came from the server ('incoming').
 */
export type TranscriptAuthority = 'local' | 'incoming'

/**
 * Resolves a local record against an incoming one: last-writer-wins on the whole record, except that a
 * meeting's transcript always comes from the transcript authority, so a phone editing notes while the
 * computer is still recording never drops or resurrects transcript lines.
 *
 * Returns the record to store, and whether it differs from `incoming` (then it must be pushed back).
 */
export function resolveRecords(
  local: SyncRecord | undefined,
  incoming: SyncRecord,
  transcriptFrom: TranscriptAuthority = 'incoming'
): { result: SyncRecord; needsPush: boolean; localChanged: boolean } {
  if (!local) return { result: incoming, needsPush: false, localChanged: true }
  const inWins = incomingWins(local, incoming)
  const winner = inWins ? incoming : local
  let result = winner
  if (winner.kind === 'meeting' && !local.deleted && !incoming.deleted) {
    const authority = (transcriptFrom === 'local' ? local : incoming).data as MeetingLike
    const w = winner.data as MeetingLike
    if (stableStringify(w.transcript ?? []) !== stableStringify(authority.transcript ?? [])) {
      const updatedAt = laterIso(incoming.updatedAt > local.updatedAt ? incoming.updatedAt : local.updatedAt)
      result = { ...winner, updatedAt, data: { ...w, transcript: authority.transcript ?? [], updatedAt } }
    }
  }
  const same = (a: SyncRecord, b: SyncRecord) => stableStringify(a) === stableStringify(b)
  return { result, needsPush: !same(result, incoming), localChanged: !same(result, local) }
}
