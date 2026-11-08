// Google sign-in (desktop OAuth loopback + PKCE), Calendar and Drive.
// Scopes are deliberately narrow: calendar.readonly and drive.file (only files Mentat creates).
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { Attendee, CalendarEvent, GoogleStatus, Meeting, Settings } from '../shared/types'
import { markdownToHtml, meetingToMarkdown, transcriptToText } from '../shared/format'

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.file'
]

interface Tokens {
  access_token: string
  refresh_token?: string
  expires_at: number
  email?: string
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

export function googleStatus(): GoogleStatus {
  const t = loadTokens()
  return { connected: !!t?.refresh_token, email: t?.email }
}

export function googleDisconnect(): void {
  if (existsSync(tokenPath())) unlinkSync(tokenPath())
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function googleConnect(settings: Settings): Promise<GoogleStatus> {
  if (!settings.googleClientId) throw new Error('Add a Google OAuth client ID (Desktop app type) in Settings first.')
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') return res.end()
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="font-family:system-ui;padding:40px">${ok ? 'Mentat is connected to Google. You can close this tab.' : 'Sign-in failed. Please try again.'}</body></html>`)
      server.close()
      if (ok) resolve({ code: url.searchParams.get('code')!, redirectUri })
      else reject(new Error(url.searchParams.get('error') ?? 'Google sign-in failed'))
    })
    let redirectUri = ''
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      redirectUri = `http://127.0.0.1:${port}/callback`
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      auth.search = new URLSearchParams({
        client_id: settings.googleClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        state
      }).toString()
      void shell.openExternal(auth.toString())
    })
    setTimeout(() => {
      server.close()
      reject(new Error('Google sign-in timed out'))
    }, 5 * 60_000)
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: settings.googleClientId,
      client_secret: settings.googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier
    })
  })
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string; error_description?: string }
  if (!res.ok) throw new Error(body.error_description ?? 'Token exchange failed')
  let email: string | undefined
  if (body.id_token) {
    try {
      email = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64').toString()).email
    } catch {
      /* ignore */
    }
  }
  saveTokens({ access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + body.expires_in * 1000, email })
  return googleStatus()
}

async function accessToken(settings: Settings): Promise<string> {
  const t = loadTokens()
  if (!t?.refresh_token) throw new Error('Connect Google in Settings first.')
  if (t.expires_at - 60_000 > Date.now()) return t.access_token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.googleClientId,
      client_secret: settings.googleClientSecret,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token'
    })
  })
  const body = (await res.json()) as { access_token: string; expires_in: number; error_description?: string }
  if (!res.ok) throw new Error(body.error_description ?? 'Google token refresh failed; reconnect Google in Settings.')
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
// Mentat files every note under one root folder ("Mentat" by default) and, when auto-classify is on,
// into a sub-folder Claude picks, e.g. Mentat/Customers/Acme. With the drive.file scope Mentat only
// sees folders it created, so the folder tree below is the one Mentat built.

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const folderCache = new Map<string, string>() // "root/a/b" -> folder id

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

async function findOrCreateFolder(settings: Settings, name: string, parent?: string): Promise<string> {
  const query = `mimeType='${FOLDER_MIME}' and name='${q(name)}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '')
  const found = await gfetch<{ files: { id: string }[] }>(settings, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`)
  if (found.files[0]) return found.files[0].id
  const created = await gfetch<{ id: string }>(settings, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) })
  })
  return created.id
}

/** Ensure Mentat/<path...> exists and return the id of the deepest folder. */
async function ensureFolderPath(settings: Settings, path: string[] = []): Promise<string> {
  const root = settings.driveFolderName || 'Mentat'
  let key = root
  let id = folderCache.get(key) ?? (await findOrCreateFolder(settings, root))
  folderCache.set(key, id)
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
  const all: { id: string; name: string; parents?: string[] }[] = []
  let pageToken = ''
  do {
    const query = `mimeType='${FOLDER_MIME}' and trashed=false`
    const page = await gfetch<{ files: typeof all; nextPageToken?: string }>(
      settings,
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,parents)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`
    )
    all.push(...page.files)
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  const children = new Map<string, typeof all>()
  for (const f of all) for (const p of f.parents ?? []) children.set(p, [...(children.get(p) ?? []), f])
  const out: string[][] = []
  const walk = (id: string, path: string[], depth: number) => {
    if (depth > 4) return
    for (const c of children.get(id) ?? []) {
      out.push([...path, c.name])
      walk(c.id, [...path, c.name], depth + 1)
    }
  }
  walk(rootId, [], 0)
  return out
}

/** Create or update a Google Doc from HTML in the given folder, moving it there if it lives elsewhere. */
async function upsertDoc(settings: Settings, name: string, html: string, parent: string, existingId?: string): Promise<{ id: string; webViewLink: string }> {
  if (existingId) {
    try {
      const meta = await gfetch<{ parents?: string[] }>(settings, `https://www.googleapis.com/drive/v3/files/${existingId}?fields=parents`)
      const move = meta.parents?.includes(parent) ? '' : `&addParents=${parent}&removeParents=${(meta.parents ?? []).join(',')}`
      return await gfetch(settings, `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&fields=id,webViewLink${move}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/html' },
        body: html
      })
    } catch {
      // The doc was deleted in Drive; fall through and create a new one.
    }
  }
  const boundary = `mentat${randomBytes(8).toString('hex')}`
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, mimeType: 'application/vnd.google-apps.document', parents: [parent] }) +
    `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`
  return gfetch(settings, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
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
