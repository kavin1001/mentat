// File-based store. Every meeting is a plain JSON file plus a Markdown mirror,
// so transcripts are always readable outside the app and by the MCP server.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Folder, Meeting, MeetingSummary, Template } from './types'
import { BUILT_IN_TEMPLATES } from './templates'
import { meetingToMarkdown, transcriptToText } from './format'

export function defaultDataDir(): string {
  return process.env.MENTAT_DATA_DIR || join(homedir(), 'Mentat')
}

function writeAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

export class Store {
  readonly meetingsDir: string
  readonly transcriptsDir: string

  constructor(readonly dataDir: string = defaultDataDir()) {
    this.meetingsDir = join(dataDir, 'meetings')
    this.transcriptsDir = join(dataDir, 'transcripts')
    for (const d of [dataDir, this.meetingsDir, this.transcriptsDir]) if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }

  // ---------- meetings ----------
  private meetingPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad meeting id: ${id}`)
    return join(this.meetingsDir, `${id}.json`)
  }

  createMeeting(partial: Partial<Meeting> = {}): Meeting {
    const now = new Date().toISOString()
    const m: Meeting = {
      id: randomUUID(),
      title: 'Untitled meeting',
      createdAt: now,
      updatedAt: now,
      attendees: [],
      folderIds: [],
      notes: '',
      transcript: [],
      ...partial
    }
    this.saveMeeting(m)
    return m
  }

  getMeeting(id: string): Meeting | null {
    const p = this.meetingPath(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as Meeting
  }

  /** `keepUpdatedAt` is for sync, which writes a record exactly as another device last saved it. */
  saveMeeting(m: Meeting, opts: { keepUpdatedAt?: boolean } = {}): Meeting {
    if (!opts.keepUpdatedAt || !m.updatedAt) m.updatedAt = new Date().toISOString()
    writeAtomic(this.meetingPath(m.id), JSON.stringify(m, null, 2))
    // Human-readable mirrors.
    writeAtomic(join(this.meetingsDir, `${m.id}.md`), meetingToMarkdown(m))
    if (m.transcript.length) writeAtomic(join(this.transcriptsDir, `${m.id}.txt`), `${m.title}\n\n${transcriptToText(m.transcript, m.speakerNames)}\n`)
    return m
  }

  updateMeeting(id: string, patch: Partial<Meeting>): Meeting {
    const m = this.getMeeting(id)
    if (!m) throw new Error(`meeting not found: ${id}`)
    return this.saveMeeting({ ...m, ...patch, id })
  }

  deleteMeeting(id: string): void {
    for (const p of [this.meetingPath(id), join(this.meetingsDir, `${id}.md`), join(this.transcriptsDir, `${id}.txt`)])
      if (existsSync(p)) unlinkSync(p)
  }

  allMeetings(): Meeting[] {
    return readdirSync(this.meetingsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.meetingsDir, f), 'utf8')) as Meeting
        } catch {
          return null
        }
      })
      .filter((m): m is Meeting => !!m)
      .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))
  }

  listMeetings(opts: { folderId?: string; query?: string; limit?: number } = {}): MeetingSummary[] {
    let ms = this.allMeetings()
    if (opts.folderId) ms = ms.filter((m) => m.folderIds.includes(opts.folderId!))
    if (opts.query) {
      const q = opts.query.toLowerCase()
      ms = ms.filter((m) => searchText(m).includes(q))
    }
    return ms.slice(0, opts.limit ?? 1000).map(summarize)
  }

  /** Keyword search returning matching snippets, used for chat across meetings and the MCP server. */
  search(query: string, limit = 10): { meeting: MeetingSummary; snippets: string[] }[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
    if (!terms.length) return []
    const scored = this.allMeetings().map((m) => {
      const lines = [m.title, m.notes, ...(m.enhanced ? [m.enhanced.summary, ...m.enhanced.sections.flatMap((s) => s.bullets.map((b) => b.text))] : []), ...m.transcript.map((t) => t.text)]
      let score = 0
      const snippets: string[] = []
      for (const line of lines) {
        const l = line.toLowerCase()
        const hits = terms.filter((t) => l.includes(t)).length
        if (hits) {
          score += hits
          if (snippets.length < 5) snippets.push(line.length > 280 ? line.slice(0, 280) + '…' : line)
        }
      }
      return { m, score, snippets }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ meeting: summarize(s.m), snippets: s.snippets }))
  }

  // ---------- folders ----------
  private get foldersPath() {
    return join(this.dataDir, 'folders.json')
  }
  listFolders(): Folder[] {
    return existsSync(this.foldersPath) ? (JSON.parse(readFileSync(this.foldersPath, 'utf8')) as Folder[]) : []
  }
  createFolder(name: string): Folder {
    const f: Folder = { id: randomUUID(), name, createdAt: new Date().toISOString() }
    writeAtomic(this.foldersPath, JSON.stringify([...this.listFolders(), f], null, 2))
    return f
  }
  updateFolder(id: string, patch: Partial<Omit<Folder, 'id'>>): void {
    writeAtomic(this.foldersPath, JSON.stringify(this.listFolders().map((f) => (f.id === id ? { ...f, ...patch, id } : f)), null, 2))
  }
  renameFolder(id: string, name: string): void {
    writeAtomic(this.foldersPath, JSON.stringify(this.listFolders().map((f) => (f.id === id ? { ...f, name } : f)), null, 2))
  }
  deleteFolder(id: string): void {
    writeAtomic(this.foldersPath, JSON.stringify(this.listFolders().filter((f) => f.id !== id), null, 2))
    for (const m of this.allMeetings()) if (m.folderIds.includes(id)) this.saveMeeting({ ...m, folderIds: m.folderIds.filter((x) => x !== id) })
  }

  // ---------- templates ----------
  private get templatesPath() {
    return join(this.dataDir, 'templates.json')
  }
  listTemplates(): Template[] {
    const custom = existsSync(this.templatesPath) ? (JSON.parse(readFileSync(this.templatesPath, 'utf8')) as Template[]) : []
    return [...BUILT_IN_TEMPLATES, ...custom]
  }
  saveTemplate(t: Template): Template {
    if (t.builtIn) throw new Error('Built-in templates cannot be edited; duplicate it first.')
    const custom = this.listTemplates().filter((x) => !x.builtIn && x.id !== t.id)
    const saved = { ...t, id: t.id || randomUUID() }
    writeAtomic(this.templatesPath, JSON.stringify([...custom, saved], null, 2))
    return saved
  }
  deleteTemplate(id: string): void {
    writeAtomic(this.templatesPath, JSON.stringify(this.listTemplates().filter((x) => !x.builtIn && x.id !== id), null, 2))
  }
}

function searchText(m: Meeting): string {
  return [m.title, m.notes, m.enhanced?.summary ?? '', ...m.transcript.map((t) => t.text), ...m.attendees.map((a) => `${a.name ?? ''} ${a.email}`)]
    .join(' ')
    .toLowerCase()
}

export function summarize(m: Meeting): MeetingSummary {
  const preview = (m.enhanced?.summary || m.notes || m.transcript.slice(0, 3).map((t) => t.text).join(' ')).slice(0, 160)
  return {
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    startedAt: m.startedAt,
    attendees: m.attendees,
    folderIds: m.folderIds,
    sharedBy: m.sharedBy,
    workspaceIds: m.workspaceIds,
    hasTranscript: m.transcript.length > 0,
    hasEnhanced: !!m.enhanced,
    inDrive: !!m.drive?.docId,
    preview
  }
}
