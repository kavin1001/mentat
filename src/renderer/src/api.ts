import type {
  CalendarEvent, ChatMessage, Folder, GoogleStatus, Meeting, MeetingSummary, Settings, Template, TranscriptSegment
} from '../../shared/types'

export type UpdateStatus = { state: string; version?: string; percent?: number; message?: string }

const inv = <T,>(ch: string, ...args: unknown[]) => window.mentat.invoke(ch, ...args) as Promise<T>

export const api = {
  settings: { get: () => inv<Settings>('settings:get'), save: (s: Settings) => inv<Settings>('settings:save', s) },
  app: {
    info: () => inv<{ dataDir: string; platform: string; mcpServerPath: string; nodePath: string }>('app:info'),
    openDataDir: () => inv<void>('app:openDataDir'),
    permissions: () => inv<{ microphone: string; screen: string }>('app:permissions'),
    version: () => inv<string>('app:version'),
    updateStatus: () => inv<UpdateStatus>('app:updateStatus'),
    checkForUpdates: () => inv<UpdateStatus>('app:checkForUpdates'),
    installUpdate: () => inv<void>('app:installUpdate'),
    onUpdateStatus: (cb: (s: UpdateStatus) => void) => window.mentat.on('app:updateStatus', cb)
  },
  meetings: {
    list: (opts: { folderId?: string; query?: string } = {}) => inv<MeetingSummary[]>('meetings:list', opts),
    get: (id: string) => inv<Meeting | null>('meetings:get', id),
    create: (partial?: Partial<Meeting>) => inv<Meeting>('meetings:create', partial),
    update: (id: string, patch: Partial<Meeting>) => inv<Meeting>('meetings:update', id, patch),
    remove: (id: string) => inv<void>('meetings:delete', id),
    fromEvent: (ev: CalendarEvent) => inv<Meeting>('meetings:fromEvent', ev)
  },
  folders: {
    list: () => inv<Folder[]>('folders:list'),
    create: (name: string) => inv<Folder>('folders:create', name),
    rename: (id: string, name: string) => inv<void>('folders:rename', id, name),
    remove: (id: string) => inv<void>('folders:delete', id)
  },
  templates: {
    list: () => inv<Template[]>('templates:list'),
    save: (t: Template) => inv<Template>('templates:save', t),
    remove: (id: string) => inv<void>('templates:delete', id)
  },
  recording: {
    start: (meetingId: string) => inv<{ offset: number }>('recording:start', meetingId),
    segment: (meetingId: string, seg: Omit<TranscriptSegment, 'id'>) => inv<void>('recording:segment', meetingId, seg),
    stop: () => inv<void>('recording:stop'),
    status: () => inv<{ meetingId: string } | null>('recording:status')
  },
  ai: {
    enhance: (meetingId: string, templateId?: string) => inv<Meeting>('ai:enhance', meetingId, templateId),
    followUp: (meetingId: string) => inv<string>('ai:followUp', meetingId),
    brief: (ev: CalendarEvent) => inv<string>('ai:brief', ev),
    chat: async (history: ChatMessage[], scope: { meetingId?: string }, onDelta: (t: string) => void) => {
      const reqId = Math.random().toString(36).slice(2)
      const off = window.mentat.on('ai:chat:delta', (id: string, delta: string) => id === reqId && onDelta(delta))
      try {
        return await inv<string>('ai:chat', reqId, history, scope)
      } finally {
        off()
      }
    }
  },
  google: {
    status: () => inv<GoogleStatus>('google:status'),
    connect: () => inv<GoogleStatus>('google:connect'),
    cancel: () => inv<void>('google:cancel'),
    disconnect: () => inv<GoogleStatus>('google:disconnect'),
    events: () => inv<CalendarEvent[]>('calendar:events')
  },
  drive: {
    folders: (parent?: string) => inv<{ id: string; name: string }[]>('drive:folders', parent),
    createFolder: (name: string, parent?: string) => inv<string>('drive:createFolder', name, parent),
    sync: (meetingId: string, reclassify = false) => inv<Meeting>('drive:sync', meetingId, reclassify),
    share: (meetingId: string, emails: string[]) => inv<Meeting>('drive:share', meetingId, emails)
  },
  exportMeeting: (meetingId: string, format: 'md' | 'txt' | 'srt' | 'json') => inv<string | null>('export:meeting', meetingId, format),
  events: {
    onFinal: (cb: (meetingId: string, seg: TranscriptSegment) => void) => window.mentat.on('transcript:final', cb),
    onReset: (cb: (meetingId: string, transcript: TranscriptSegment[]) => void) => window.mentat.on('transcript:reset', cb),
    onError: (cb: (msg: string) => void) => window.mentat.on('app:error', cb),
    onOpenMeeting: (cb: (id: string, opts: { autoRecord?: boolean }) => void) => window.mentat.on('meeting:open', cb),
    onCalendar: (cb: (events: CalendarEvent[]) => void) => window.mentat.on('calendar:events', cb),
    onMeetingChanged: (cb: (meetingId: string) => void) => window.mentat.on('meeting:changed', cb),
    onAutoStop: (cb: (meetingId: string) => void) => window.mentat.on('recording:autoStop', cb)
  }
}
