// Mentat MCP server (stdio). Gives Claude Desktop, Claude Code or any MCP client read access
// to every meeting: notes, AI notes and full transcripts, straight from the local data folder.
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

const store = new Store()
const server = new McpServer({ name: 'mentat', version: '0.1.0' })
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })

server.registerTool(
  'list_meetings',
  {
    description: 'List meetings, newest first, with id, title, date, attendees and a short preview. Optionally filter by folder name, keyword, or date range.',
    inputSchema: {
      query: z.string().optional().describe('Keyword filter over titles, notes and transcripts'),
      folder: z.string().optional().describe('Folder name'),
      from: z.string().optional().describe('ISO date, inclusive'),
      to: z.string().optional().describe('ISO date, inclusive'),
      limit: z.number().int().min(1).max(200).optional()
    }
  },
  async ({ query, folder, from, to, limit }) => {
    const folderId = folder ? store.listFolders().find((f) => f.name.toLowerCase() === folder.toLowerCase())?.id : undefined
    if (folder && !folderId) return text(`No folder named "${folder}". Folders: ${store.listFolders().map((f) => f.name).join(', ') || 'none'}`)
    let ms = store.listMeetings({ query, folderId })
    if (from) ms = ms.filter((m) => (m.startedAt ?? m.createdAt) >= from)
    if (to) ms = ms.filter((m) => (m.startedAt ?? m.createdAt).slice(0, 10) <= to)
    return text(JSON.stringify(ms.slice(0, limit ?? 25), null, 2))
  }
)

server.registerTool(
  'search_meetings',
  {
    description: 'Keyword search across every meeting, including full transcripts. Returns matching meetings with snippets.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() }
  },
  async ({ query, limit }) => text(JSON.stringify(store.search(query, limit ?? 10), null, 2))
)

server.registerTool(
  'get_meeting',
  {
    description: 'Get one meeting as Markdown: title, date, attendees, the user\'s notes, AI-enhanced notes and (optionally) the full transcript.',
    inputSchema: { id: z.string(), include_transcript: z.boolean().optional() }
  },
  async ({ id, include_transcript }) => {
    const m = store.getMeeting(id)
    return text(m ? meetingToMarkdown(m, { includeTranscript: include_transcript ?? true }) : `Meeting ${id} not found.`)
  }
)

server.registerTool(
  'get_transcript',
  {
    description: 'Get the complete, verbatim transcript of a meeting with timestamps and speakers ("Me" is the user).',
    inputSchema: { id: z.string() }
  },
  async ({ id }) => {
    const m = store.getMeeting(id)
    if (!m) return text(`Meeting ${id} not found.`)
    return text(m.transcript.length ? transcriptToText(m.transcript) : 'This meeting has no transcript.')
  }
)

server.registerTool(
  'list_folders',
  { description: 'List meeting folders.', inputSchema: {} },
  async () => text(JSON.stringify(store.listFolders(), null, 2))
)

server.registerTool(
  'update_notes',
  {
    description: 'Replace or append to the user\'s own notes on a meeting.',
    inputSchema: { id: z.string(), notes: z.string(), mode: z.enum(['append', 'replace']).optional() }
  },
  async ({ id, notes, mode }) => {
    const m = store.getMeeting(id)
    if (!m) return text(`Meeting ${id} not found.`)
    store.updateMeeting(id, { notes: mode === 'replace' ? notes : `${m.notes}\n\n${notes}`.trim() })
    return text('Notes updated.')
  }
)

void server.connect(new StdioServerTransport())
