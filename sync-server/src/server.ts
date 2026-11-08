// Mentat cloud sync relay. Optional: Mentat works fully locally without it. When a user turns on
// cloud features they create a password-gated profile here; the password never leaves their devices
// (only a key derived from it), and every record is encrypted on-device before upload.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHmac, randomBytes } from 'node:crypto'
import {
  DEFAULT_KDF,
  PROTOCOL_VERSION,
  USERNAME_RE,
  safeEqual,
  verifierFor,
  hexToBytes,
  toBase64,
  type CreateProfileRequest,
  type KdfParams,
  type PushRequest,
  type ServerInfo,
  type SignInRequest
} from '@mentat/sync-core'
import { RelayDb } from './db'

export interface RelayConfig {
  dbPath: string
  name?: string
  /** If set, creating a profile requires this code (keeps a public relay from being used by strangers). */
  signupCode?: string
  /** Set to false to stop new profiles entirely once yours exists. */
  allowSignups?: boolean
  sessionDays?: number
  maxBodyBytes?: number
  /** Secret used to answer kdf lookups for unknown usernames with a stable fake salt. */
  serverSecret?: string
}

class HttpErr extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** Fixed-window limiter for sign-in attempts. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(
    private max: number,
    private windowMs: number
  ) {}
  check(key: string) {
    const now = Date.now()
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k)
      return
    }
    if (++h.n > this.max) throw new HttpErr(429, 'Too many attempts. Try again in a few minutes.')
  }
}

const isHex = (s: unknown, len: number): s is string => typeof s === 'string' && s.length === len && /^[0-9a-f]+$/.test(s)

function validKdf(k: unknown): k is KdfParams {
  const x = k as KdfParams
  return !!x && x.alg === 'scrypt' && Number.isInteger(x.N) && x.N >= 2 ** 14 && x.N <= 2 ** 20 && (x.N & (x.N - 1)) === 0 && x.r >= 1 && x.r <= 16 && x.p >= 1 && x.p <= 4
}

export function createRelay(cfg: RelayConfig): { server: Server; db: RelayDb } {
  const db = new RelayDb(cfg.dbPath)
  const maxBody = cfg.maxBodyBytes ?? 32 * 1024 * 1024
  const secret = cfg.serverSecret ?? randomBytes(32).toString('hex')
  const signinLimiter = new Limiter(10, 10 * 60_000)
  const signupLimiter = new Limiter(5, 60 * 60_000)

  const readJson = (req: IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > maxBody) {
          reject(new HttpErr(413, 'Request too large'))
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          reject(new HttpErr(400, 'Invalid JSON'))
        }
      })
      req.on('error', reject)
    })

  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization
    return h?.startsWith('Bearer ') ? h.slice(7) : undefined
  }
  const requireUser = (req: IncomingMessage) => {
    const t = bearer(req)
    const u = t ? db.sessionUser(t) : null
    if (!u) throw new HttpErr(401, 'Signed out. Sign in to your Mentat profile again.')
    return u
  }
  const ip = (req: IncomingMessage) => req.socket.remoteAddress ?? '?'

  async function route(req: IncomingMessage, url: URL): Promise<unknown> {
    const p = url.pathname
    const m = req.method ?? 'GET'

    if (m === 'GET' && p === '/v1/info') {
      const info: ServerInfo = { app: 'mentat-sync', protocol: PROTOCOL_VERSION, mode: 'cloud', name: cfg.name ?? 'Mentat cloud' }
      return info
    }

    if (m === 'POST' && p === '/v1/profiles') {
      if (cfg.allowSignups === false) throw new HttpErr(403, 'This server is not accepting new profiles.')
      signupLimiter.check(ip(req))
      const b = (await readJson(req)) as CreateProfileRequest & { signupCode?: string }
      if (cfg.signupCode && !safeEqual(String(b.signupCode ?? ''), cfg.signupCode)) throw new HttpErr(403, 'Wrong signup code for this server.')
      const username = String(b.username ?? '').toLowerCase()
      if (!USERNAME_RE.test(username)) throw new HttpErr(400, 'Username must be 3-64 characters: letters, numbers, dot, dash or underscore.')
      if (typeof b.salt !== 'string' || b.salt.length < 16 || b.salt.length > 64) throw new HttpErr(400, 'Bad salt')
      if (!validKdf(b.kdf)) throw new HttpErr(400, 'Unsupported key derivation parameters')
      if (!isHex(b.authKey, 64)) throw new HttpErr(400, 'Bad auth key')
      if (!db.createProfile({ username, salt: b.salt, kdf: b.kdf, verifier: verifierFor(hexToBytes(b.authKey)) }))
        throw new HttpErr(409, 'That username is taken.')
      return db.createSession(username, cfg.sessionDays ?? 90)
    }

    const kdfMatch = /^\/v1\/profiles\/([^/]+)\/kdf$/.exec(p)
    if (m === 'GET' && kdfMatch) {
      const username = decodeURIComponent(kdfMatch[1]).toLowerCase()
      const prof = USERNAME_RE.test(username) ? db.getProfile(username) : null
      if (prof) return { salt: prof.salt, kdf: prof.kdf }
      // Unknown user: answer with a stable fake salt so usernames can't be enumerated.
      const fake = createHmac('sha256', secret).update(username).digest().subarray(0, 16)
      return { salt: toBase64(fake), kdf: DEFAULT_KDF }
    }

    if (m === 'POST' && p === '/v1/sessions') {
      const b = (await readJson(req)) as SignInRequest
      const username = String(b.username ?? '').toLowerCase()
      signinLimiter.check(`u:${username}`)
      signinLimiter.check(`ip:${ip(req)}`)
      const prof = USERNAME_RE.test(username) ? db.getProfile(username) : null
      const presented = isHex(b.authKey, 64) ? verifierFor(hexToBytes(b.authKey)) : ''
      if (!prof || !safeEqual(presented, prof.verifier)) throw new HttpErr(401, 'Wrong username or password.')
      return db.createSession(username, cfg.sessionDays ?? 90)
    }

    if (m === 'DELETE' && p === '/v1/sessions') {
      const t = bearer(req)
      if (t) db.deleteSession(t)
      return {}
    }

    if (m === 'DELETE' && p === '/v1/profiles/me') {
      db.deleteProfile(requireUser(req))
      return {}
    }

    if (m === 'GET' && p === '/v1/usage') return db.usage(requireUser(req))

    if (p === '/v1/changes') {
      const user = requireUser(req)
      if (m === 'GET') {
        const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200))
        return db.pull(user, since, limit)
      }
      if (m === 'POST') {
        const b = (await readJson(req)) as PushRequest
        if (!Array.isArray(b.changes) || b.changes.length > 500) throw new HttpErr(400, 'Bad changes')
        for (const c of b.changes)
          if (!isHex(c?.key, 40) || typeof c.blob !== 'string' || !Number.isInteger(c.baseSeq) || c.baseSeq < 0) throw new HttpErr(400, 'Bad change')
        return { results: db.push(user, b.changes) }
      }
    }

    throw new HttpErr(404, 'Not found')
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    try {
      const url = new URL(req.url ?? '/', 'http://relay')
      const body = await route(req, url)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    } catch (e) {
      const status = e instanceof HttpErr ? e.status : 500
      if (status === 500) console.error(e)
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: status === 500 ? 'Server error' : (e as Error).message }))
    }
  })
  return { server, db }
}
