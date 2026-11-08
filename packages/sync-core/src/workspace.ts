// Shared workspaces: other people's Mentat profiles can read (and, as editors, add to) a set of
// meetings someone shares with them. Everything stays end-to-end encrypted; the relay only enforces
// who may pull or push which ciphertext.
//
// Keys
//   - Every cloud profile has an X25519 identity key pair, derived from its master secret, so all of
//     the profile's devices share it and nothing extra needs storing.
//   - Every workspace has a keyring: a MAC key (hides meeting ids, never changes) and one encryption
//     key per epoch. The keyring is stored on the relay once per member, sealed to that member's
//     identity public key ("bundle").
//   - Removing a member rotates the keyring: the owner adds a new epoch and seals the new keyring to
//     every remaining member. New and edited meetings use the new key, so a removed member can't read
//     them even if the relay misbehaves.
//
// Invites
//   An invite is a 32-byte secret the owner hands over out of band (a `mentat-invite:` code). From it
//   come a redeem token (the relay stores only its sha256), a wrap key (the keyring travels to the
//   invitee encrypted under it), and a binding key: the invitee MACs their username and public key with
//   it, and the owner checks that MAC before sealing future keyrings to that key. So a relay that swaps
//   in its own public key is caught, and a relay that adds a member on its own never gets keys.
//
// This module needs @noble/curves (peer dependency) and is imported as '@mentat/sync-core/src/workspace'
// so consumers that don't use workspaces (the phone app) don't have to install it.
import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { fromBase64, toBase64, toBase64Url } from './encoding'
import { safeEqual } from './crypto'
import type { RecordKind, SyncRecord } from './records'
import type { RecordCodec } from './client'
import { INVITE_PREFIX, WS_BLOB_VERSION, type InvitePayload } from './workspace-protocol'

export * from './workspace-protocol'

const td = new TextDecoder()
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---------- identity ----------

export interface Identity {
  secretKey: Uint8Array
  /** hex */
  publicKey: string
}

export function identityFromMaster(master: Uint8Array | string): Identity {
  const m = typeof master === 'string' ? hexToBytes(master) : master
  const secretKey = hkdf(sha256, m, undefined, utf8ToBytes('mentat/x25519/v1'), 32)
  return { secretKey, publicKey: bytesToHex(x25519.getPublicKey(secretKey)) }
}

/** Short fingerprint people can compare out of band ("ab12 cd34 ef56 7890"). */
export function fingerprint(publicKeyHex: string): string {
  return bytesToHex(sha256(hexToBytes(publicKeyHex)).subarray(0, 8)).match(/..../g)!.join(' ')
}

/** Anonymous sealed box: ephemeral X25519 + HKDF + XChaCha20-Poly1305. */
export function sealTo(recipientPublicKey: string, plaintext: Uint8Array, aad: string): string {
  const rpk = hexToBytes(recipientPublicKey)
  const eph = x25519.utils.randomSecretKey()
  const epk = x25519.getPublicKey(eph)
  const k = hkdf(sha256, x25519.getSharedSecret(eph, rpk), concat(epk, rpk), utf8ToBytes('mentat/seal/v1'), 32)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(k, nonce, utf8ToBytes(aad)).encrypt(plaintext)
  return toBase64(concat(Uint8Array.of(1), epk, nonce, ct))
}

export function openSealed(id: Identity, sealed: string, aad: string): Uint8Array {
  const raw = fromBase64(sealed)
  if (raw[0] !== 1 || raw.length < 1 + 32 + 24 + 16) throw new Error('unknown sealed format')
  const epk = raw.subarray(1, 33)
  const rpk = hexToBytes(id.publicKey)
  const k = hkdf(sha256, x25519.getSharedSecret(id.secretKey, epk), concat(epk, rpk), utf8ToBytes('mentat/seal/v1'), 32)
  return xchacha20poly1305(k, raw.subarray(33, 57), utf8ToBytes(aad)).decrypt(raw.subarray(57))
}

// ---------- keyring ----------

export interface WorkspaceKeyring {
  workspaceId: string
  /** hex; derives opaque record keys, constant for the workspace's lifetime. */
  macKey: string
  /** Every epoch's key, oldest first. The last one encrypts new writes. */
  keys: { epoch: number; key: string }[]
}

export function newWorkspaceId(): string {
  return bytesToHex(randomBytes(16))
}

export function newKeyring(workspaceId: string): WorkspaceKeyring {
  return { workspaceId, macKey: bytesToHex(randomBytes(32)), keys: [{ epoch: 1, key: bytesToHex(randomBytes(32)) }] }
}

export function rotateKeyring(kr: WorkspaceKeyring): WorkspaceKeyring {
  const epoch = currentEpoch(kr) + 1
  return { ...kr, keys: [...kr.keys, { epoch, key: bytesToHex(randomBytes(32)) }] }
}

export function currentEpoch(kr: WorkspaceKeyring): number {
  return kr.keys[kr.keys.length - 1].epoch
}

function epochKey(kr: WorkspaceKeyring, epoch: number): Uint8Array {
  const k = kr.keys.find((x) => x.epoch === epoch)
  if (!k) throw new Error(`no key for epoch ${epoch}; this workspace's keys were rotated without you`)
  return hexToBytes(k.key)
}

/** Encrypts bytes under the keyring's current epoch: [2][epoch u32 BE][nonce 24][ciphertext]. */
export function keyringEncrypt(kr: WorkspaceKeyring, plaintext: Uint8Array, aad: string): string {
  const epoch = currentEpoch(kr)
  const head = new Uint8Array(5)
  head[0] = WS_BLOB_VERSION
  new DataView(head.buffer).setUint32(1, epoch)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(epochKey(kr, epoch), nonce, utf8ToBytes(`${kr.workspaceId}|${epoch}|${aad}`)).encrypt(plaintext)
  return toBase64(concat(head, nonce, ct))
}

export function keyringDecrypt(kr: WorkspaceKeyring, blob: string, aad: string): Uint8Array {
  const raw = fromBase64(blob)
  if (raw[0] !== WS_BLOB_VERSION || raw.length < 5 + 24 + 16) throw new Error('unknown workspace blob format')
  const epoch = new DataView(raw.buffer, raw.byteOffset).getUint32(1)
  return xchacha20poly1305(epochKey(kr, epoch), raw.subarray(5, 29), utf8ToBytes(`${kr.workspaceId}|${epoch}|${aad}`)).decrypt(raw.subarray(29))
}

export function workspaceRecordKey(kr: WorkspaceKeyring, kind: RecordKind, id: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(kr.macKey), utf8ToBytes(`${kind}:${id}`))).slice(0, 40)
}

/** Lets the generic SyncClient sync a workspace's records. */
export function workspaceCodec(kr: WorkspaceKeyring): RecordCodec {
  return {
    seal(record: SyncRecord) {
      const key = workspaceRecordKey(kr, record.kind, record.id)
      return { key, blob: keyringEncrypt(kr, utf8ToBytes(JSON.stringify(record)), `record:${key}`) }
    },
    open(key: string, blob: string) {
      const rec = JSON.parse(td.decode(keyringDecrypt(kr, blob, `record:${key}`))) as SyncRecord
      if (workspaceRecordKey(kr, rec.kind, rec.id) !== key) throw new Error('record key mismatch')
      return rec
    }
  }
}

export interface WorkspaceMeta {
  name: string
}

export const sealMeta = (kr: WorkspaceKeyring, meta: WorkspaceMeta) => keyringEncrypt(kr, utf8ToBytes(JSON.stringify(meta)), 'meta')
export const openMeta = (kr: WorkspaceKeyring, blob: string) => JSON.parse(td.decode(keyringDecrypt(kr, blob, 'meta'))) as WorkspaceMeta

export function sealKeyring(recipientPublicKey: string, kr: WorkspaceKeyring): string {
  return sealTo(recipientPublicKey, utf8ToBytes(JSON.stringify(kr)), `keyring:${kr.workspaceId}`)
}

export function openKeyring(id: Identity, workspaceId: string, bundle: string): WorkspaceKeyring {
  const kr = JSON.parse(td.decode(openSealed(id, bundle, `keyring:${workspaceId}`))) as WorkspaceKeyring
  if (kr.workspaceId !== workspaceId) throw new Error('keyring is for a different workspace')
  return kr
}

// ---------- invites ----------

export interface InviteKeys {
  /** hex; sent once to redeem. The relay stores sha256 of it. */
  token: string
  tokenHash: string
  wrapKey: Uint8Array
  bindKey: Uint8Array
}

export function newInviteSecret(): Uint8Array {
  return randomBytes(32)
}

export function inviteKeys(secret: Uint8Array): InviteKeys {
  const k = (info: string) => hkdf(sha256, secret, undefined, utf8ToBytes(info), 32)
  const token = bytesToHex(k('mentat/invite/token/v1'))
  return { token, tokenHash: bytesToHex(sha256(hexToBytes(token))), wrapKey: k('mentat/invite/wrap/v1'), bindKey: k('mentat/invite/bind/v1') }
}

export function wrapForInvite(ik: InviteKeys, kr: WorkspaceKeyring, meta: WorkspaceMeta): string {
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(ik.wrapKey, nonce, utf8ToBytes(`invite:${kr.workspaceId}`)).encrypt(utf8ToBytes(JSON.stringify({ keyring: kr, meta })))
  return toBase64(concat(nonce, ct))
}

export function unwrapInvite(ik: InviteKeys, workspaceId: string, wrapped: string): { keyring: WorkspaceKeyring; meta: WorkspaceMeta } {
  const raw = fromBase64(wrapped)
  const out = JSON.parse(td.decode(xchacha20poly1305(ik.wrapKey, raw.subarray(0, 24), utf8ToBytes(`invite:${workspaceId}`)).decrypt(raw.subarray(24))))
  if (out.keyring?.workspaceId !== workspaceId) throw new Error('invite is for a different workspace')
  return out
}

export function bindIdentity(ik: InviteKeys, username: string, publicKey: string): string {
  return bytesToHex(hmac(sha256, ik.bindKey, utf8ToBytes(`${username}|${publicKey}`)))
}

export function verifyBinding(ik: InviteKeys, username: string, publicKey: string, binding: string): boolean {
  return safeEqual(bindIdentity(ik, username, publicKey), binding)
}

export function encodeInvite(p: InvitePayload): string {
  return INVITE_PREFIX + toBase64Url(utf8ToBytes(JSON.stringify(p)))
}

export function decodeInvite(code: string): InvitePayload & { secretBytes: Uint8Array } {
  const s = code.trim()
  if (!s.startsWith(INVITE_PREFIX)) throw new Error('That isn’t a Mentat workspace invite. It should start with “mentat-invite:”.')
  let p: InvitePayload
  try {
    p = JSON.parse(td.decode(fromBase64(s.slice(INVITE_PREFIX.length)))) as InvitePayload
  } catch {
    throw new Error('That invite code is damaged. Ask for it again.')
  }
  if (p.v !== 1 || !p.server || !p.workspaceId || !p.secret) throw new Error('That invite code is damaged. Ask for it again.')
  const secretBytes = fromBase64(p.secret)
  if (secretBytes.length !== 32) throw new Error('That invite code is damaged. Ask for it again.')
  return { ...p, secretBytes }
}
