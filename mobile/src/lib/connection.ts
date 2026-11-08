// What this phone syncs with. Nothing by default: notes made on the phone stay on the phone until
// the user pairs with their computer (local network, no password) or signs in to a cloud profile.
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  PAIRING_PREFIX,
  bytesToHex,
  cloudKeys,
  fromBase64,
  keysFromMaster,
  type CloudSession,
  type PairingPayload,
  type SyncKeys
} from '@mentat/sync-core'

export type Connection =
  | { type: 'local'; name: string; urls: string[]; secret: string; lastUrl?: string }
  | ({ type: 'cloud' } & CloudSession)

const KEY = 'mentat.connection.v1'

const secure = {
  get: (k: string) => (Platform.OS === 'web' ? Promise.resolve(localStorage.getItem(k)) : SecureStore.getItemAsync(k)),
  set: (k: string, v: string) =>
    Platform.OS === 'web'
      ? Promise.resolve(localStorage.setItem(k, v))
      : SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  del: (k: string) => (Platform.OS === 'web' ? Promise.resolve(localStorage.removeItem(k)) : SecureStore.deleteItemAsync(k))
}

export async function loadConnection(): Promise<Connection | null> {
  const raw = await secure.get(KEY)
  return raw ? (JSON.parse(raw) as Connection) : null
}

export async function saveConnection(c: Connection | null): Promise<void> {
  if (c) await secure.set(KEY, JSON.stringify(c))
  else await secure.del(KEY)
}

export function parsePairingCode(text: string): PairingPayload {
  if (!text.startsWith(PAIRING_PREFIX)) throw new Error('That isn’t a Mentat pairing code. Open Settings → Phone on this network on your computer.')
  const p = JSON.parse(text.slice(PAIRING_PREFIX.length)) as PairingPayload
  if (p.v !== 1 || !Array.isArray(p.urls) || !p.secret) throw new Error('This pairing code is from a newer version of Mentat. Update the app.')
  return p
}

export function keysFor(c: Connection): SyncKeys {
  return c.type === 'local' ? keysFromMaster(fromBase64(c.secret)) : cloudKeys(c)
}

export function tokenFor(c: Connection): string {
  return c.type === 'local' ? bytesToHex(keysFor(c).authKey) : c.token
}

export function describe(c: Connection | null): string {
  if (!c) return 'This phone only'
  return c.type === 'local' ? `Paired with ${c.name}` : `Cloud: ${c.username}`
}
