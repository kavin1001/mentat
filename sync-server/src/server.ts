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
  type SignInRequest,
  WORKSPACE_ID_RE,
  WORKSPACE_ROLES,
  blobEpoch,
  type CreateInviteRequest,
  type CreateWorkspaceRequest,
  type RedeemInviteRequest,
  type RotateRequest,
  type WorkspaceRole
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

    if (p === '/v1/workspaces' || p.startsWith('/v1/workspaces/') || p === '/v1/invites/redeem') return workspaceRoute(req, url, m, p)

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

  const isB64 = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/=_-]+$/.test(s)
  const isRole = (r: unknown): r is WorkspaceRole => WORKSPACE_ROLES.includes(r as WorkspaceRole)
  const redeemLimiter = new Limiter(20, 10 * 60_000)

  async function workspaceRoute(req: IncomingMessage, url: URL, m: string, p: string): Promise<unknown> {
    const user = requireUser(req)

    if (p === '/v1/workspaces') {
      if (m === 'GET') return { workspaces: db.listWorkspaces(user) }
      if (m === 'POST') {
        const b = (await readJson(req)) as CreateWorkspaceRequest
        if (!WORKSPACE_ID_RE.test(String(b.id))) throw new HttpErr(400, 'Bad workspace id')
        if (!isHex(b.publicKey, 64) || !isB64(b.meta, 8192) || !isB64(b.bundle, 1 << 20)) throw new HttpErr(400, 'Bad workspace')
        if (db.listWorkspaces(user).filter((w) => w.role === 'owner').length >= 50) throw new HttpErr(400, 'You own too many workspaces.')
        if (!db.createWorkspace({ id: b.id, owner: user, meta: b.meta, publicKey: b.publicKey, bundle: b.bundle })) throw new HttpErr(409, 'Workspace already exists')
        return db.listWorkspaces(user).find((w) => w.id === b.id)
      }
    }

    if (m === 'POST' && p === '/v1/invites/redeem') {
      redeemLimiter.check(`u:${user}`)
      const b = (await readJson(req)) as RedeemInviteRequest
      if (!WORKSPACE_ID_RE.test(String(b.workspaceId)) || !isHex(b.token, 64) || !isHex(b.publicKey, 64) || !isHex(b.binding, 64))
        throw new HttpErr(400, 'Bad invite')
      const tokenHash = verifierFor(hexToBytes(b.token))
      const r = db.redeemInvite(b.workspaceId, tokenHash, user, b.publicKey, b.binding)
      if (!r.ok) throw new HttpErr(403, r.error)
      return { workspaceId: b.workspaceId, role: r.role, epoch: r.epoch, wrapped: r.wrapped }
    }

    const mm = /^\/v1\/workspaces\/([0-9a-f]{32})(\/.*)?$/.exec(p)
    if (!mm) throw new HttpErr(404, 'Not found')
    const wsId = mm[1]
    const sub = mm[2] ?? ''
    const mem = db.membership(wsId, user)
    // Non-members get the same answer whether or not the workspace exists.
    if (!mem) throw new HttpErr(404, 'No such workspace, or you’re not a member of it.')
    const owner = mem.role === 'owner'
    const requireOwner = () => {
      if (!owner) throw new HttpErr(403, 'Only the workspace owner can do that.')
    }

    if (sub === '') {
      if (m === 'GET') return db.workspaceDetail(wsId, user)
      if (m === 'DELETE') {
        requireOwner()
        db.deleteWorkspace(wsId)
        return {}
      }
    }

    if (sub === '/invites' && m === 'POST') {
      requireOwner()
      const b = (await readJson(req)) as CreateInviteRequest
      if (!/^[0-9a-f]{16,32}$/.test(String(b.id)) || !isHex(b.tokenHash, 64) || !isB64(b.wrapped, 1 << 20) || !isB64(b.secretEnc, 512))
        throw new HttpErr(400, 'Bad invite')
      if (b.role !== 'editor' && b.role !== 'viewer') throw new HttpErr(400, 'Invites are for editors or viewers.')
      const exp = Date.parse(String(b.expiresAt))
      if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 31 * 86400_000) throw new HttpErr(400, 'Invites can last up to 31 days.')
      if (!db.createInvite(wsId, { ...b, expiresAt: new Date(exp).toISOString() })) throw new HttpErr(409, 'Invite already exists')
      return {}
    }
    const inv = /^\/invites\/([0-9a-f]{16,32})$/.exec(sub)
    if (inv && m === 'DELETE') {
      requireOwner()
      db.deleteInvite(wsId, inv[1])
      return {}
    }

    if (sub === '/members/me/bundle' && m === 'PUT') {
      const b = (await readJson(req)) as { bundle: string; epoch: number }
      if (!isB64(b.bundle, 1 << 20) || b.epoch !== mem.epoch) throw new HttpErr(400, 'Bad key bundle')
      db.setBundle(wsId, user, b.bundle, b.epoch)
      return {}
    }

    const mem2 = /^\/members\/([^/]+)$/.exec(sub)
    if (mem2) {
      const target = decodeURIComponent(mem2[1]).toLowerCase()
      if (m === 'PATCH') {
        requireOwner()
        const b = (await readJson(req)) as { role: WorkspaceRole }
        if (!isRole(b.role) || b.role === 'owner') throw new HttpErr(400, 'Role must be editor or viewer.')
        if (!db.setRole(wsId, target, b.role)) throw new HttpErr(404, 'No such member.')
        return {}
      }
      if (m === 'DELETE') {
        if (target !== user) requireOwner()
        if (target === user && owner) throw new HttpErr(400, 'The owner can’t leave. Delete the workspace instead.')
        if (!db.removeMember(wsId, target)) throw new HttpErr(404, 'No such member.')
        return {}
      }
    }

    if (sub === '/rotate' && m === 'POST') {
      requireOwner()
      const b = (await readJson(req)) as RotateRequest
      if (!Number.isInteger(b.epoch) || !isB64(b.meta, 8192) || typeof b.bundles !== 'object' || !b.bundles) throw new HttpErr(400, 'Bad rotation')
      for (const v of Object.values(b.bundles)) if (!isB64(v, 1 << 20)) throw new HttpErr(400, 'Bad rotation')
      const err = db.rotate(wsId, b.epoch, b.meta, b.bundles)
      if (err) throw new HttpErr(409, err)
      return {}
    }

    if (sub === '/changes') {
      if (m === 'GET') {
        const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200))
        return db.wsPull(wsId, since, limit)
      }
      if (m === 'POST') {
        if (mem.role === 'viewer') throw new HttpErr(403, 'You have view-only access to this workspace.')
        const b = (await readJson(req)) as PushRequest
        if (!Array.isArray(b.changes) || b.changes.length > 500) throw new HttpErr(400, 'Bad changes')
        for (const c of b.changes) {
          if (!isHex(c?.key, 40) || typeof c.blob !== 'string' || !Number.isInteger(c.baseSeq) || c.baseSeq < 0) throw new HttpErr(400, 'Bad change')
          if (blobEpoch(c.blob) !== mem.epoch) throw new HttpErr(409, 'This workspace’s keys changed. Sync again to get the new ones.')
        }
        const r = db.wsPush(wsId, user, owner, b.changes)
        if ('error' in r) throw new HttpErr(403, r.error!)
        return { results: r.results }
      }
    }

    throw new HttpErr(404, 'Not found')
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
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
