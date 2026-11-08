// Everything that talks to Claude: note enhancement, chat (one meeting or all of them),
// follow-up emails and pre-meeting briefs.
import Anthropic from '@anthropic-ai/sdk'
import type { CalendarEvent, ChatMessage, EnhancedNotes, Meeting, Settings, Template } from '../shared/types'
import { enhancedToMarkdown, transcriptToText } from '../shared/format'
import type { Store } from '../shared/store'

// Server-side refusal fallback: on a policy decline the API re-runs the request on a fallback model.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

function client(settings: Settings): Anthropic {
  if (!settings.anthropicApiKey) throw new Error('Add your Anthropic API key in Settings first.')
  return new Anthropic({ apiKey: settings.anthropicApiKey })
}

function textOf(msg: Anthropic.Beta.BetaMessage): string {
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.')
  return msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
}

function meetingContext(m: Meeting): string {
  const when = new Date(m.startedAt ?? m.createdAt).toLocaleString()
  const people = m.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ') || 'unknown'
  return [
    `<meeting id="${m.id}">`,
    `Title: ${m.title}`,
    `When: ${when}`,
    `Attendees: ${people}`,
    `<user_notes>\n${m.notes || '(none)'}\n</user_notes>`,
    m.enhanced ? `<enhanced_notes>\n${enhancedToMarkdown(m)}\n</enhanced_notes>` : '',
    `<transcript>\n${transcriptToText(m.transcript) || '(no transcript)'}\n</transcript>`,
    `</meeting>`
  ]
    .filter(Boolean)
    .join('\n')
}

const ENHANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'sections', 'actionItems'],
  properties: {
    title: { type: 'string', description: 'A short, specific meeting title (max 8 words).' },
    summary: { type: 'string', description: 'One or two sentence summary.' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'bullets'],
        properties: {
          heading: { type: 'string' },
          bullets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'origin'],
              properties: { text: { type: 'string' }, origin: { type: 'string', enum: ['user', 'ai'] } }
            }
          }
        }
      }
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { owner: { type: 'string' }, text: { type: 'string' }, due: { type: 'string' } }
      }
    }
  }
} as const

export async function enhanceNotes(
  settings: Settings,
  meeting: Meeting,
  template: Template
): Promise<{ enhanced: EnhancedNotes; title: string }> {
  const system = [
    'You turn a person\'s rough meeting notes plus the full meeting transcript into clean, well-organised notes.',
    'The user\'s own notes are the backbone: every point they wrote must appear, rewritten for clarity but keeping their meaning, and marked origin "user".',
    'Fill in important details, numbers, names and decisions from the transcript that the user did not write down, marked origin "ai".',
    'In the transcript, "Me" is the user (their microphone) and "Them" is everyone else (system audio).',
    'Do not invent anything that is not supported by the notes or transcript. Leave a section empty rather than padding it.',
    settings.dictionary.length ? `Spell these names and terms exactly: ${settings.dictionary.join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const prompt = [
    meetingContext(meeting),
    '',
    `Template: ${template.name}. Use these section headings in this order: ${template.sections.join(' | ')}.`,
    template.instructions ? `Template guidance: ${template.instructions}` : '',
    'Return the enhanced notes.'
  ].join('\n')

  const msg = await client(settings)
    .beta.messages.stream({
      model: settings.model,
      max_tokens: 32000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ENHANCE_SCHEMA } },
      system,
      messages: [{ role: 'user', content: prompt }]
    })
    .finalMessage()

  const parsed = JSON.parse(textOf(msg)) as {
    title: string
    summary: string
    sections: EnhancedNotes['sections']
    actionItems: EnhancedNotes['actionItems']
  }
  return {
    title: parsed.title,
    enhanced: {
      templateId: template.id,
      generatedAt: new Date().toISOString(),
      summary: parsed.summary,
      sections: parsed.sections,
      actionItems: parsed.actionItems
    }
  }
}

// ---------- chat ----------

const CHAT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_meetings',
    description: 'Keyword search over every meeting (titles, notes and full transcripts). Returns meeting ids, titles, dates and matching snippets.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords to search for.' } },
      required: ['query']
    }
  },
  {
    name: 'list_recent_meetings',
    description: 'List the most recent meetings with their ids, titles, dates and attendees.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'get_meeting',
    description: 'Get one meeting in full: user notes, enhanced notes and the complete transcript.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  }
]

function runChatTool(store: Store, name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'search_meetings':
      return JSON.stringify(store.search(String(input.query ?? ''), 8))
    case 'list_recent_meetings':
      return JSON.stringify(
        store.listMeetings({ limit: Number(input.limit) || 15 }).map((m) => ({ id: m.id, title: m.title, date: m.startedAt ?? m.createdAt, attendees: m.attendees }))
      )
    case 'get_meeting': {
      const m = store.getMeeting(String(input.id))
      return m ? meetingContext(m) : 'Meeting not found.'
    }
    default:
      return `Unknown tool ${name}`
  }
}

/**
 * Chat about one meeting (its full context is in the system prompt, cached) or about all meetings
 * (Claude searches and opens meetings with tools). Streams text through onText.
 */
export async function chat(
  settings: Settings,
  store: Store,
  history: ChatMessage[],
  scope: { meetingId?: string },
  onText: (delta: string) => void
): Promise<string> {
  const c = client(settings)
  const meeting = scope.meetingId ? store.getMeeting(scope.meetingId) : null
  const today = new Date().toDateString()
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    {
      type: 'text',
      text:
        'You are Mentat, an assistant that answers questions about the user\'s meetings. ' +
        '"Me" in transcripts is the user. Answer directly and concisely, quote the transcript when it helps, ' +
        'and say so when the meetings do not contain the answer. Use Markdown.'
    }
  ]
  if (meeting) system.push({ type: 'text', text: meetingContext(meeting), cache_control: { type: 'ephemeral' } })

  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((h) => ({ role: h.role, content: h.content }))
  // Today's date goes in the latest turn, after the cached prefix.
  const last = messages[messages.length - 1]
  if (last && typeof last.content === 'string') last.content = `(Today is ${today}.)\n${last.content}`

  let answer = ''
  for (let turn = 0; turn < 8; turn++) {
    const stream = c.beta.messages.stream({
      model: settings.model,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      tools: meeting ? undefined : CHAT_TOOLS,
      messages
    })
    stream.on('text', (t) => {
      answer += t
      onText(t)
    })
    const msg = await stream.finalMessage()
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request.')
    if (msg.stop_reason !== 'tool_use') return answer
    messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] })
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      try {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: runChatTool(store, block.name, block.input as Record<string, unknown>) })
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: String(err), is_error: true })
      }
    }
    messages.push({ role: 'user', content: results })
  }
  return answer
}

// ---------- follow-up email and pre-meeting brief ----------

export async function followUpEmail(settings: Settings, meeting: Meeting): Promise<string> {
  const msg = await client(settings).beta.messages.create({
    model: settings.model,
    max_tokens: 4000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: 'Write a short, friendly follow-up email from the user ("Me") to the other attendees. Recap decisions and next steps with owners. Plain text, with a Subject: line first. No placeholders the user would have to fill in unless a fact is truly missing.',
    messages: [{ role: 'user', content: meetingContext(meeting) }]
  })
  return textOf(msg)
}

export async function preMeetingBrief(settings: Settings, store: Store, event: CalendarEvent): Promise<string> {
  const emails = new Set(event.attendees.map((a) => a.email.toLowerCase()))
  const titleWords = event.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  const related = store
    .allMeetings()
    .filter((m) => m.attendees.some((a) => emails.has(a.email.toLowerCase())) || titleWords.some((w) => m.title.toLowerCase().includes(w)))
    .slice(0, 5)
  if (!related.length) return 'No earlier meetings with these people or on this topic yet.'
  const msg = await client(settings).beta.messages.create({
    model: settings.model,
    max_tokens: 4000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: 'Write a brief for an upcoming meeting from the user\'s past meetings: who they are, what was discussed last time, open commitments, and 2-3 suggested talking points. Markdown, under 200 words.',
    messages: [
      {
        role: 'user',
        content: `Upcoming: ${event.title} at ${new Date(event.start).toLocaleString()} with ${event.attendees.map((a) => a.name ?? a.email).join(', ')}\n\n${related.map(meetingContext).join('\n\n')}`
      }
    ]
  })
  return textOf(msg)
}

// ---------- Drive auto-classification ----------

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['folderPath', 'reason'],
  properties: {
    folderPath: {
      type: 'array',
      items: { type: 'string' },
      description: 'Folder path under the root, top level first, 1 to 3 levels, e.g. ["Customers", "Acme Corp"].'
    },
    reason: { type: 'string', description: 'One short sentence.' }
  }
} as const

/** Pick the Drive folder a meeting belongs in, reusing existing folders where they fit. */
export async function classifyMeeting(settings: Settings, meeting: Meeting, existing: string[][]): Promise<{ folderPath: string[]; reason: string }> {
  const msg = await client(settings).beta.messages.create({
    model: settings.model,
    max_tokens: 2000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    system: [
      'You file meeting notes into a folder hierarchy in Google Drive.',
      'Prefer an existing folder when it fits; create a new one only when nothing fits. Keep names short, in Title Case, and stable',
      '(e.g. "Customers/Acme Corp", "Hiring/Backend Engineer", "1:1s/Priya Shah", "Internal/Product", "Investors/Sequoia").',
      'Use at most 3 levels. Never put dates in folder names.',
      settings.driveRules ? `The user's filing rules, which take priority:\n${settings.driveRules}` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Existing folders:\n${existing.length ? existing.map((p) => p.join(' / ')).join('\n') : '(none yet)'}`,
          '',
          `Meeting title: ${meeting.title}`,
          `Attendees: ${meeting.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ') || 'unknown'}`,
          `Notes:\n${meeting.enhanced ? enhancedToMarkdown(meeting) : meeting.notes || '(none)'}`,
          meeting.enhanced ? '' : `Transcript excerpt:\n${transcriptToText(meeting.transcript).slice(0, 6000)}`
        ].join('\n')
      }
    ]
  })
  const parsed = JSON.parse(textOf(msg)) as { folderPath: string[]; reason: string }
  return { folderPath: parsed.folderPath.map((s) => s.replace(/[/\\]/g, '-').trim()).filter(Boolean).slice(0, 3), reason: parsed.reason }
}
