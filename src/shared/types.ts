// Types shared by the main process, the renderer and the MCP server.

export type Speaker = 'me' | 'them'

export interface TranscriptSegment {
  id: string
  speaker: Speaker
  /** Diarized speaker index inside the "them" channel, when the STT provider gives one. */
  speakerIndex?: number
  text: string
  /** Seconds from the start of the recording. */
  start: number
  end: number
}

export interface Attendee {
  name?: string
  email: string
}

export interface EnhancedBullet {
  text: string
  /** "user" = carried over from what the user typed; "ai" = added from the transcript. */
  origin: 'user' | 'ai'
}

export interface EnhancedSection {
  heading: string
  bullets: EnhancedBullet[]
}

export interface EnhancedNotes {
  templateId: string
  generatedAt: string
  summary: string
  sections: EnhancedSection[]
  actionItems: { owner?: string; text: string; due?: string }[]
}

export interface Meeting {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
  calendarEventId?: string
  attendees: Attendee[]
  folderIds: string[]
  /** The user's own notes, as Markdown. */
  notes: string
  transcript: TranscriptSegment[]
  enhanced?: EnhancedNotes
  drive?: { docId: string; transcriptDocId?: string; webViewLink: string; syncedAt: string; shared?: boolean }
}

export type MeetingSummary = Pick<
  Meeting,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'startedAt' | 'attendees' | 'folderIds'
> & { hasTranscript: boolean; hasEnhanced: boolean; preview: string }

export interface Folder {
  id: string
  name: string
  createdAt: string
}

export interface Template {
  id: string
  name: string
  description: string
  /** Section headings the enhanced notes should follow, in order. */
  sections: string[]
  /** Extra guidance for Claude. */
  instructions: string
  builtIn?: boolean
}

export interface Settings {
  anthropicApiKey: string
  model: string
  deepgramApiKey: string
  language: string
  /** Workspace-wide dictionary: names, jargon and acronyms to bias transcription and spelling. */
  dictionary: string[]
  googleClientId: string
  googleClientSecret: string
  driveAutoSync: boolean
  driveFolderName: string
  defaultTemplateId: string
  autoDetectMeetings: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: Attendee[]
  meetingUrl?: string
  description?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GoogleStatus {
  connected: boolean
  email?: string
}

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: '',
  model: 'claude-opus-5-5',
  deepgramApiKey: '',
  language: 'en',
  dictionary: [],
  googleClientId: '',
  googleClientSecret: '',
  driveAutoSync: true,
  driveFolderName: 'Mentat',
  defaultTemplateId: 'general',
  autoDetectMeetings: true
}
