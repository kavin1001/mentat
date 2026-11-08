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
  /** Names for the people on the "them" side, keyed by speaker index (set by the user). */
  speakerNames?: Record<string, string>
  enhanced?: EnhancedNotes
  drive?: { docId: string; transcriptDocId?: string; webViewLink: string; syncedAt: string; shared?: boolean; folderPath?: string[] }
  /** Shared workspaces this meeting is shared to, on top of any its folder is shared to. */
  workspaceIds?: string[]
  /** Only on copies received from a shared workspace: the profile that shared it. */
  sharedBy?: string
}

export type MeetingSummary = Pick<
  Meeting,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'startedAt' | 'attendees' | 'folderIds' | 'sharedBy' | 'workspaceIds'
> & { hasTranscript: boolean; hasEnhanced: boolean; preview: string }

export interface Folder {
  id: string
  name: string
  createdAt: string
  /** Every meeting in this folder is shared to these workspaces. */
  workspaceIds?: string[]
}

/** A shared workspace as cached on this computer (~/Mentat/workspaces/<id>/workspace.json). */
export interface LocalWorkspace {
  id: string
  name: string
  role: 'owner' | 'editor' | 'viewer'
  owner: string
  serverUrl: string
  /** The profile on this computer that is the member. */
  me: string
  members: { username: string; role: 'owner' | 'editor' | 'viewer' }[]
  syncedAt?: string
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
  /** On-device speech-to-text model (see shared/stt-models.ts). */
  sttModel: string
  /** Tell apart the different people on the "them" side (on-device speaker embeddings). */
  diarize: boolean
  language: string
  /** Names, jargon and acronyms Claude should spell exactly. */
  dictionary: string[]
  googleClientId: string
  googleClientSecret: string
  driveAutoSync: boolean
  driveFolderName: string
  /** Let Claude file each note into a sub-folder of the Drive folder. */
  driveAutoClassify: boolean
  /** Optional filing rules for Claude, e.g. "Customer calls go under Customers/<company>". */
  driveRules: string
  defaultTemplateId: string
  autoDetectMeetings: boolean
  /** Notice when a call app (Zoom, Meet, Teams…) starts using the mic and offer to take notes. */
  autoDetectCalls: boolean
  /** Stop recording when the detected call ends. */
  autoStopRecording: boolean
  /** Start Mentat in the background when you log in (installed builds only). */
  openAtLogin: boolean
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
  /** What Drive access Google granted: full read + write, the old Mentat-files-only grant, or none (box unticked). */
  drive?: 'full' | 'limited' | 'none'
  /** Whether Google granted calendar access. */
  calendar?: boolean
  /** A Google sign-in client is available (built in, or your own in Settings → Advanced). */
  canConnect?: boolean
  /** This build ships Mentat's own Google sign-in client. */
  builtInClient?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: '',
  model: 'claude-opus-5-5',
  sttModel: 'onnx-community/whisper-small',
  diarize: true,
  language: 'en',
  dictionary: [],
  googleClientId: '',
  googleClientSecret: '',
  driveAutoSync: true,
  driveFolderName: 'Mentat',
  driveAutoClassify: true,
  driveRules: '',
  defaultTemplateId: 'general',
  autoDetectMeetings: true,
  autoDetectCalls: true,
  autoStopRecording: true,
  openAtLogin: true
}
