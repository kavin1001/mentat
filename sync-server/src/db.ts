// SQLite storage (Node's built-in node:sqlite, no native dependencies).
// The relay stores profiles (username, salt, kdf params, sha256 of the auth key), sessions
// (sha256 of the token) and, per profile, the latest encrypted blob for each opaque record key.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import type { KdfParams, WireChange } from '@mentat/sync-core'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export interface Profile {
  username: string
  salt: string
  kdf: KdfParams
  verifier: string
}

export class RelayDb {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS profiles (
        username TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        kdf TEXT NOT NULL,
        verifier TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES profiles(username) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        username TEXT NOT NULL REFERENCES profiles(username) ON DELETE CASCADE,
        key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        blob TEXT NOT NULL,
        PRIMARY KEY (username, key)
      );
      CREATE INDEX IF NOT EXISTS records_by_seq ON records (username, seq);
    `)
  }

  close() {
    this.db.close()
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  getProfile(username: string): Profile | null {
    const row = this.db.prepare('SELECT username, salt, kdf, verifier FROM profiles WHERE username = ?').get(username) as
      | { username: string; salt: string; kdf: string; verifier: string }
      | undefined
    return row ? { ...row, kdf: JSON.parse(row.kdf) as KdfParams } : null
  }

  createProfile(p: Profile): boolean {
    try {
      this.db
        .prepare('INSERT INTO profiles (username, salt, kdf, verifier, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(p.username, p.salt, JSON.stringify(p.kdf), p.verifier, new Date().toISOString())
      return true
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) return false
      throw e
    }
  }

  deleteProfile(username: string): void {
    this.db.prepare('DELETE FROM profiles WHERE username = ?').run(username)
  }

  createSession(username: string, ttlDays: number): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + ttlDays * 86400_000).toISOString()
    this.db.prepare('INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)').run(sha(token), username, expiresAt)
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString())
    return { token, expiresAt }
  }

  sessionUser(token: string): string | null {
    const row = this.db.prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?').get(sha(token)) as
      | { username: string; expires_at: string }
      | undefined
    if (!row || row.expires_at < new Date().toISOString()) return null
    return row.username
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token))
  }

  /** Changes after `since`, plus the profile's latest seq, read in one transaction. */
  pull(username: string, since: number, limit: number): { changes: WireChange[]; latest: number; more: boolean } {
    return this.tx(() => {
      const rows = this.db
        .prepare('SELECT key, seq, blob FROM records WHERE username = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(username, since, limit + 1) as unknown as WireChange[]
      const latest = (this.db.prepare('SELECT seq FROM profiles WHERE username = ?').get(username) as { seq: number }).seq
      const more = rows.length > limit
      return { changes: rows.slice(0, limit), latest, more }
    })
  }

  /** Optimistic concurrency per record: a write is accepted only if the client saw the current version. */
  push(username: string, items: { key: string; baseSeq: number; blob: string }[]) {
    return this.tx(() => {
      const getRec = this.db.prepare('SELECT key, seq, blob FROM records WHERE username = ? AND key = ?')
      const bump = this.db.prepare('UPDATE profiles SET seq = seq + 1 WHERE username = ? RETURNING seq')
      const upsert = this.db.prepare(
        'INSERT INTO records (username, key, seq, blob) VALUES (?, ?, ?, ?) ON CONFLICT (username, key) DO UPDATE SET seq = excluded.seq, blob = excluded.blob'
      )
      return items.map((it) => {
        const cur = getRec.get(username, it.key) as WireChange | undefined
        if (cur && cur.seq > it.baseSeq) return { key: it.key, ok: false as const, current: { ...cur } }
        const { seq } = bump.get(username) as { seq: number }
        upsert.run(username, it.key, seq, it.blob)
        return { key: it.key, ok: true as const, seq }
      })
    })
  }

  usage(username: string): { records: number; bytes: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(blob)), 0) AS b FROM records WHERE username = ?').get(username) as {
      n: number
      b: number
    }
    return { records: r.n, bytes: r.b }
  }
}
