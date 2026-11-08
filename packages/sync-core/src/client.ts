// Generic sync client: pull, apply last-writer-wins, push local changes with optimistic concurrency.
// Desktop (as a cloud client) and mobile (to cloud or to a paired desktop) each provide a LocalAdapter.
import { openRecord, sealRecord, type SyncKeys } from './crypto'
import type { PullResponse, PushItem, PushResponse, ServerInfo, WireChange } from './protocol'
import type { SyncRecord } from './records'

export interface PendingChange {
  record: SyncRecord
  /** Server seq this record was last synced at, 0 if never. */
  baseSeq: number
}

export interface LocalAdapter {
  getCursor(): Promise<number>
  setCursor(seq: number): Promise<void>
  /** Local records that changed since they were last pushed. */
  pendingChanges(): Promise<PendingChange[]>
  /**
   * Apply a record from the server at `seq`. The adapter decides last-writer-wins (see incomingWins):
   * if the local copy is newer it keeps it, stays pending, and records `seq` as its new base.
   */
  applyRemote(record: SyncRecord, seq: number): Promise<void>
  /** The server accepted `record` at `seq`. Clear pending unless the record changed again meanwhile. */
  markPushed(record: SyncRecord, seq: number): Promise<void>
}

export interface SyncStats {
  pulled: number
  pushed: number
  conflicts: number
  errors: string[]
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export class SyncTransport {
  constructor(
    readonly baseUrl: string,
    private token: () => string | undefined,
    // Wrapped so fetch is never called with the transport as `this` (browsers throw "Illegal invocation").
    private fetchImpl: FetchLike = (url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init),
    private timeoutMs = 20000
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const t = this.token()
    if (t) headers.authorization = `Bearer ${t}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : undefined
    try {
      const res = await this.fetchImpl(this.baseUrl.replace(/\/+$/, '') + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl?.signal
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const j = (await res.json()) as { error?: string }
          if (j?.error) msg = j.error
        } catch {
          /* not json */
        }
        throw new HttpError(res.status, msg)
      }
      return (await res.json()) as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  info() {
    return this.request<ServerInfo>('GET', '/v1/info')
  }
  pull(since: number, limit = 200) {
    return this.request<PullResponse>('GET', `/v1/changes?since=${since}&limit=${limit}`)
  }
  push(changes: PushItem[]) {
    return this.request<PushResponse>('POST', '/v1/changes', { changes })
  }
}

const PUSH_BATCH = 50

export class SyncClient {
  private running: Promise<SyncStats> | null = null

  constructor(
    private transport: SyncTransport,
    private keys: SyncKeys,
    private local: LocalAdapter
  ) {}

  /** Runs one full sync. Concurrent calls share the run in progress. */
  sync(): Promise<SyncStats> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null))
    return this.running
  }

  private async applyWire(c: WireChange, stats: SyncStats): Promise<void> {
    let rec: SyncRecord
    try {
      rec = openRecord(this.keys, c.key, c.blob)
    } catch (e) {
      stats.errors.push(`could not decrypt a change (seq ${c.seq}): ${(e as Error).message}`)
      return
    }
    await this.local.applyRemote(rec, c.seq)
    stats.pulled++
  }

  private async pullAll(stats: SyncStats): Promise<void> {
    let since = await this.local.getCursor()
    for (let page = 0; page < 10000; page++) {
      const res = await this.transport.pull(since)
      for (const c of res.changes) await this.applyWire(c, stats)
      const last = res.changes.length ? res.changes[res.changes.length - 1].seq : since
      // Advance only past changes actually received, so nothing written concurrently is skipped.
      if (last !== since) await this.local.setCursor((since = last))
      if (!res.more) return
    }
  }

  private async run(): Promise<SyncStats> {
    const stats: SyncStats = { pulled: 0, pushed: 0, conflicts: 0, errors: [] }
    await this.pullAll(stats)
    // Push, resolving conflicts by applying the server's copy (LWW) and retrying.
    const ourSeqs: number[] = []
    for (let round = 0; round < 4; round++) {
      const pending = await this.local.pendingChanges()
      if (!pending.length) break
      let conflicted = false
      for (let i = 0; i < pending.length; i += PUSH_BATCH) {
        const batch = pending.slice(i, i + PUSH_BATCH)
        const sealed = batch.map((p) => ({ p, s: sealRecord(this.keys, p.record) }))
        const res = await this.transport.push(sealed.map(({ p, s }) => ({ key: s.key, baseSeq: p.baseSeq, blob: s.blob })))
        const byKey = new Map(sealed.map(({ p, s }) => [s.key, p]))
        for (const r of res.results) {
          const p = byKey.get(r.key)
          if (!p) continue
          if (r.ok) {
            await this.local.markPushed(p.record, r.seq)
            ourSeqs.push(r.seq)
            stats.pushed++
          } else {
            stats.conflicts++
            conflicted = true
            await this.applyWire(r.current, stats)
          }
        }
      }
      if (!conflicted) break
    }
    // If the server's seqs right after our cursor are all our own writes, skip re-downloading them.
    let cursor = await this.local.getCursor()
    const start = cursor
    for (const seq of ourSeqs.sort((a, b) => a - b)) if (seq === cursor + 1) cursor = seq
    if (cursor !== start) await this.local.setCursor(cursor)
    return stats
  }
}
