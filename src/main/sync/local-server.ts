// Local-network sync server: lets a paired phone sync straight with this desktop, with no account,
// no password and no cloud. Off until the user turns on "Phone on this network" and pairs a device.
//
// Pairing: the desktop makes a random 32-byte secret per phone and shows it once in a QR code. Both
// sides derive keys from it (see sync-core crypto): the auth key is the bearer token, and records are
// end-to-end encrypted, so even on shared Wi-Fi nobody without the QR code can read or change notes.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { networkInterfaces, hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  PAIRING_PREFIX,
  PROTOCOL_VERSION,
  bytesToHex,
  keysFromMaster,
  newPairingSecret,
  openRecord,
  safeEqual,
  sealRecord,
  toBase64Url,
  verifierFor,
  fromBase64,
  type PairingPayload,
  type PushRequest,
  type PushResult,
  type ServerInfo,
  type SyncKeys
} from '@mentat/sync-core'
import type { LocalIndex } from './local-index'

export interface PairedDevice {
  id: string
  name: string
  /** base64url pairing secret. Stored encrypted with the OS keychain by the caller. */
  secret: string
  createdAt: string
  lastSeenAt?: string
}

export const DEFAULT_LOCAL_PORT = 47823

export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  return out
}

export function newPairing(name: string): PairedDevice {
  return { id: randomUUID(), name, secret: toBase64Url(newPairingSecret()), createdAt: new Date().toISOString() }
}

export function pairingPayload(device: PairedDevice, port: number, desktopName = hostname()): string {
  const payload: PairingPayload = {
    v: 1,
    urls: lanAddresses().map((ip) => `http://${ip}:${port}`),
    secret: device.secret,
    name: desktopName
  }
  return PAIRING_PREFIX + JSON.stringify(payload)
}

export class LocalSyncServer {
  private server: Server | null = null
  private keys = new Map<string, { device: PairedDevice; keys: SyncKeys; verifier: string }>()

  constructor(
    private index: LocalIndex,
    private hooks: { onRemoteChange?: () => void; onDeviceSeen?: (d: PairedDevice) => void } = {},
    private name = hostname()
  ) {}

  setDevices(devices: PairedDevice[]) {
    this.keys.clear()
    for (const d of devices) {
      const keys = keysFromMaster(fromBase64(d.secret.replace(/-/g, '+').replace(/_/g, '/')))
      this.keys.set(d.id, { device: d, keys, verifier: verifierFor(keys.authKey) })
    }
  }

  get listening(): boolean {
    return !!this.server?.listening
  }

  private auth(req: IncomingMessage) {
    const h = req.headers.authorization
    const token = h?.startsWith('Bearer ') ? h.slice(7) : ''
    if (!/^[0-9a-f]{64}$/.test(token)) return null
    const v = verifierFor(Uint8Array.from(Buffer.from(token, 'hex')))
    for (const k of this.keys.values()) if (safeEqual(v, k.verifier)) return k
    return null
  }

  start(port = DEFAULT_LOCAL_PORT, host = '0.0.0.0'): Promise<void> {
    if (this.server) return Promise.resolve()
    const server = createServer(async (req, res) => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
      // CORS so the web build of the phone app can sync too. Every data request still needs a paired device's key.
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-headers', 'authorization, content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      if (req.method === 'OPTIONS') return void res.writeHead(204).end()
      try {
        const url = new URL(req.url ?? '/', 'http://local')
        if (req.method === 'GET' && url.pathname === '/v1/info') {
          const info: ServerInfo = { app: 'mentat-sync', protocol: PROTOCOL_VERSION, mode: 'local', name: this.name }
          return reply(200, info)
        }
        if (url.pathname !== '/v1/changes') return reply(404, { error: 'Not found' })
        const who = this.auth(req)
        if (!who) return reply(401, { error: 'This phone is not paired with this computer anymore. Pair it again from Mentat on your computer.' })
        who.device.lastSeenAt = new Date().toISOString()
        this.hooks.onDeviceSeen?.(who.device)
        this.index.scan()

        if (req.method === 'GET') {
          const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200))
          const { entries, more } = this.index.changesSince(since, limit)
          const changes = entries.flatMap((e) => {
            const rec = this.index.record(e.kind, e.id)
            if (!rec) return []
            const { key, blob } = sealRecord(who.keys, rec)
            return [{ key, seq: e.seq, blob }]
          })
          return reply(200, { changes, latest: this.index.latest, more })
        }

        if (req.method === 'POST') {
          const body = await readBody(req, 32 * 1024 * 1024)
          const { changes } = JSON.parse(body) as PushRequest
          if (!Array.isArray(changes)) return reply(400, { error: 'Bad changes' })
          let applied = 0
          const results: PushResult[] = changes.map((c) => {
            let rec
            try {
              rec = openRecord(who.keys, c.key, c.blob)
            } catch {
              return { key: c.key, ok: false as const, current: { key: c.key, seq: 0, blob: '' } }
            }
            const e = this.index.entry(rec.kind, rec.id)
            if (e && e.seq > c.baseSeq) {
              const cur = this.index.record(rec.kind, rec.id)!
              return { key: c.key, ok: false as const, current: { seq: e.seq, ...sealRecord(who.keys, cur) } }
            }
            // Merge rather than overwrite: plain HTTP on a LAN can be replayed, and an old captured
            // write must never roll a note back. A stale record loses last-writer-wins and the phone gets ours.
            const { entry, needsPush } = this.index.apply(rec)
            if (needsPush || !entry) {
              const cur = this.index.record(rec.kind, rec.id)!
              return { key: c.key, ok: false as const, current: { seq: entry?.seq ?? 0, ...sealRecord(who.keys, cur) } }
            }
            applied++
            return { key: c.key, ok: true as const, seq: entry.seq }
          })
          if (applied) this.hooks.onRemoteChange?.()
          return reply(200, { results })
        }
        reply(405, { error: 'Method not allowed' })
      } catch (e) {
        console.error('[local sync]', e)
        reply(500, { error: 'Server error' })
      }
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', (e) => {
        this.server = null
        reject(e)
      })
      server.listen(port, host, () => resolve())
    })
  }

  stop(): Promise<void> {
    const s = this.server
    this.server = null
    return new Promise((r) => (s ? s.close(() => r()) : r()))
  }

  get port(): number | undefined {
    const a = this.server?.address()
    return a && typeof a === 'object' ? a.port : undefined
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export { bytesToHex }
