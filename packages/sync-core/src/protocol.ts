// The HTTP API spoken by both sync servers: the cloud relay (sync-server/) and the desktop app's
// local-network server for a paired phone. One client implementation talks to either.
//
//   GET    /v1/info                         -> ServerInfo                  (no auth)
//   GET    /v1/changes?since=N&limit=M      -> PullResponse                (auth)
//   POST   /v1/changes   PushRequest        -> PushResponse                (auth)
//
// Cloud relay only (profiles are optional and exist only when the user turns on cloud features):
//   POST   /v1/profiles  CreateProfileRequest -> SessionResponse
//   GET    /v1/profiles/:username/kdf         -> KdfResponse
//   POST   /v1/sessions  SignInRequest        -> SessionResponse
//   DELETE /v1/sessions                       -> {}                        (auth, signs out this token)
//   DELETE /v1/profiles/me                    -> {}                        (auth, deletes profile and all data)
//
// Auth: `Authorization: Bearer <token>`. On the cloud relay the token comes from a session.
// On the desktop's local server the token is hex(authKey) derived from the pairing secret.
import type { KdfParams } from './crypto'

export const PROTOCOL_VERSION = 1

export interface ServerInfo {
  app: 'mentat-sync'
  protocol: number
  mode: 'cloud' | 'local'
  name: string
}

export interface WireChange {
  key: string
  seq: number
  blob: string
}

export interface PullResponse {
  changes: WireChange[]
  /** Highest seq on the server (informational, e.g. for progress). */
  latest: number
  more: boolean
}

export interface PushItem {
  key: string
  /** The server seq this client last saw for the key (0 if never). Rejected if the server has something newer. */
  baseSeq: number
  blob: string
}

export interface PushRequest {
  changes: PushItem[]
}

export type PushResult = { key: string; ok: true; seq: number } | { key: string; ok: false; current: WireChange }

export interface PushResponse {
  results: PushResult[]
}

export interface CreateProfileRequest {
  username: string
  salt: string
  kdf: KdfParams
  authKey: string
}

export interface KdfResponse {
  salt: string
  kdf: KdfParams
}

export interface SignInRequest {
  username: string
  authKey: string
}

export interface SessionResponse {
  token: string
  expiresAt: string
}

/** What the desktop's pairing QR code encodes (as JSON, prefixed with `mentat-pair:`). */
export interface PairingPayload {
  v: 1
  /** Desktop's LAN addresses to try, e.g. ["http://192.168.1.20:47823"]. */
  urls: string[]
  /** base64url 32-byte pairing secret. */
  secret: string
  name: string
}

export const PAIRING_PREFIX = 'mentat-pair:'

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/
export const MIN_PASSWORD_LENGTH = 10
