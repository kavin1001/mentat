// Shared workspaces on the desktop (plain Node, no Electron, so it can be tested against a real relay).
//
// A workspace lives on the user's cloud relay and needs a signed-in profile. Its owner invites people
// with single-use codes and gives each a role: viewers read, editors also share their own meetings, the
// owner manages members. Everything is end-to-end encrypted (see sync-core/src/workspace.ts).
//
// On this computer:
//   - Your meetings are shared to a workspace by sharing their folder, or the meeting itself. They are
//     pushed as copies without private fields (your folders, Drive links, other workspace ids).
//   - Meetings others shared are decrypted into ~/Mentat/workspaces/<id>/ (see shared/workspaces.ts),
//     which is what the app's "Shared with me" list and the MCP server read.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HttpError,
  SyncClient,
  SyncTransport,
  stableStringify,
  type CloudSession,
  type FetchLike,
  type LocalAdapter,
  type PendingChange,
  type SyncRecord,
  type SyncStats
} from '@mentat/sync-core'
import {
  bindIdentity,
  canWrite,
  currentEpoch,
  decodeInvite,
  encodeInvite,
  fingerprint,
  identityFromMaster,
  inviteKeys,
  keyringDecrypt,
  keyringEncrypt,
  newInviteSecret,
  newKeyring,
  newWorkspaceId,
  openKeyring,
  openMeta,
  rotateKeyring,
  sealKeyring,
  sealMeta,
  unwrapInvite,
  verifyBinding,
  workspaceCodec,
  wrapForInvite,
  type Identity,
  type RedeemInviteResponse,
  type WorkspaceDetail,
  type WorkspaceKeyring,
  type WorkspaceRole,
  type WorkspaceSummary
} from '@mentat/sync-core/src/workspace'
import { toBase64 } from '@mentat/sync-core'
import type { Store } from '../../shared/store'
import type { LocalWorkspace, Meeting } from '../../shared/types'
import { isSharedTo, workspaceStore, workspacesDir } from '../../shared/workspaces'

interface WsState {
  cursor: number
  /** Your own meetings pushed to this workspace: hash of what was pushed, and its server seq. */
  pushed: Record<string, { hash: string; base: number }>
}

interface StateFile {
  /** "serverUrl|username" these entries belong to. */
  identity?: string
  workspaces: Record<string, WsState>
}

export interface WorkspaceView {
  id: string
  name: string
  role: WorkspaceRole
  owner: string
  memberCount: number
  /** Your folders shared to this workspace. */
  sharedFolderIds: string[]
  /** Meetings shared directly (not through a folder). */
  sharedMeetingIds: string[]
  /** Meetings from other members cached on this computer. */
  receivedCount: number
  /** Joined, but the keys haven't arrived yet. */
  pending?: boolean
  error?: string
}

export interface WorkspaceMemberView {
  username: string
  role: WorkspaceRole
  joinedAt: string
  fingerprint: string
  verified: boolean
}

export interface WorkspaceInviteView {
  id: string
  role: WorkspaceRole
  createdAt: string
  expiresAt: string
  usedBy?: string
}

export interface WorkspacesStatus {
  available: boolean
  me?: string
  fingerprint?: string
  syncing: boolean
  lastSyncAt?: string
  lastError?: string
  workspaces: WorkspaceView[]
}

const hashOf = (v: unknown) => createHash('sha256').update(stableStringify(v)).digest('hex')

function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/** What other members get: the meeting without fields that only make sense (or are private) on your computer. */
export function sharedCopy(m: Meeting, me: string): Meeting {
  const { drive: _d, workspaceIds: _w, calendarEventId: _c, ...rest } = m
  return { ...rest, folderIds: [], sharedBy: me }
}

export class WorkspaceService {
  private statePath: string
  private state: StateFile
  private keyrings = new Map<string, WorkspaceKeyring>()
  private summaries: WorkspaceSummary[] = []
  private names = new Map<string, string>()
  private errors = new Map<string, string>()
  private running: Promise<WorkspacesStatus> | null = null
  private lastSyncAt?: string
  private lastError?: string
  /** Bumped whenever a shared meeting from someone else is written or removed locally. */
  receivedChanges = 0

  constructor(
    private store: Store,
    private session: () => CloudSession | null,
    private fetchImpl?: FetchLike
  ) {
    const dir = join(store.dataDir, '.sync')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.statePath = join(dir, 'workspaces.json')
    this.state = existsSync(this.statePath) ? (JSON.parse(readFileSync(this.statePath, 'utf8')) as StateFile) : { workspaces: {} }
  }

  private persist() {
    writeAtomic(this.statePath, JSON.stringify(this.state))
  }

  private ctx(): { s: CloudSession; id: Identity; t: SyncTransport } {
    const s = this.session()
    if (!s) throw new Error('Turn on cloud features (sign in to a Mentat profile) to use shared workspaces.')
    const identity = `${s.serverUrl}|${s.username}`
    if (this.state.identity !== identity) {
      // Different profile: forget everything that belonged to the previous one.
      this.state = { identity, workspaces: {} }
      this.keyrings.clear()
      this.summaries = []
      this.persist()
      this.removeCaches(new Set())
    }
    return { s, id: identityFromMaster(s.master), t: new SyncTransport(s.serverUrl, () => this.session()?.token, this.fetchImpl) }
  }

  private wsState(id: string): WsState {
    return (this.state.workspaces[id] ??= { cursor: 0, pushed: {} })
  }

  private removeCaches(keep: Set<string>) {
    const dir = workspacesDir(this.store.dataDir)
    if (!existsSync(dir)) return
    for (const ws of listCacheIds(dir)) {
      if (keep.has(ws)) continue
      rmSync(join(dir, ws), { recursive: true, force: true })
      delete this.state.workspaces[ws]
      this.receivedChanges++
    }
  }

  /** Signed out: drop every workspace's local copy, so Claude and the app stop reading them on this computer. */
  clearLocal() {
    this.keyrings.clear()
    this.summaries = []
    this.state = { workspaces: {} }
    this.removeCaches(new Set())
    this.persist()
  }

  // ---------- status ----------

  status(): WorkspacesStatus {
    const s = this.session()
    if (!s) return { available: false, syncing: false, workspaces: [] }
    const folders = this.store.listFolders()
    const meetings = this.store.allMeetings()
    return {
      available: true,
      me: s.username,
      fingerprint: fingerprint(identityFromMaster(s.master).publicKey),
      syncing: !!this.running,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      workspaces: this.summaries.map((w) => ({
        id: w.id,
        name: this.names.get(w.id) ?? 'Shared workspace',
        role: w.role,
        owner: w.owner,
        memberCount: w.memberCount,
        sharedFolderIds: folders.filter((f) => f.workspaceIds?.includes(w.id)).map((f) => f.id),
        sharedMeetingIds: meetings.filter((m) => m.workspaceIds?.includes(w.id)).map((m) => m.id),
        receivedCount: existsSync(join(workspacesDir(this.store.dataDir), w.id)) ? workspaceStore(this.store.dataDir, w.id).allMeetings().length : 0,
        pending: !this.keyrings.has(w.id),
        error: this.errors.get(w.id)
      }))
    }
  }

  // ---------- sync ----------

  /** Refreshes memberships and syncs every workspace. Concurrent calls share one run. */
  sync(): Promise<WorkspacesStatus> {
    if (!this.running)
      this.running = this.run()
        .then(() => {
          this.lastError = undefined
        })
        .catch((e) => {
          this.lastError = e instanceof HttpError && e.status === 401 ? 'Signed out of your Mentat profile.' : (e as Error).message
        })
        .then(() => {
          this.lastSyncAt = new Date().toISOString()
          this.running = null
          return this.status()
        })
    return this.running
  }

  private async refresh(): Promise<void> {
    const { id, t } = this.ctx()
    const { workspaces } = await t.request<{ workspaces: WorkspaceSummary[] }>('GET', '/v1/workspaces')
    this.summaries = workspaces
    this.keyrings.clear()
    for (const w of workspaces) {
      if (!w.bundle) continue
      try {
        const kr = openKeyring(id, w.id, w.bundle)
        this.keyrings.set(w.id, kr)
        this.names.set(w.id, openMeta(kr, w.meta).name)
        this.errors.delete(w.id)
      } catch (e) {
        this.errors.set(w.id, `Can’t open this workspace’s keys: ${(e as Error).message}`)
      }
    }
    // Workspaces you left or were removed from: delete their local copies so neither the app nor Claude
    // keeps reading them.
    this.removeCaches(new Set(workspaces.map((w) => w.id)))
    this.persist()
  }

  private async run(): Promise<void> {
    await this.refresh()
    const { s } = this.ctx()
    for (const w of this.summaries) {
      if (w.role === 'owner' && w.rotateNeeded && this.keyrings.has(w.id)) {
        try {
          await this.rotate(w.id)
        } catch (e) {
          this.errors.set(w.id, `Couldn’t rotate keys after a member left: ${(e as Error).message}`)
        }
      }
    }
    if (this.summaries.some((w) => w.rotateNeeded)) await this.refresh()
    for (const w of this.summaries) {
      const kr = this.keyrings.get(w.id)
      if (!kr) continue
      try {
        await this.syncOne(s, w, kr)
      } catch (e) {
        this.errors.set(w.id, (e as Error).message)
      }
    }
  }

  private async syncOne(s: CloudSession, w: WorkspaceSummary, kr: WorkspaceKeyring): Promise<SyncStats> {
    const t = new SyncTransport(s.serverUrl, () => this.session()?.token, this.fetchImpl).withChangesPath(`/v1/workspaces/${w.id}/changes`)
    const adapter = new WorkspaceAdapter(this, w, s.username)
    const stats = await new SyncClient(t, workspaceCodec(kr), adapter).sync()
    // The member list goes into the local copy too, so Claude can answer "who can see this?".
    const d = await t.request<WorkspaceDetail>('GET', `/v1/workspaces/${w.id}`).catch(() => null)
    this.writeCacheMeta(s, w, d?.members.map((m) => ({ username: m.username, role: m.role })))
    this.persist()
    return stats
  }

  private writeCacheMeta(s: CloudSession, w: WorkspaceSummary, members?: LocalWorkspace['members']) {
    const meta: LocalWorkspace = {
      id: w.id,
      name: this.names.get(w.id) ?? 'Shared workspace',
      role: w.role,
      owner: w.owner,
      serverUrl: s.serverUrl,
      me: s.username,
      members: [],
      syncedAt: new Date().toISOString()
    }
    const st = workspaceStore(this.store.dataDir, w.id)
    const prev = existsSync(join(st.dataDir, 'workspace.json')) ? (JSON.parse(readFileSync(join(st.dataDir, 'workspace.json'), 'utf8')) as LocalWorkspace) : null
    writeAtomic(join(st.dataDir, 'workspace.json'), JSON.stringify({ ...meta, members: members ?? prev?.members ?? [] }, null, 2))
  }

  // ---------- used by WorkspaceAdapter ----------

  /** Your own meetings that should be in workspace `wsId` right now. */
  ownShared(wsId: string): Meeting[] {
    const folders = new Map(this.store.listFolders().map((f) => [f.id, f.workspaceIds]))
    return this.store.allMeetings().filter((m) => !m.sharedBy && isSharedTo(m, wsId, folders))
  }
  stateFor(wsId: string) {
    return this.wsState(wsId)
  }
  cache(wsId: string) {
    return workspaceStore(this.store.dataDir, wsId)
  }

  // ---------- actions ----------

  async create(name: string): Promise<WorkspacesStatus> {
    const { id, t } = this.ctx()
    const n = name.trim()
    if (!n) throw new Error('Give the workspace a name.')
    const wsId = newWorkspaceId()
    const kr = newKeyring(wsId)
    await t.request('POST', '/v1/workspaces', { id: wsId, meta: sealMeta(kr, { name: n }), publicKey: id.publicKey, bundle: sealKeyring(id.publicKey, kr) })
    return this.sync()
  }

  async detail(wsId: string): Promise<{ members: WorkspaceMemberView[]; invites: WorkspaceInviteView[] }> {
    const { t } = this.ctx()
    const d = await t.request<WorkspaceDetail>('GET', `/v1/workspaces/${wsId}`)
    const kr = this.keyrings.get(wsId)
    const members = d.members.map((m) => ({
      username: m.username,
      role: m.role,
      joinedAt: m.joinedAt,
      fingerprint: fingerprint(m.publicKey),
      verified: d.role === 'owner' && kr ? this.verifyMember(kr, d, m.username) : m.role === 'owner'
    }))
    const metaPath = join(workspacesDir(this.store.dataDir), wsId, 'workspace.json')
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as LocalWorkspace
      writeAtomic(metaPath, JSON.stringify({ ...meta, members: d.members.map((m) => ({ username: m.username, role: m.role })) }, null, 2))
    }
    return {
      members,
      invites: (d.invites ?? []).map((i) => ({ id: i.id, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt, usedBy: i.usedBy }))
    }
  }

  /** Checks that a member's public key is the one they bound with the invite you gave them. */
  private verifyMember(kr: WorkspaceKeyring, d: WorkspaceDetail, username: string): boolean {
    const m = d.members.find((x) => x.username === username)
    if (!m) return false
    if (m.role === 'owner') return m.username === d.owner
    const inv = d.invites?.find((i) => i.id === m.inviteId)
    if (!inv || inv.usedBy !== username) return false
    try {
      const secret = keyringDecrypt(kr, inv.secretEnc, `invite:${inv.id}`)
      return verifyBinding(inviteKeys(secret), username, m.publicKey, m.binding)
    } catch {
      return false
    }
  }

  /** Creates a single-use invite. Hand the code to the person privately: it carries the workspace key. */
  async invite(wsId: string, role: 'editor' | 'viewer', days = 7): Promise<{ code: string; expiresAt: string }> {
    const { s, t } = this.ctx()
    const kr = this.keyrings.get(wsId)
    if (!kr) throw new Error('This workspace’s keys aren’t available on this computer yet.')
    const secret = newInviteSecret()
    const ik = inviteKeys(secret)
    const inviteId = randomBytes(12).toString('hex')
    const expiresAt = new Date(Date.now() + Math.min(Math.max(days, 1), 30) * 86400_000).toISOString()
    const name = this.names.get(wsId) ?? 'Shared workspace'
    await t.request('POST', `/v1/workspaces/${wsId}/invites`, {
      id: inviteId,
      tokenHash: ik.tokenHash,
      role,
      wrapped: wrapForInvite(ik, kr, { name }),
      secretEnc: keyringEncrypt(kr, secret, `invite:${inviteId}`),
      expiresAt
    })
    return { code: encodeInvite({ v: 1, server: s.serverUrl, workspaceId: wsId, secret: toBase64(secret), name, role, invitedBy: s.username }), expiresAt }
  }

  async revokeInvite(wsId: string, inviteId: string) {
    await this.ctx().t.request('DELETE', `/v1/workspaces/${wsId}/invites/${inviteId}`)
  }

  /** Joins a workspace from an invite code. */
  async join(code: string): Promise<WorkspacesStatus> {
    const { s, id, t } = this.ctx()
    const inv = decodeInvite(code)
    if (inv.server.replace(/\/+$/, '') !== s.serverUrl.replace(/\/+$/, ''))
      throw new Error(`This invite is for the sync server ${inv.server}, but you’re signed in on ${s.serverUrl}. Sign in to a profile on that server first.`)
    const ik = inviteKeys(inv.secretBytes)
    const r = await t.request<RedeemInviteResponse>('POST', '/v1/invites/redeem', {
      workspaceId: inv.workspaceId,
      token: ik.token,
      publicKey: id.publicKey,
      binding: bindIdentity(ik, s.username, id.publicKey)
    })
    const { keyring } = unwrapInvite(ik, inv.workspaceId, r.wrapped)
    await t.request('PUT', `/v1/workspaces/${inv.workspaceId}/members/me/bundle`, { bundle: sealKeyring(id.publicKey, keyring), epoch: currentEpoch(keyring) })
    return this.sync()
  }

  async setRole(wsId: string, username: string, role: 'editor' | 'viewer') {
    await this.ctx().t.request('PATCH', `/v1/workspaces/${wsId}/members/${encodeURIComponent(username)}`, { role })
    return this.sync()
  }

  /** Removes a member, then rotates the workspace key so they can't read anything shared from now on. */
  async removeMember(wsId: string, username: string) {
    await this.ctx().t.request('DELETE', `/v1/workspaces/${wsId}/members/${encodeURIComponent(username)}`)
    return this.sync()
  }

  async leave(wsId: string) {
    const { s, t } = this.ctx()
    await t.request('DELETE', `/v1/workspaces/${wsId}/members/${encodeURIComponent(s.username)}`)
    this.unshareEverything(wsId)
    return this.sync()
  }

  async remove(wsId: string) {
    await this.ctx().t.request('DELETE', `/v1/workspaces/${wsId}`)
    this.unshareEverything(wsId)
    return this.sync()
  }

  private unshareEverything(wsId: string) {
    for (const f of this.store.listFolders()) if (f.workspaceIds?.includes(wsId)) this.store.updateFolder(f.id, { workspaceIds: f.workspaceIds.filter((x) => x !== wsId) })
    for (const m of this.store.allMeetings())
      if (m.workspaceIds?.includes(wsId)) this.store.saveMeeting({ ...m, workspaceIds: m.workspaceIds.filter((x) => x !== wsId) })
  }

  shareFolder(wsId: string, folderId: string, shared: boolean) {
    const f = this.store.listFolders().find((x) => x.id === folderId)
    if (!f) throw new Error('Folder not found')
    const ids = new Set(f.workspaceIds ?? [])
    if (shared) ids.add(wsId)
    else ids.delete(wsId)
    this.store.updateFolder(folderId, { workspaceIds: [...ids] })
    return this.sync()
  }

  shareMeeting(wsId: string, meetingId: string, shared: boolean) {
    const m = this.store.getMeeting(meetingId)
    if (!m) throw new Error('Meeting not found')
    const ids = new Set(m.workspaceIds ?? [])
    if (shared) ids.add(wsId)
    else ids.delete(wsId)
    this.store.saveMeeting({ ...m, workspaceIds: [...ids] })
    return this.sync()
  }

  /** New key epoch, sealed to every member whose key checks out. Members whose key doesn't are removed. */
  private async rotate(wsId: string): Promise<void> {
    const { id, t } = this.ctx()
    const kr = this.keyrings.get(wsId)!
    const d = await t.request<WorkspaceDetail>('GET', `/v1/workspaces/${wsId}`)
    const next = rotateKeyring(kr)
    const bundles: Record<string, string> = {}
    for (const m of d.members) {
      if (m.role === 'owner') {
        bundles[m.username] = sealKeyring(id.publicKey, next)
        continue
      }
      if (this.verifyMember(kr, d, m.username)) bundles[m.username] = sealKeyring(m.publicKey, next)
      else await t.request('DELETE', `/v1/workspaces/${wsId}/members/${encodeURIComponent(m.username)}`)
    }
    await t.request('POST', `/v1/workspaces/${wsId}/rotate`, { epoch: d.epoch + 1, meta: sealMeta(next, { name: this.names.get(wsId) ?? 'Shared workspace' }), bundles })
    this.keyrings.set(wsId, next)
  }
}

function listCacheIds(dir: string): string[] {
  try {
    return readdirSync(dir).filter((d) => /^[0-9a-f]{32}$/.test(d))
  } catch {
    return []
  }
}

/** Connects one workspace's change feed to this computer: pushes your shared meetings, caches everyone else's. */
class WorkspaceAdapter implements LocalAdapter {
  private st: WsState
  constructor(
    private svc: WorkspaceService,
    private w: WorkspaceSummary,
    private me: string
  ) {
    this.st = svc.stateFor(w.id)
  }

  async getCursor() {
    return this.st.cursor
  }
  async setCursor(seq: number) {
    this.st.cursor = seq
  }

  async pendingChanges(): Promise<PendingChange[]> {
    if (!canWrite(this.w.role)) return []
    const out: PendingChange[] = []
    const now = new Date().toISOString()
    const live = new Set<string>()
    for (const m of this.svc.ownShared(this.w.id)) {
      live.add(m.id)
      const data = sharedCopy(m, this.me)
      const hash = hashOf(data)
      const p = this.st.pushed[m.id]
      if (p?.hash === hash) continue
      out.push({ record: { v: 1, kind: 'meeting', id: m.id, updatedAt: m.updatedAt, data }, baseSeq: p?.base ?? 0 })
    }
    // Unshared or deleted since the last push: take it back out of the workspace.
    for (const [mid, p] of Object.entries(this.st.pushed)) {
      if (live.has(mid) || p.hash === 'deleted') continue
      out.push({ record: { v: 1, kind: 'meeting', id: mid, updatedAt: now, deleted: true }, baseSeq: p.base })
    }
    return out
  }

  async applyRemote(record: SyncRecord, seq: number, info?: { author?: string }) {
    if (record.kind !== 'meeting') return
    const author = info?.author
    if (author === this.me) {
      // Your own meeting: this computer is the source of truth; just remember the server's version.
      const p = this.st.pushed[record.id]
      if (p) p.base = seq
      else this.st.pushed[record.id] = { hash: record.deleted ? 'deleted' : hashOf(record.data), base: seq }
      return
    }
    const cache = this.svc.cache(this.w.id)
    if (record.deleted) cache.deleteMeeting(record.id)
    else if (/^[\w-]+$/.test(record.id))
      // The relay's author is what access control used, so it wins over whatever the record claims.
      cache.saveMeeting({ ...(record.data as Meeting), id: record.id, sharedBy: author ?? (record.data as Meeting).sharedBy, workspaceIds: undefined }, { keepUpdatedAt: true })
    this.svc.receivedChanges++
  }

  async markPushed(record: SyncRecord, seq: number) {
    this.st.pushed[record.id] = { hash: record.deleted ? 'deleted' : hashOf(record.data), base: seq }
  }
}

