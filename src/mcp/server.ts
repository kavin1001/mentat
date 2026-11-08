// Mentat MCP server (stdio). Gives Claude Desktop, Claude Code or any MCP client read access
// to every meeting: notes, AI notes and full transcripts, straight from the local data folder.
// That includes meetings other people shared with you through shared workspaces: the app keeps a
// decrypted copy of exactly what your profile can access in ~/Mentat/workspaces/, and removes it when
// you leave a workspace, are removed, or sign out.
//
//   Claude Desktop config:
//   { "mcpServers": { "mentat": { "command": "<Mentat binary>", "args": ["<path>/mcp-server.js"],
//                                 "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
//   or with plain Node:  node out/main/mcp-server.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Store } from '../shared/store'
import { meetingToMarkdown, transcriptToText } from '../shared/format'
import { listLocalWorkspaces, workspaceStore } from '../shared/workspaces'
import type { Meeting } from '../shared/types'

const store = new Store()
const server = new McpServer({ name: 'mentat', version: '0.2.0' })
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

interface Source {
  /** null = the user's own notes */
  workspaceId: string | null
  label: string
  store: Store
  role?: string
}

const workspaceParam = z
  .string()
  .optional()
  .describe('Where to look: "all" (default: your own notes plus every shared workspace you belong to), "mine" (only your own), or a workspace name or id')

/** Every place the user can read from, re-read on each call so access changes apply immediately. */
function sources(scope?: string): Source[] | string {
  const own: Source = { workspaceId: null, label: 'My notes', store }
  const shared = listLocalWorkspaces(store.dataDir).map(
    (w): Source => ({ workspaceId: w.id, label: w.name, store: workspaceStore(store.dataDir, w.id), role: w.role })
  )
  const s = (scope ?? 'all').trim().toLowerCase()
  if (s === 'all' || s === '') return [own, ...shared]
  if (s === 'mine' || s === 'my notes') return [own]
  const match = shared.filter((w) => w.workspaceId === s || w.label.toLowerCase() === s)
  if (match.length) return match
  return `No shared workspace called "${scope}". You have: ${shared.map((w) => w.label).join(', ') || 'none (only your own notes)'}.`
}

const where = (src: Source, m: Pick<Meeting, 'sharedBy'>) =>
  src.workspaceId ? { workspace: src.label, workspace_id: src.workspaceId, shared_by: m.sharedBy } : { workspace: 'My notes' }

function findMeeting(id: string, scope?: string): { src: Source; m: Meeting } | string {
  const ss = sources(scope)
  if (typeof ss === 'string') return ss
  for (const src of ss) {
    const m = src.store.getMeeting(id)
    if (m) return { src, m }
  }
  return `Meeting ${id} not found${scope && scope !== 'all' ? ` in ${scope}` : ''}.`
}

server.registerTool(
  'list_meetings',
  {
    description:
      'List meetings, newest first, with id, title, date, attendees, a short preview and where each comes from (your own notes or a shared workspace, and who shared it). Optionally filter by workspace, folder name, keyword, or date range.',
    inputSchema: {
      query: z.string().optional().describe('Keyword filter over titles, notes and transcripts'),
      workspace: workspaceParam,
      folder: z.string().optional().describe('Folder name (your own notes only)'),
      from: z.string().optional().describe('ISO date, inclusive'),
      to: z.string().optional().describe('ISO date, inclusive'),
      limit: z.number().int().min(1).max(200).optional()
    }
  },
  async ({ query, workspace, folder, from, to, limit }) => {
    const folderId = folder ? store.listFolders().find((f) => f.name.toLowerCase() === folder.toLowerCase())?.id : undefined
    if (folder && !folderId) return text(`No folder named "${folder}". Folders: ${store.listFolders().map((f) => f.name).join(', ') || 'none'}`)
    const ss = sources(folder ? 'mine' : workspace)
    if (typeof ss === 'string') return text(ss)
    let ms = ss.flatMap((src) =>
      src.store.listMeetings({ query, folderId: src.workspaceId ? undefined : folderId }).map(({ sharedBy, workspaceIds: _w, ...m }) => ({ ...m, ...where(src, { sharedBy }) }))
    )
    if (from) ms = ms.filter((m) => (m.startedAt ?? m.createdAt) >= from)
    if (to) ms = ms.filter((m) => (m.startedAt ?? m.createdAt).slice(0, 10) <= to)
    ms.sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))
    return text(JSON.stringify(ms.slice(0, limit ?? 25), null, 2))
  }
)

server.registerTool(
  'search_meetings',
  {
    description:
      'Keyword search across every meeting you can access (your own and those shared with you in workspaces), including full transcripts. Returns matching meetings with snippets and where each comes from.',
    inputSchema: { query: z.string(), workspace: workspaceParam, limit: z.number().int().min(1).max(50).optional() }
  },
  async ({ query, workspace, limit }) => {
    const ss = sources(workspace)
    if (typeof ss === 'string') return text(ss)
    const hits = ss.flatMap((src) =>
      src.store.search(query, limit ?? 10).map((h, rank) => ({ ...h, rank, from: where(src, h.meeting) }))
    )
    // Interleave sources by rank so one big workspace doesn't crowd out the rest.
    hits.sort((a, b) => a.rank - b.rank || b.snippets.length - a.snippets.length)
    return text(JSON.stringify(hits.slice(0, limit ?? 10).map(({ rank: _r, ...h }) => h), null, 2))
  }
)

server.registerTool(
  'get_meeting',
  {
    description:
      'Get one meeting as Markdown: title, date, attendees, notes, AI-enhanced notes and (optionally) the full transcript. Works for your own meetings and for meetings shared with you.',
    inputSchema: { id: z.string(), workspace: workspaceParam, include_transcript: z.boolean().optional() }
  },
  async ({ id, workspace, include_transcript }) => {
    const r = findMeeting(id, workspace)
    if (typeof r === 'string') return text(r)
    const head = r.src.workspaceId ? `> Shared in workspace "${r.src.label}"${r.m.sharedBy ? ` by ${r.m.sharedBy}` : ''}. The notes are theirs.\n\n` : ''
    return text(head + meetingToMarkdown(r.m, { includeTranscript: include_transcript ?? true }))
  }
)

server.registerTool(
  'get_transcript',
  {
    description:
      'Get the complete, verbatim transcript of a meeting with timestamps and speakers. "Me" is whoever recorded it: you for your own meetings, the person who shared it for shared ones.',
    inputSchema: { id: z.string(), workspace: workspaceParam }
  },
  async ({ id, workspace }) => {
    const r = findMeeting(id, workspace)
    if (typeof r === 'string') return text(r)
    const { m, src } = r
    if (!m.transcript.length) return text('This meeting has no transcript.')
    const head = src.workspaceId ? `(Shared in "${src.label}" by ${m.sharedBy ?? 'another member'}; "Me" is ${m.sharedBy ?? 'them'}.)\n\n` : ''
    return text(head + transcriptToText(m.transcript))
  }
)

server.registerTool(
  'list_workspaces',
  {
    description:
      'List the shared workspaces you belong to: name, id, your role (owner, editor or viewer), the owner, members, and how many shared meetings are available. Meetings in them can be read with the other tools.',
    inputSchema: {}
  },
  async () => {
    const ws = listLocalWorkspaces(store.dataDir).map((w) => ({
      id: w.id,
      name: w.name,
      your_role: w.role,
      owner: w.owner,
      members: w.members,
      meetings: workspaceStore(store.dataDir, w.id).allMeetings().length,
      last_synced: w.syncedAt
    }))
    return text(ws.length ? JSON.stringify(ws, null, 2) : 'You are not in any shared workspaces. Only your own notes are available.')
  }
)

server.registerTool(
  'list_folders',
  { description: 'List your own meeting folders.', inputSchema: {} },
  async () => text(JSON.stringify(store.listFolders(), null, 2))
)

server.registerTool(
  'update_notes',
  {
    description: 'Replace or append to the user\'s own notes on one of their own meetings (meetings shared by others are read-only).',
    inputSchema: { id: z.string(), notes: z.string(), mode: z.enum(['append', 'replace']).optional() }
  },
  async ({ id, notes, mode }) => {
    const m = store.getMeeting(id)
    if (!m) return text(typeof findMeeting(id) === 'string' ? `Meeting ${id} not found.` : 'That meeting was shared with you by someone else and is read-only.')
    store.updateMeeting(id, { notes: mode === 'replace' ? notes : `${m.notes}\n\n${notes}`.trim() })
    return text('Notes updated.')
  }
)

void server.connect(new StdioServerTransport())
