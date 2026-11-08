// Electron glue for sync: settings persistence (secrets in the OS keychain via safeStorage),
// the local pairing server, the optional cloud profile, timers, and IPC for the Settings UI.
//
// Default: nothing is on. No account, no network listener. The user can
//   - turn on "Phone on this network" and pair a phone with a QR code (no password), and/or
//   - turn on cloud features by creating or signing in to a password-gated profile on a sync relay.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { app, safeStorage, type IpcMain } from 'electron'
import QRCode from 'qrcode'
import {
  SyncClient,
  SyncTransport,
  HttpError,
  cloudKeys,
  createProfile,
  deleteProfile,
  signIn,
  signOut,
  type CloudSession,
  type SyncStats
} from '@mentat/sync-core'
import type { Store } from '../../shared/store'
import { LocalIndex } from './local-index'
import { DEFAULT_LOCAL_PORT, LocalSyncServer, newPairing, pairingPayload, type PairedDevice } from './local-server'
import { DesktopCloudAdapter } from './cloud-adapter'
import { WorkspaceService, type WorkspacesStatus } from './workspaces'
import { listLocalWorkspaces, workspaceStore } from '../../shared/workspaces'

interface StoredSync {
  local: { enabled: boolean; port: number; devices: (Omit<PairedDevice, 'secret'> & { secret: string })[] }
  cloud: (Omit<CloudSession, 'token' | 'master'> & { token: string; master: string }) | null
}

export interface SyncStatus {
  local: { enabled: boolean; listening: boolean; port: number; devices: { id: string; name: string; createdAt: string; lastSeenAt?: string }[]; error?: string }
  cloud: { active: boolean; serverUrl?: string; username?: string; lastSyncAt?: string; lastError?: string; syncing: boolean; lastStats?: SyncStats }
  keychain: boolean
}

const CLOUD_INTERVAL_MS = 30_000

export class SyncManager {
  private index: LocalIndex
  private server: LocalSyncServer
  private data: StoredSync
  private cloud: CloudSession | null = null
  private client: SyncClient | null = null
  private adapter: DesktopCloudAdapter
  private timer: NodeJS.Timeout | null = null
  private localError?: string
  private cloudState: { lastSyncAt?: string; lastError?: string; syncing: boolean; lastStats?: SyncStats } = { syncing: false }
  readonly workspaces: WorkspaceService

  constructor(
    private store: Store,
    private notify: { dataChanged: () => void; statusChanged: (s: SyncStatus) => void; workspacesChanged?: (s: WorkspacesStatus) => void }
  ) {
    this.workspaces = new WorkspaceService(store, () => this.cloud)
    this.index = new LocalIndex(store)
    this.index.scan()
    this.adapter = new DesktopCloudAdapter(this.index)
    this.server = new LocalSyncServer(this.index, {
      onRemoteChange: () => {
        this.notify.dataChanged()
        void this.syncCloud() // forward phone edits to the cloud too, if it's on
      },
      onDeviceSeen: (d) => {
        const stored = this.data.local.devices.find((x) => x.id === d.id)
        if (stored && (!stored.lastSeenAt || Date.parse(d.lastSeenAt!) - Date.parse(stored.lastSeenAt) > 60_000)) {
          stored.lastSeenAt = d.lastSeenAt
          this.save()
        }
      }
    })
    this.data = this.load()
    this.server.setDevices(this.devices())
    const c = this.data.cloud
    if (c) this.cloud = { ...c, token: this.unseal(c.token), master: this.unseal(c.master) }
  }

  // ---------- persistence ----------
  private path() {
    return join(app.getPath('userData'), 'sync.json')
  }
  private load(): StoredSync {
    const empty: StoredSync = { local: { enabled: false, port: DEFAULT_LOCAL_PORT, devices: [] }, cloud: null }
    if (!existsSync(this.path())) return empty
    try {
      return { ...empty, ...(JSON.parse(readFileSync(this.path(), 'utf8')) as StoredSync) }
    } catch {
      return empty
    }
  }
  private save() {
    writeFileSync(this.path(), JSON.stringify(this.data, null, 2), { mode: 0o600 })
    this.notify.statusChanged(this.status())
  }
  private seal(s: string) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer has no keychain available, so Mentat can’t store sync secrets safely.')
    return 'enc:' + safeStorage.encryptString(s).toString('base64')
  }
  private unseal(s: string) {
    return s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s
  }
  private devices(): PairedDevice[] {
    return this.data.local.devices.flatMap((d) => {
      try {
        return [{ ...d, secret: this.unseal(d.secret) }]
      } catch {
        return []
      }
    })
  }

  status(): SyncStatus {
    return {
      local: {
        enabled: this.data.local.enabled,
        listening: this.server.listening,
        port: this.data.local.port,
        devices: this.data.local.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, lastSeenAt })),
        error: this.localError
      },
      cloud: { active: !!this.cloud, serverUrl: this.cloud?.serverUrl, username: this.cloud?.username, ...this.cloudState },
      keychain: safeStorage.isEncryptionAvailable()
    }
  }

  // ---------- lifecycle ----------
  async start() {
    if (this.data.local.enabled) await this.startLocal()
    if (this.cloud) this.startCloudLoop()
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.server.stop()
  }

  // ---------- local pairing ----------
  private async startLocal() {
    try {
      await this.server.start(this.data.local.port)
      this.localError = undefined
    } catch (e) {
      this.localError = `Couldn't listen on port ${this.data.local.port}: ${(e as Error).message}`
    }
  }

  async setLocalEnabled(enabled: boolean) {
    this.data.local.enabled = enabled
    if (enabled) await this.startLocal()
    else await this.server.stop()
    this.save()
    return this.status()
  }

  async pairDevice(name: string) {
    if (!this.data.local.enabled) await this.setLocalEnabled(true)
    const d = newPairing(name.trim() || 'Phone')
    this.data.local.devices.push({ ...d, secret: this.seal(d.secret) })
    this.server.setDevices(this.devices())
    this.save()
    const payload = pairingPayload(d, this.server.port ?? this.data.local.port, hostname())
    return { deviceId: d.id, payload, qr: await QRCode.toDataURL(payload, { margin: 1, width: 320, errorCorrectionLevel: 'M' }) }
  }

  removeDevice(id: string) {
    this.data.local.devices = this.data.local.devices.filter((d) => d.id !== id)
    this.server.setDevices(this.devices())
    this.save()
    return this.status()
  }

  // ---------- cloud ----------
  private setCloud(s: CloudSession | null) {
    this.cloud = s
    this.client = null
    this.data.cloud = s ? { ...s, token: this.seal(s.token), master: this.seal(s.master) } : null
    const identity = s ? `${s.serverUrl}|${s.username}` : undefined
    if (!s || this.index.state.cloudIdentity !== identity) {
      // A different (or no) profile: its sync state starts from scratch.
      this.index.state.cloudIdentity = identity
      this.index.state.cloudCursor = 0
      for (const e of this.index.entries()) {
        delete e.cloudBase
        delete e.cloudHash
      }
      this.index.persist()
      this.cloudState = { syncing: false }
    }
    this.save()
  }

  async createCloudProfile(opts: { serverUrl: string; username: string; password: string; signupCode?: string }) {
    this.setCloud(await createProfile(opts))
    this.startCloudLoop()
    return this.status()
  }

  async signInCloud(opts: { serverUrl: string; username: string; password: string }) {
    this.setCloud(await signIn(opts))
    this.startCloudLoop()
    return this.status()
  }

  async signOutCloud() {
    if (this.cloud) await signOut(this.cloud)
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.workspaces.clearLocal()
    this.setCloud(null)
    this.notifyWorkspaces()
    return this.status()
  }

  /** Deletes the profile and every synced record from the relay. Local files are untouched. */
  async deleteCloudProfile() {
    if (this.cloud) await deleteProfile(this.cloud)
    return this.signOutCloud()
  }

  private startCloudLoop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.syncCloud(), CLOUD_INTERVAL_MS)
    void this.syncCloud()
  }

  async syncCloud(): Promise<SyncStatus> {
    const s = this.cloud
    if (!s) return this.status()
    if (!this.client) this.client = new SyncClient(new SyncTransport(s.serverUrl, () => this.cloud?.token), cloudKeys(s), this.adapter)
    this.cloudState.syncing = true
    this.notify.statusChanged(this.status())
    const before = this.adapter.appliedRemote
    try {
      const stats = await this.client.sync()
      this.cloudState = { syncing: false, lastSyncAt: new Date().toISOString(), lastStats: stats, lastError: stats.errors[0] }
    } catch (e) {
      const msg = e instanceof HttpError && e.status === 401 ? 'Signed out of your Mentat profile. Sign in again to keep syncing.' : (e as Error).message
      this.cloudState = { ...this.cloudState, syncing: false, lastError: msg }
    }
    if (this.adapter.appliedRemote !== before) this.notify.dataChanged()
    this.notify.statusChanged(this.status())
    void this.syncWorkspaces()
    return this.status()
  }

  // ---------- shared workspaces ----------
  private notifyWorkspaces() {
    this.notify.workspacesChanged?.(this.workspaces.status())
  }

  /** Runs a workspace action (or a plain sync) and tells the UI about new shared meetings. */
  private async wsRun<T>(fn: () => Promise<T> | T): Promise<T> {
    const before = this.workspaces.receivedChanges
    try {
      return await fn()
    } finally {
      if (this.workspaces.receivedChanges !== before) this.notify.dataChanged()
      this.notifyWorkspaces()
    }
  }

  syncWorkspaces() {
    if (!this.cloud) return Promise.resolve(this.workspaces.status())
    return this.wsRun(() => this.workspaces.sync())
  }

  /** Call after the app itself saves something, so changes reach the cloud quickly. */
  touch() {
    if (this.cloud) void this.syncCloud()
  }

  registerIpc(ipc: IpcMain) {
    const h = ipc.handle.bind(ipc)
    h('sync:status', () => this.status())
    h('sync:local:setEnabled', (_e, enabled: boolean) => this.setLocalEnabled(enabled))
    h('sync:local:pair', (_e, name: string) => this.pairDevice(name))
    h('sync:local:removeDevice', (_e, id: string) => this.removeDevice(id))
    h('sync:cloud:create', (_e, opts) => this.createCloudProfile(opts))
    h('sync:cloud:signIn', (_e, opts) => this.signInCloud(opts))
    h('sync:cloud:signOut', () => this.signOutCloud())
    h('sync:cloud:delete', () => this.deleteCloudProfile())
    h('sync:now', () => this.syncCloud())

    const w = this.workspaces
    h('ws:status', () => w.status())
    h('ws:sync', () => this.syncWorkspaces())
    h('ws:create', (_e, name: string) => this.wsRun(() => w.create(name)))
    h('ws:detail', (_e, id: string) => w.detail(id))
    h('ws:invite', (_e, id: string, role: 'editor' | 'viewer', days?: number) => w.invite(id, role, days))
    h('ws:revokeInvite', (_e, id: string, inviteId: string) => w.revokeInvite(id, inviteId))
    h('ws:join', (_e, code: string) => this.wsRun(() => w.join(code)))
    h('ws:setRole', (_e, id: string, username: string, role: 'editor' | 'viewer') => this.wsRun(() => w.setRole(id, username, role)))
    h('ws:removeMember', (_e, id: string, username: string) => this.wsRun(() => w.removeMember(id, username)))
    h('ws:leave', (_e, id: string) => this.wsRun(() => w.leave(id)))
    h('ws:delete', (_e, id: string) => this.wsRun(() => w.remove(id)))
    h('ws:shareFolder', (_e, id: string, folderId: string, shared: boolean) => this.wsRun(() => w.shareFolder(id, folderId, shared)))
    h('ws:shareMeeting', (_e, id: string, meetingId: string, shared: boolean) => this.wsRun(() => w.shareMeeting(id, meetingId, shared)))
    // Read side: meetings others shared, from the local cache.
    h('ws:local', () => listLocalWorkspaces(this.store.dataDir))
    h('ws:meetings', (_e, id: string, query?: string) => workspaceStore(this.store.dataDir, id).listMeetings({ query }))
    h('ws:meeting', (_e, id: string, meetingId: string) => workspaceStore(this.store.dataDir, id).getMeeting(meetingId))
  }
}
