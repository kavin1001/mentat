import type { SyncStatus } from '../../main/sync/manager'

const inv = <T,>(ch: string, ...args: unknown[]) => window.mentat.invoke(ch, ...args) as Promise<T>

export type { SyncStatus }

export const syncApi = {
  status: () => inv<SyncStatus>('sync:status'),
  setLocalEnabled: (enabled: boolean) => inv<SyncStatus>('sync:local:setEnabled', enabled),
  pair: (name: string) => inv<{ deviceId: string; payload: string; qr: string }>('sync:local:pair', name),
  removeDevice: (id: string) => inv<SyncStatus>('sync:local:removeDevice', id),
  createProfile: (o: { serverUrl: string; username: string; password: string; signupCode?: string }) => inv<SyncStatus>('sync:cloud:create', o),
  signIn: (o: { serverUrl: string; username: string; password: string }) => inv<SyncStatus>('sync:cloud:signIn', o),
  signOut: () => inv<SyncStatus>('sync:cloud:signOut'),
  deleteProfile: () => inv<SyncStatus>('sync:cloud:delete'),
  syncNow: () => inv<SyncStatus>('sync:now'),
  onStatus: (cb: (s: SyncStatus) => void) => window.mentat.on('sync:status', cb),
  onDataChanged: (cb: () => void) => window.mentat.on('sync:dataChanged', cb)
}
