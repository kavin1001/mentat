// Optional cloud profile: username + password on a sync relay. Only exists when the user turns on
// cloud features. The password is stretched on-device; the relay receives only the derived auth key.
import { DEFAULT_KDF, bytesToHex, keysFromMaster, masterFromPassword, newSalt, type KdfParams, type SyncKeys } from './crypto'
import { fromBase64, toBase64 } from './encoding'
import { SyncTransport, type FetchLike } from './client'
import { MIN_PASSWORD_LENGTH, USERNAME_RE, type KdfResponse, type SessionResponse } from './protocol'

export interface CloudSession {
  serverUrl: string
  username: string
  token: string
  expiresAt: string
  /** 32-byte master secret, hex. Store it in the OS keychain / secure store, never in plain files. */
  master: string
}

export function cloudKeys(s: Pick<CloudSession, 'master'>): SyncKeys {
  return keysFromMaster(Uint8Array.from(s.master.match(/../g)!.map((h) => parseInt(h, 16))))
}

export function validateNewProfile(username: string, password: string): string | null {
  if (!USERNAME_RE.test(username.toLowerCase())) return 'Username must be 3-64 characters: letters, numbers, dot, dash or underscore.'
  if (password.length < MIN_PASSWORD_LENGTH) return `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`
  return null
}

export async function createProfile(opts: {
  serverUrl: string
  username: string
  password: string
  signupCode?: string
  kdf?: KdfParams
  fetch?: FetchLike
  onProgress?: (f: number) => void
}): Promise<CloudSession> {
  const username = opts.username.trim().toLowerCase()
  const err = validateNewProfile(username, opts.password)
  if (err) throw new Error(err)
  const t = new SyncTransport(opts.serverUrl, () => undefined, opts.fetch)
  const info = await t.info()
  if (info.app !== 'mentat-sync' || info.mode !== 'cloud') throw new Error('That address is not a Mentat sync server.')
  const salt = newSalt()
  const kdf = opts.kdf ?? DEFAULT_KDF
  const master = await masterFromPassword(opts.password, salt, kdf, opts.onProgress)
  const keys = keysFromMaster(master)
  const s = await t.request<SessionResponse>('POST', '/v1/profiles', {
    username,
    salt: toBase64(salt),
    kdf,
    authKey: bytesToHex(keys.authKey),
    signupCode: opts.signupCode
  })
  return { serverUrl: opts.serverUrl, username, token: s.token, expiresAt: s.expiresAt, master: bytesToHex(master) }
}

export async function signIn(opts: { serverUrl: string; username: string; password: string; fetch?: FetchLike; onProgress?: (f: number) => void }): Promise<CloudSession> {
  const username = opts.username.trim().toLowerCase()
  const t = new SyncTransport(opts.serverUrl, () => undefined, opts.fetch)
  const k = await t.request<KdfResponse>('GET', `/v1/profiles/${encodeURIComponent(username)}/kdf`)
  const master = await masterFromPassword(opts.password, fromBase64(k.salt), k.kdf, opts.onProgress)
  const keys = keysFromMaster(master)
  const s = await t.request<SessionResponse>('POST', '/v1/sessions', { username, authKey: bytesToHex(keys.authKey) })
  return { serverUrl: opts.serverUrl, username, token: s.token, expiresAt: s.expiresAt, master: bytesToHex(master) }
}

export async function signOut(s: CloudSession, fetchImpl?: FetchLike): Promise<void> {
  await new SyncTransport(s.serverUrl, () => s.token, fetchImpl).request('DELETE', '/v1/sessions').catch(() => undefined)
}

export async function deleteProfile(s: CloudSession, fetchImpl?: FetchLike): Promise<void> {
  await new SyncTransport(s.serverUrl, () => s.token, fetchImpl).request('DELETE', '/v1/profiles/me')
}
