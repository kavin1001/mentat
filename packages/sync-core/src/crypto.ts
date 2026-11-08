// End-to-end encryption for sync. Servers (the cloud relay, or the desktop when it serves a phone
// on the local network) only ever see opaque record keys and ciphertext.
//
// Key material comes from one 32-byte master secret:
//   - cloud profile: scrypt(password, per-profile salt)
//   - local pairing: 32 random bytes shown once in the desktop's pairing QR code
// HKDF splits it into an auth key (proves identity to the server), an encryption key
// (XChaCha20-Poly1305) and a MAC key (hides meeting ids from the server).
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { fromBase64, toBase64 } from './encoding'
import type { RecordKind, SyncRecord } from './records'

export interface KdfParams {
  alg: 'scrypt'
  N: number
  r: number
  p: number
}

/** ~64 MB of memory per guess. Takes ~0.3 s natively, a few seconds in pure JS on a phone (done once per sign-in). */
export const DEFAULT_KDF: KdfParams = { alg: 'scrypt', N: 2 ** 16, r: 8, p: 1 }

export interface SyncKeys {
  /** Sent to the server to sign in. The server stores only sha256(authKey). */
  authKey: Uint8Array
  encKey: Uint8Array
  macKey: Uint8Array
}

const te = new TextDecoder()

export function newSalt(): Uint8Array {
  return randomBytes(16)
}

export function newPairingSecret(): Uint8Array {
  return randomBytes(32)
}

export async function masterFromPassword(
  password: string,
  salt: Uint8Array,
  kdf: KdfParams = DEFAULT_KDF,
  onProgress?: (fraction: number) => void
): Promise<Uint8Array> {
  if (kdf.alg !== 'scrypt') throw new Error(`unsupported kdf ${kdf.alg}`)
  if (kdf.N < 2 ** 14 || kdf.N > 2 ** 20) throw new Error('kdf parameters out of range')
  return scryptAsync(password.normalize('NFKC'), salt, { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, onProgress })
}

export function keysFromMaster(master: Uint8Array): SyncKeys {
  const k = (info: string) => hkdf(sha256, master, undefined, utf8ToBytes(info), 32)
  return { authKey: k('mentat/auth/v1'), encKey: k('mentat/enc/v1'), macKey: k('mentat/mac/v1') }
}

export function verifierFor(authKey: Uint8Array): string {
  return bytesToHex(sha256(authKey))
}

/** Constant-time string compare for hex verifiers/tokens. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Opaque, stable key for a record, so the server can't see which meeting is which. */
export function recordKey(keys: SyncKeys, kind: RecordKind, id: string): string {
  return bytesToHex(hmac(sha256, keys.macKey, utf8ToBytes(`${kind}:${id}`))).slice(0, 40)
}

/** Encrypts a record. The record key is bound as associated data so blobs can't be swapped between keys. */
export function sealRecord(keys: SyncKeys, record: SyncRecord): { key: string; blob: string } {
  const key = recordKey(keys, record.kind, record.id)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(keys.encKey, nonce, utf8ToBytes(key)).encrypt(utf8ToBytes(JSON.stringify(record)))
  const out = new Uint8Array(1 + nonce.length + ct.length)
  out[0] = 1 // format version
  out.set(nonce, 1)
  out.set(ct, 25)
  return { key, blob: toBase64(out) }
}

export function openRecord(keys: SyncKeys, key: string, blob: string): SyncRecord {
  const raw = fromBase64(blob)
  if (raw[0] !== 1 || raw.length < 1 + 24 + 16) throw new Error('unknown blob format')
  const pt = xchacha20poly1305(keys.encKey, raw.subarray(1, 25), utf8ToBytes(key)).decrypt(raw.subarray(25))
  const rec = JSON.parse(te.decode(pt)) as SyncRecord
  if (recordKey(keys, rec.kind, rec.id) !== key) throw new Error('record key mismatch')
  return rec
}

export { bytesToHex, hexToBytes }
