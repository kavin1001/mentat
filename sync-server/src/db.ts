// SQLite storage (Node's built-in node:sqlite, no native dependencies).
// The relay stores profiles (username, salt, kdf params, sha256 of the auth key), sessions
// (sha256 of the token) and, per profile, the latest encrypted blob for each opaque record key.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import type { KdfParams, WireChange, WorkspaceDetail, WorkspaceInviteInfo, WorkspaceMemberInfo, WorkspaceRole, WorkspaceSummary } from '@mentat/sync-core'

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

      -- Shared workspaces. meta and bundles are ciphertext; see sync-core/src/workspace.ts.
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL REFERENCES profiles(username) ON DELETE CASCADE,
        meta TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 1,
        seq INTEGER NOT NULL DEFAULT 0,
        rotate_needed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ws_members (
        ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        username TEXT NOT NULL REFERENCES profiles(username) ON DELETE CASCADE,
        role TEXT NOT NULL,
        public_key TEXT NOT NULL,
        binding TEXT NOT NULL,
        invite_id TEXT,
        bundle TEXT,
        bundle_epoch INTEGER,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (ws_id, username)
      );
      CREATE INDEX IF NOT EXISTS ws_members_by_user ON ws_members (username);
      CREATE TABLE IF NOT EXISTS ws_invites (
        id TEXT PRIMARY KEY,
        ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        wrapped TEXT NOT NULL,
        secret_enc TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_by TEXT,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS ws_records (
        ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        seq INTEGER NOT NULL,
        blob TEXT NOT NULL,
        author TEXT NOT NULL,
        PRIMARY KEY (ws_id, key)
      );
      CREATE INDEX IF NOT EXISTS ws_records_by_seq ON ws_records (ws_id, seq);
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
    this.tx(() => {
      // Workspaces this profile belonged to (but didn't own) need a key rotation.
      this.db.prepare('UPDATE workspaces SET rotate_needed = 1 WHERE id IN (SELECT ws_id FROM ws_members WHERE username = ?) AND owner != ?').run(username, username)
      this.db.prepare('DELETE FROM profiles WHERE username = ?').run(username)
    })
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

  // ---------- workspaces ----------

  createWorkspace(w: { id: string; owner: string; meta: string; publicKey: string; bundle: string }): boolean {
    try {
      this.tx(() => {
        const now = new Date().toISOString()
        this.db.prepare('INSERT INTO workspaces (id, owner, meta, created_at) VALUES (?, ?, ?, ?)').run(w.id, w.owner, w.meta, now)
        this.db
          .prepare("INSERT INTO ws_members (ws_id, username, role, public_key, binding, bundle, bundle_epoch, joined_at) VALUES (?, ?, 'owner', ?, '', ?, 1, ?)")
          .run(w.id, w.owner, w.publicKey, w.bundle, now)
      })
      return true
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) return false
      throw e
    }
  }

  membership(wsId: string, username: string): { role: WorkspaceRole; epoch: number; owner: string } | null {
    const r = this.db
      .prepare('SELECT m.role, w.epoch, w.owner FROM ws_members m JOIN workspaces w ON w.id = m.ws_id WHERE m.ws_id = ? AND m.username = ?')
      .get(wsId, username) as { role: WorkspaceRole; epoch: number; owner: string } | undefined
    return r ?? null
  }

  private summaryRows(where: string, ...args: (string | number)[]): WorkspaceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT w.id, w.owner, w.meta, w.epoch, w.rotate_needed, m.role, m.bundle, m.bundle_epoch,
                (SELECT COUNT(*) FROM ws_members x WHERE x.ws_id = w.id) AS n
         FROM ws_members m JOIN workspaces w ON w.id = m.ws_id WHERE ${where} ORDER BY w.created_at`
      )
      .all(...args) as {
      id: string
      owner: string
      meta: string
      epoch: number
      rotate_needed: number
      role: WorkspaceRole
      bundle: string | null
      bundle_epoch: number | null
      n: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      owner: r.owner,
      role: r.role,
      epoch: r.epoch,
      meta: r.meta,
      bundle: r.bundle ?? undefined,
      bundleEpoch: r.bundle_epoch ?? undefined,
      memberCount: r.n,
      rotateNeeded: r.role === 'owner' ? !!r.rotate_needed : undefined
    }))
  }

  listWorkspaces(username: string): WorkspaceSummary[] {
    return this.summaryRows('m.username = ?', username)
  }

  workspaceDetail(wsId: string, username: string): WorkspaceDetail | null {
    const [sum] = this.summaryRows('m.ws_id = ? AND m.username = ?', wsId, username)
    if (!sum) return null
    const members = (
      this.db
        .prepare('SELECT username, role, public_key, binding, invite_id, joined_at, bundle_epoch FROM ws_members WHERE ws_id = ? ORDER BY joined_at')
        .all(wsId) as { username: string; role: WorkspaceRole; public_key: string; binding: string; invite_id: string | null; joined_at: string; bundle_epoch: number | null }[]
    ).map(
      (m): WorkspaceMemberInfo => ({
        username: m.username,
        role: m.role,
        publicKey: m.public_key,
        binding: m.binding,
        inviteId: m.invite_id ?? undefined,
        joinedAt: m.joined_at,
        bundleEpoch: m.bundle_epoch ?? undefined
      })
    )
    let invites: WorkspaceInviteInfo[] | undefined
    if (sum.role === 'owner') {
      invites = (
        this.db
          .prepare('SELECT id, role, created_at, expires_at, used_by, used_at, secret_enc FROM ws_invites WHERE ws_id = ? ORDER BY created_at')
          .all(wsId) as { id: string; role: WorkspaceRole; created_at: string; expires_at: string; used_by: string | null; used_at: string | null; secret_enc: string }[]
      ).map((i) => ({
        id: i.id,
        role: i.role,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
        usedBy: i.used_by ?? undefined,
        usedAt: i.used_at ?? undefined,
        secretEnc: i.secret_enc
      }))
    }
    return { ...sum, members, invites }
  }

  deleteWorkspace(wsId: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(wsId)
  }

  createInvite(wsId: string, i: { id: string; tokenHash: string; role: WorkspaceRole; wrapped: string; secretEnc: string; expiresAt: string }): boolean {
    try {
      this.db
        .prepare('INSERT INTO ws_invites (id, ws_id, token_hash, role, wrapped, secret_enc, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(i.id, wsId, i.tokenHash, i.role, i.wrapped, i.secretEnc, new Date().toISOString(), i.expiresAt)
      return true
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test((e as Error).message)) return false
      throw e
    }
  }

  deleteInvite(wsId: string, inviteId: string): void {
    this.db.prepare('DELETE FROM ws_invites WHERE ws_id = ? AND id = ? AND used_by IS NULL').run(wsId, inviteId)
  }

  /** Single use: marks the invite used and adds the member, atomically. */
  redeemInvite(
    wsId: string,
    tokenHash: string,
    username: string,
    publicKey: string,
    binding: string
  ): { ok: true; role: WorkspaceRole; epoch: number; wrapped: string } | { ok: false; error: string } {
    return this.tx(() => {
      const inv = this.db.prepare('SELECT id, role, wrapped, expires_at, used_by FROM ws_invites WHERE ws_id = ? AND token_hash = ?').get(wsId, tokenHash) as
        | { id: string; role: WorkspaceRole; wrapped: string; expires_at: string; used_by: string | null }
        | undefined
      if (!inv) return { ok: false as const, error: 'That invite doesn’t exist or was revoked.' }
      if (inv.used_by) return { ok: false as const, error: inv.used_by === username ? 'You already joined with this invite.' : 'That invite was already used.' }
      if (inv.expires_at < new Date().toISOString()) return { ok: false as const, error: 'That invite has expired. Ask for a new one.' }
      if (this.membership(wsId, username)) return { ok: false as const, error: 'You’re already a member of this workspace.' }
      const now = new Date().toISOString()
      this.db.prepare('UPDATE ws_invites SET used_by = ?, used_at = ? WHERE id = ?').run(username, now, inv.id)
      this.db
        .prepare('INSERT INTO ws_members (ws_id, username, role, public_key, binding, invite_id, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(wsId, username, inv.role, publicKey, binding, inv.id, now)
      const { epoch } = this.db.prepare('SELECT epoch FROM workspaces WHERE id = ?').get(wsId) as { epoch: number }
      return { ok: true as const, role: inv.role, epoch, wrapped: inv.wrapped }
    })
  }

  setBundle(wsId: string, username: string, bundle: string, epoch: number): void {
    this.db.prepare('UPDATE ws_members SET bundle = ?, bundle_epoch = ? WHERE ws_id = ? AND username = ?').run(bundle, epoch, wsId, username)
  }

  setRole(wsId: string, username: string, role: WorkspaceRole): boolean {
    return this.db.prepare("UPDATE ws_members SET role = ? WHERE ws_id = ? AND username = ? AND role != 'owner'").run(role, wsId, username).changes > 0
  }

  removeMember(wsId: string, username: string): boolean {
    return this.tx(() => {
      const n = this.db.prepare("DELETE FROM ws_members WHERE ws_id = ? AND username = ? AND role != 'owner'").run(wsId, username).changes
      if (n) this.db.prepare('UPDATE workspaces SET rotate_needed = 1 WHERE id = ?').run(wsId)
      return n > 0
    })
  }

  /** New key epoch: every current member gets a new bundle, and unused invites (which carry old keys) are revoked. */
  rotate(wsId: string, epoch: number, meta: string, bundles: Record<string, string>): string | null {
    return this.tx(() => {
      const w = this.db.prepare('SELECT epoch FROM workspaces WHERE id = ?').get(wsId) as { epoch: number } | undefined
      if (!w) return 'No such workspace.'
      if (epoch !== w.epoch + 1) return 'Someone rotated this workspace’s keys at the same time. Try again.'
      const members = (this.db.prepare('SELECT username FROM ws_members WHERE ws_id = ?').all(wsId) as { username: string }[]).map((m) => m.username)
      const missing = members.filter((u) => typeof bundles[u] !== 'string')
      if (missing.length) return `Missing new keys for: ${missing.join(', ')}`
      const set = this.db.prepare('UPDATE ws_members SET bundle = ?, bundle_epoch = ? WHERE ws_id = ? AND username = ?')
      for (const u of members) set.run(bundles[u], epoch, wsId, u)
      this.db.prepare('UPDATE workspaces SET epoch = ?, meta = ?, rotate_needed = 0 WHERE id = ?').run(epoch, meta, wsId)
      this.db.prepare('DELETE FROM ws_invites WHERE ws_id = ? AND used_by IS NULL').run(wsId)
      return null
    })
  }

  wsPull(wsId: string, since: number, limit: number): { changes: WireChange[]; latest: number; more: boolean } {
    return this.tx(() => {
      const rows = this.db
        .prepare('SELECT key, seq, blob, author FROM ws_records WHERE ws_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(wsId, since, limit + 1) as unknown as WireChange[]
      const latest = (this.db.prepare('SELECT seq FROM workspaces WHERE id = ?').get(wsId) as { seq: number }).seq
      return { changes: rows.slice(0, limit).map((r) => ({ ...r })), latest, more: rows.length > limit }
    })
  }

  /**
   * Same optimistic concurrency as a profile's feed, plus authorship: a record can be overwritten only
   * by whoever wrote it first, or by the workspace owner. Returns an error string if any item is refused.
   */
  wsPush(wsId: string, username: string, isOwner: boolean, items: { key: string; baseSeq: number; blob: string }[]) {
    return this.tx(() => {
      const getRec = this.db.prepare('SELECT key, seq, blob, author FROM ws_records WHERE ws_id = ? AND key = ?')
      for (const it of items) {
        const cur = getRec.get(wsId, it.key) as WireChange | undefined
        if (cur && cur.author !== username && !isOwner) return { error: 'You can only change meetings you shared.' } as const
      }
      const bump = this.db.prepare('UPDATE workspaces SET seq = seq + 1 WHERE id = ? RETURNING seq')
      const upsert = this.db.prepare(
        'INSERT INTO ws_records (ws_id, key, seq, blob, author) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ws_id, key) DO UPDATE SET seq = excluded.seq, blob = excluded.blob'
      )
      const results = items.map((it) => {
        const cur = getRec.get(wsId, it.key) as WireChange | undefined
        if (cur && cur.seq > it.baseSeq) return { key: it.key, ok: false as const, current: { ...cur } }
        const { seq } = bump.get(wsId) as { seq: number }
        upsert.run(wsId, it.key, seq, it.blob, cur?.author ?? username)
        return { key: it.key, ok: true as const, seq }
      })
      return { results } as const
    })
  }
}
