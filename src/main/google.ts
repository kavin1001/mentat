// Google sign-in (desktop OAuth loopback + PKCE), Calendar and Drive.
// Mentat ships its own Google OAuth client (injected at build time, never committed: see docs/google-drive.md),
// so connecting is one click. Scopes: calendar.readonly, and full Drive so Mentat can read your files for
// Claude and file notes into folders you already have.
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { Attendee, CalendarEvent, GoogleStatus, Meeting, Settings } from '../shared/types'
import { markdownToHtml, meetingToMarkdown, transcriptToText } from '../shared/format'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const SCOPES = ['openid', 'email', CALENDAR_SCOPE, DRIVE_SCOPE]
// Earlier builds asked only for files Mentat itself created.
const LEGACY_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** The client built into this copy of Mentat (MAIN_VITE_* at build time, or MENTAT_* when running). */
function builtInClient(): { id: string; secret: string } | null {
  const id = process.env.MENTAT_GOOGLE_CLIENT_ID || import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID || ''
  const secret = process.env.MENTAT_GOOGLE_CLIENT_SECRET || import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET || ''
  return id ? { id, secret } : null
}

/** Your own client from Settings → Advanced wins; otherwise the built-in one. */
function oauthClient(settings: Settings): { id: string; secret: string } | null {
  if (settings.googleClientId) return { id: settings.googleClientId, secret: settings.googleClientSecret }
  return builtInClient()
}

interface Tokens {
  access_token: string
  refresh_token?: string
  expires_at: number
  email?: string
  /** Space-separated scopes Google actually granted (people can untick boxes on the consent screen). */
  scope?: string
  /** The OAuth client these tokens belong to; refreshing must use the same one. */
  client_id?: string
}

const tokenPath = () => join(app.getPath('userData'), 'google-tokens.bin')

function saveTokens(t: Tokens): void {
  const json = JSON.stringify(t)
  writeFileSync(tokenPath(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json))
}

function loadTokens(): Tokens | null {
  if (!existsSync(tokenPath())) return null
  const buf = readFileSync(tokenPath())
  try {
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString()) as Tokens
  } catch {
    return null
  }
}

export function googleStatus(settings?: Settings): GoogleStatus {
  const t = loadTokens()
  const scopes = (t?.scope ?? LEGACY_DRIVE_SCOPE + ' ' + CALENDAR_SCOPE).split(' ')
  const drive = scopes.includes(DRIVE_SCOPE) ? 'full' : scopes.includes(LEGACY_DRIVE_SCOPE) ? 'limited' : 'none'
  return {
    connected: !!t?.refresh_token,
    email: t?.email,
    drive: t?.refresh_token ? drive : undefined,
    calendar: t?.refresh_token ? scopes.includes(CALENDAR_SCOPE) : undefined,
    canConnect: settings ? !!oauthClient(settings) : !!builtInClient(),
    builtInClient: !!builtInClient()
  }
}

/** Full Drive access (read + write), as opposed to a legacy file-only grant. */
export function hasFullDrive(): boolean {
  return googleStatus().drive === 'full'
}

export function googleDisconnect(): void {
  const t = loadTokens()
  // Revoke on Google's side too, so Mentat disappears from the account's third-party access list.
  if (t?.refresh_token) void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: 'POST' }).catch(() => undefined)
  if (existsSync(tokenPath())) unlinkSync(tokenPath())
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

let pending: { server: Server; reject: (e: Error) => void } | null = null

/** Stop waiting for a sign-in the user abandoned in the browser. */
export function googleCancel(): void {
  pending?.server.close()
  pending?.reject(new Error('Google sign-in cancelled'))
  pending = null
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Mentat</title></head><body style="font-family:-apple-system,system-ui,sans-serif;background:#f7f6f3;color:#23231f;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="background:#fff;border-radius:14px;padding:32px 40px;box-shadow:0 10px 30px rgba(0,0,0,.08);max-width:440px"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#6b675e;line-height:1.5">${body}</p></div></body></html>`

export async function googleConnect(settings: Settings): Promise<GoogleStatus> {
  const client = oauthClient(settings)
  if (!client)
    throw new Error('This copy of Mentat was built without a Google sign-in client. Add one under Settings → Google → Advanced, or see docs/google-drive.md.')
  googleCancel()
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = ''
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') return res.end()
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        ok
          ? page('Mentat is connected', 'You can close this tab and go back to Mentat.')
          : page('Google sign-in did not finish', 'Go back to Mentat and click Connect Google Drive to try again.')
      )
      server.close()
      clearTimeout(timer)
      pending = null
      if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri })
      else reject(new Error(url.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : (url.searchParams.get('error') ?? 'Google sign-in failed')))
    })
    pending = { server, reject }
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      redirectUri = `http://127.0.0.1:${port}/callback`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.search = new URLSearchParams({
        client_id: client.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
        state
      }).toString()
      void shell.openExternal(auth.toString())
    })
    const timer = setTimeout(() => {
      server.close()
      pending = null
      reject(new Error('Google sign-in timed out. Click Connect Google Drive to try again.'))
    }, 5 * 60_000)
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.id,
      ...(client.secret ? { client_secret: client.secret } : {}),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    })
  })
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string; error_description?: string }
  if (!res.ok) throw new Error(body.error_description ?? 'Token exchange failed')
  let email: string | undefined
  if (body.id_token) {
    try {
      email = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64').toString()).email
    } catch {
      /* ignore */
    }
  }
  saveTokens({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + body.expires_in * 1000,
    email,
    scope: body.scope,
    client_id: client.id
  })
  folderCache.clear()
  return googleStatus(settings)
}

async function accessToken(settings: Settings): Promise<string> {
  const t = loadTokens()
  if (!t?.refresh_token) throw new Error('Connect Google Drive in Settings first.')
  if (t.expires_at - 60_000 > Date.now()) return t.access_token
  // Tokens from before the built-in client have no client_id: they came from the client in Settings.
  const builtIn = builtInClient()
  const client =
    t.client_id && builtIn?.id === t.client_id
      ? builtIn
      : { id: t.client_id ?? settings.googleClientId, secret: t.client_id && t.client_id !== settings.googleClientId ? '' : settings.googleClientSecret }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.id,
      ...(client.secret ? { client_secret: client.secret } : {}),
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token'
    })
  })
  const body = (await res.json()) as { access_token: string; expires_in: number; error?: string; error_description?: string }
  if (!res.ok)
    throw new Error(
      body.error === 'invalid_grant'
        ? 'Google sign-in expired. Open Settings and click Connect Google Drive again.'
        : (body.error_description ?? 'Google token refresh failed; reconnect Google in Settings.')
    )
  saveTokens({ ...t, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 })
  return body.access_token
}

async function gfetch<T>(settings: Settings, url: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(settings)
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

// ---------- Calendar ----------

interface GEvent {
  id: string
  summary?: string
  description?: string
  location?: string
  hangoutLink?: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  attendees?: { email: string; displayName?: string; self?: boolean; resource?: boolean }[]
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[] }
}

const MEETING_URL = /https:\/\/[\w.-]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|around\.co)\/[^\s"<>]*/i

export async function upcomingEvents(settings: Settings, days = 7): Promise<CalendarEvent[]> {
  const now = new Date()
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
  url.search = new URLSearchParams({
    timeMin: new Date(now.getTime() - 2 * 3600_000).toISOString(),
    timeMax: new Date(now.getTime() + days * 86400_000).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50'
  }).toString()
  const data = await gfetch<{ items: GEvent[] }>(settings, url.toString())
  return data.items
    .filter((e) => e.start.dateTime) // skip all-day events
    .map((e) => {
      const attendees: Attendee[] = (e.attendees ?? []).filter((a) => !a.resource && !a.self).map((a) => ({ email: a.email, name: a.displayName }))
      const meetingUrl =
        e.hangoutLink ??
        e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ??
        `${e.location ?? ''} ${e.description ?? ''}`.match(MEETING_URL)?.[0]
      return { id: e.id, title: e.summary ?? '(No title)', start: e.start.dateTime!, end: e.end.dateTime!, attendees, meetingUrl, description: e.description }
    })
}

// ---------- Drive ----------
// Mentat files every note under one root folder (the one picked in Settings, or "Mentat" at the top of My
// Drive) and, when auto-classify is on, into a sub-folder Claude picks from the folders already there,
// e.g. <root>/Customers/Acme. Folders you make there yourself in Drive count too.

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const folderCache = new Map<string, string>() // "root/a/b" -> folder id

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const ALL_DRIVES = 'supportsAllDrives=true&includeItemsFromAllDrives=true'

async function findOrCreateFolder(settings: Settings, name: string, parent?: string): Promise<string> {
  // With full Drive access, look only at the top of My Drive for the root, not every folder with that name.
  const query = `mimeType='${FOLDER_MIME}' and name='${q(name)}' and trashed=false and '${parent ?? 'root'}' in parents`
  const found = await gfetch<{ files: { id: string }[] }>(settings, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&corpora=allDrives&${ALL_DRIVES}`)
  if (found.files[0]) return found.files[0].id
  return createDriveFolder(settings, name, parent)
}

/** Create a folder (in My Drive's top level when no parent is given) and return its id. */
export async function createDriveFolder(settings: Settings, name: string, parent?: string): Promise<string> {
  const created = await gfetch<{ id: string }>(settings, 'https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) })
  })
  return created.id
}

/**
 * Folders for the picker. `parent` is a folder id, or one of the starting places: "root" (My Drive),
 * "shared" (Shared with me) and "drives" (shared drives, listed as if they were folders).
 */
export async function listDriveFolders(settings: Settings, parent = 'root'): Promise<{ id: string; name: string }[]> {
  if (parent === 'drives') {
    const out: { id: string; name: string }[] = []
    let pageToken = ''
    do {
      const page = await gfetch<{ drives?: { id: string; name: string }[]; nextPageToken?: string }>(
        settings,
        `https://www.googleapis.com/drive/v3/drives?pageSize=100&fields=nextPageToken,drives(id,name)${pageToken ? `&pageToken=${pageToken}` : ''}`
      )
      out.push(...(page.drives ?? []))
      pageToken = page.nextPageToken ?? ''
    } while (pageToken && out.length < 500)
    return out.sort((x, y) => x.name.localeCompare(y.name))
  }
  const query =
    parent === 'shared'
      ? `mimeType='${FOLDER_MIME}' and trashed=false and sharedWithMe`
      : `mimeType='${FOLDER_MIME}' and trashed=false and '${q(parent)}' in parents`
  const out: { id: string; name: string }[] = []
  let pageToken = ''
  do {
    const page = await gfetch<{ files: { id: string; name: string }[]; nextPageToken?: string }>(
      settings,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name)&orderBy=name&pageSize=200&corpora=allDrives&${ALL_DRIVES}${pageToken ? `&pageToken=${pageToken}` : ''}`
    )
    out.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken && out.length < 1000)
  return out
}

/** Move Drive files to the trash (restorable there for 30 days). Files already gone are ignored. */
export async function trashDriveFiles(settings: Settings, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await gfetch(settings, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      })
    } catch (err) {
      if (!/Google API 404/.test(String(err))) throw err
    }
  }
}

/** The upload root: the folder picked in Settings, or a "Mentat" folder at the top of My Drive. */
async function rootFolderId(settings: Settings): Promise<{ key: string; id: string }> {
  if (settings.driveFolderId) return { key: `id:${settings.driveFolderId}`, id: settings.driveFolderId }
  const name = settings.driveFolderName || 'Mentat'
  const key = `name:${name}`
  const id = folderCache.get(key) ?? (await findOrCreateFolder(settings, name))
  folderCache.set(key, id)
  return { key, id }
}

/** Ensure <root>/<path...> exists and return the id of the deepest folder. */
async function ensureFolderPath(settings: Settings, path: string[] = []): Promise<string> {
  let { key, id } = await rootFolderId(settings)
  for (const raw of path) {
    const name = raw.trim().slice(0, 100)
    if (!name) continue
    key += '/' + name
    const cached = folderCache.get(key)
    id = cached ?? (await findOrCreateFolder(settings, name, id))
    folderCache.set(key, id)
  }
  return id
}

/** Every sub-folder path under the Mentat root, e.g. [["Customers"], ["Customers", "Acme"], ["Hiring"]]. */
export async function driveFolderTree(settings: Settings): Promise<string[][]> {
  const rootId = await ensureFolderPath(settings)
  const out: string[][] = []
  // Walk down from the root one level at a time (full Drive access can see thousands of unrelated folders).
  let level: { id: string; path: string[] }[] = [{ id: rootId, path: [] }]
  for (let depth = 0; depth < 5 && level.length && out.length < 500; depth++) {
    const next: typeof level = []
    for (let i = 0; i < level.length; i += 20) {
      const batch = level.slice(i, i + 20)
      const query = `mimeType='${FOLDER_MIME}' and trashed=false and (${batch.map((f) => `'${f.id}' in parents`).join(' or ')})`
      let pageToken = ''
      do {
        const page = await gfetch<{ files: { id: string; name: string; parents?: string[] }[]; nextPageToken?: string }>(
          settings,
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,parents)&pageSize=1000&corpora=allDrives&${ALL_DRIVES}${pageToken ? `&pageToken=${pageToken}` : ''}`
        )
        for (const f of page.files) {
          const parent = batch.find((p) => f.parents?.includes(p.id))
          if (!parent) continue
          const path = [...parent.path, f.name]
          out.push(path)
          next.push({ id: f.id, path })
        }
        pageToken = page.nextPageToken ?? ''
      } while (pageToken)
    }
    level = next
  }
  return out.sort((x, y) => x.join('/').localeCompare(y.join('/')))
}

// ---------- reading Drive (for Claude) ----------

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

/** Full-text search over the user's Drive (names and contents). */
export async function searchDrive(settings: Settings, text: string, limit = 10): Promise<DriveFile[]> {
  const query = `fullText contains '${q(text)}' and trashed=false and mimeType != '${FOLDER_MIME}'`
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=${Math.min(limit, 25)}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives`
  return (await gfetch<{ files: DriveFile[] }>(settings, url)).files
}

const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv'
}

/** A Drive file's text: Google Docs/Slides as plain text, Sheets as CSV (first sheet), text files as-is. */
export async function readDriveFile(settings: Settings, id: string, maxChars = 60_000): Promise<{ file: DriveFile; text: string }> {
  const file = await gfetch<DriveFile>(settings, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`)
  const token = await accessToken(settings)
  const exportAs = EXPORTS[file.mimeType]
  const readable = exportAs || /^text\/|json|xml|markdown|csv/.test(file.mimeType)
  if (!readable) return { file, text: `(Mentat can't read ${file.mimeType} files yet; only Google Docs, Sheets, Slides and text files.)` }
  const url = exportAs
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return { file, text: text.length > maxChars ? text.slice(0, maxChars) + '\n…(truncated)' : text }
}

/** Create or update a Google Doc from HTML in the given folder, moving it there if it lives elsewhere. */
async function upsertDoc(settings: Settings, name: string, html: string, parent: string, existingId?: string): Promise<{ id: string; webViewLink: string }> {
  if (existingId) {
    try {
      const meta = await gfetch<{ parents?: string[]; trashed?: boolean }>(settings, `https://www.googleapis.com/drive/v3/files/${existingId}?fields=parents,trashed&supportsAllDrives=true`)
      if (meta.trashed) throw new Error('in the trash') // someone binned it in Drive: make a fresh one
      const move = meta.parents?.includes(parent) ? '' : `&addParents=${parent}&removeParents=${(meta.parents ?? []).join(',')}`
      return await gfetch(settings, `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,webViewLink&supportsAllDrives=true${move}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/html' },
        body: html
      })
    } catch {
      // The doc was deleted or trashed in Drive; fall through and create a new one.
    }
  }
  const boundary = `mentat${randomBytes(8).toString('hex')}`
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, mimeType: 'application/vnd.google-apps.document', parents: [parent] }) +
    `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`
  return gfetch(settings, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  })
}

/** Push a meeting's notes and full transcript to Drive as Google Docs, inside Mentat/<folderPath>. */
export async function syncMeetingToDrive(settings: Settings, m: Meeting, folderPath = m.drive?.folderPath ?? []): Promise<NonNullable<Meeting['drive']>> {
  const parent = await ensureFolderPath(settings, folderPath)
  const date = new Date(m.startedAt ?? m.createdAt).toISOString().slice(0, 10)
  const notes = await upsertDoc(settings, `${date} ${m.title}`, markdownToHtml(meetingToMarkdown(m)), parent, m.drive?.docId)
  let transcriptDocId = m.drive?.transcriptDocId
  if (m.transcript.length) {
    const tHtml = markdownToHtml(`# ${m.title} (transcript)\n\n${transcriptToText(m.transcript, m.speakerNames).split('\n').join('\n\n')}`)
    transcriptDocId = (await upsertDoc(settings, `${date} ${m.title} (transcript)`, tHtml, parent, transcriptDocId)).id
  }
  return { docId: notes.id, transcriptDocId, webViewLink: notes.webViewLink, syncedAt: new Date().toISOString(), shared: m.drive?.shared, folderPath }
}

/** Share the notes doc: anyone with the link can view, and optionally email attendees. */
export async function shareDoc(settings: Settings, docId: string, emails: string[] = []): Promise<void> {
  await gfetch(settings, `https://www.googleapis.com/drive/v3/files/${docId}/permissions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  })
  for (const email of emails) {
    await gfetch(settings, `https://www.googleapis.com/drive/v3/files/${docId}/permissions?sendNotificationEmail=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'user', emailAddress: email })
    })
  }
}
