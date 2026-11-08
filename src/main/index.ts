import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, session, shell, systemPreferences } from 'electron'
import { Store } from '../shared/store'
import { meetingToMarkdown, transcriptToSrt, transcriptToText } from '../shared/format'
import type { CalendarEvent, ChatMessage, Meeting, Settings, Template, TranscriptSegment } from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import { chat, enhanceNotes, followUpEmail, preMeetingBrief } from './claude'
import { DeepgramTranscriber } from './transcription'
import { googleConnect, googleDisconnect, googleStatus, shareDoc, syncMeetingToDrive, upcomingEvents } from './google'

// macOS 13+: let getDisplayMedia return system audio through ScreenCaptureKit, with no virtual audio driver.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride')
}

const store = new Store()
let settings: Settings
let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f7f6f3',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args)

// ---------- recording ----------

let recording: { meetingId: string; transcriber: DeepgramTranscriber; pending: TranscriptSegment[]; flush: NodeJS.Timeout } | null = null

function flushSegments(): void {
  if (!recording || !recording.pending.length) return
  const m = store.getMeeting(recording.meetingId)
  if (!m) return
  m.transcript.push(...recording.pending)
  recording.pending = []
  store.saveMeeting(m)
}

function startRecording(meetingId: string): void {
  if (recording) stopRecording()
  const m = store.getMeeting(meetingId)
  if (!m) throw new Error('Meeting not found')
  const offset = m.transcript.reduce((max, s) => Math.max(max, s.end), 0)
  const transcriber = new DeepgramTranscriber(
    settings,
    {
      onFinal: (seg) => {
        recording?.pending.push(seg)
        send('transcript:final', meetingId, seg)
      },
      onPartial: (speaker, text) => send('transcript:partial', meetingId, speaker, text),
      onError: (msg) => send('app:error', msg),
      onClose: () => send('recording:closed', meetingId)
    },
    offset
  )
  transcriber.start()
  if (!m.startedAt) store.updateMeeting(meetingId, { startedAt: new Date().toISOString() })
  recording = { meetingId, transcriber, pending: [], flush: setInterval(flushSegments, 5000) }
}

function stopRecording(): void {
  if (!recording) return
  const r = recording
  r.transcriber.stop()
  clearInterval(r.flush)
  // Give the STT provider a moment to return its last final results.
  setTimeout(() => {
    flushSegments()
    store.updateMeeting(r.meetingId, { endedAt: new Date().toISOString() })
    if (recording === r) recording = null
  }, 3500)
}

// ---------- calendar auto-detect ----------

const notified = new Set<string>()
let cachedEvents: CalendarEvent[] = []

async function pollCalendar(): Promise<void> {
  if (!googleStatus().connected) return
  try {
    cachedEvents = await upcomingEvents(settings)
    send('calendar:events', cachedEvents)
    if (!settings.autoDetectMeetings) return
    const now = Date.now()
    for (const ev of cachedEvents) {
      const start = new Date(ev.start).getTime()
      if (start - now < 60_000 && start - now > -5 * 60_000 && !notified.has(ev.id)) {
        notified.add(ev.id)
        const n = new Notification({ title: `${ev.title} is starting`, body: 'Click to start taking notes with Mentat.' })
        n.on('click', () => {
          const m = meetingForEvent(ev)
          win?.show()
          send('meeting:open', m.id, { autoRecord: true })
        })
        n.show()
      }
    }
  } catch (err) {
    console.warn('calendar poll failed', err)
  }
}

function meetingForEvent(ev: CalendarEvent): Meeting {
  const existing = store.allMeetings().find((m) => m.calendarEventId === ev.id)
  return existing ?? store.createMeeting({ title: ev.title, calendarEventId: ev.id, attendees: ev.attendees })
}

async function maybeSyncDrive(m: Meeting): Promise<Meeting> {
  if (!settings.driveAutoSync || !googleStatus().connected) return m
  try {
    return store.updateMeeting(m.id, { drive: await syncMeetingToDrive(settings, m) })
  } catch (err) {
    send('app:error', `Drive sync failed: ${(err as Error).message}`)
    return m
  }
}

// ---------- IPC ----------

function registerIpc(): void {
  const h = ipcMain.handle.bind(ipcMain)

  h('settings:get', () => settings)
  h('settings:save', (_e, s: Settings) => (settings = saveSettings(s)))
  h('app:info', () => ({
    dataDir: store.dataDir,
    platform: process.platform,
    mcpServerPath: join(__dirname, 'mcp-server.js'),
    nodePath: process.execPath
  }))
  h('app:openDataDir', () => shell.openPath(store.dataDir))
  h('app:permissions', async () => {
    if (process.platform !== 'darwin') return { microphone: 'granted', screen: 'granted' }
    const microphone = systemPreferences.getMediaAccessStatus('microphone')
    if (microphone !== 'granted') await systemPreferences.askForMediaAccess('microphone')
    return { microphone: systemPreferences.getMediaAccessStatus('microphone'), screen: systemPreferences.getMediaAccessStatus('screen') }
  })

  h('meetings:list', (_e, opts) => store.listMeetings(opts))
  h('meetings:get', (_e, id: string) => store.getMeeting(id))
  h('meetings:create', (_e, partial?: Partial<Meeting>) => store.createMeeting(partial))
  h('meetings:update', (_e, id: string, patch: Partial<Meeting>) => store.updateMeeting(id, patch))
  h('meetings:delete', (_e, id: string) => store.deleteMeeting(id))
  h('meetings:fromEvent', (_e, ev: CalendarEvent) => meetingForEvent(ev))

  h('folders:list', () => store.listFolders())
  h('folders:create', (_e, name: string) => store.createFolder(name))
  h('folders:rename', (_e, id: string, name: string) => store.renameFolder(id, name))
  h('folders:delete', (_e, id: string) => store.deleteFolder(id))

  h('templates:list', () => store.listTemplates())
  h('templates:save', (_e, t: Template) => store.saveTemplate(t))
  h('templates:delete', (_e, id: string) => store.deleteTemplate(id))

  h('recording:start', (_e, meetingId: string) => startRecording(meetingId))
  h('recording:stop', () => stopRecording())
  h('recording:status', () => (recording ? { meetingId: recording.meetingId } : null))
  ipcMain.on('audio:chunk', (_e, chunk: ArrayBuffer) => recording?.transcriber.send(Buffer.from(chunk)))

  h('ai:enhance', async (_e, meetingId: string, templateId?: string) => {
    flushSegments()
    const m = store.getMeeting(meetingId)
    if (!m) throw new Error('Meeting not found')
    const tpl = store.listTemplates().find((t) => t.id === (templateId ?? settings.defaultTemplateId)) ?? store.listTemplates()[0]
    const { enhanced, title } = await enhanceNotes(settings, m, tpl)
    const keepTitle = m.title && m.title !== 'Untitled meeting'
    const saved = store.updateMeeting(meetingId, { enhanced, title: keepTitle ? m.title : title })
    return maybeSyncDrive(saved)
  })
  h('ai:chat', async (e, reqId: string, history: ChatMessage[], scope: { meetingId?: string }) => {
    flushSegments()
    return chat(settings, store, history, scope, (delta) => e.sender.send('ai:chat:delta', reqId, delta))
  })
  h('ai:followUp', async (_e, meetingId: string) => followUpEmail(settings, store.getMeeting(meetingId)!))
  h('ai:brief', async (_e, ev: CalendarEvent) => preMeetingBrief(settings, store, ev))

  h('google:status', () => googleStatus())
  h('google:connect', async () => {
    const s = await googleConnect(settings)
    void pollCalendar()
    return s
  })
  h('google:disconnect', () => googleDisconnect())
  h('calendar:events', async () => {
    if (!googleStatus().connected) return []
    cachedEvents = await upcomingEvents(settings)
    return cachedEvents
  })
  h('drive:sync', async (_e, meetingId: string) => {
    const m = store.getMeeting(meetingId)!
    return store.updateMeeting(meetingId, { drive: await syncMeetingToDrive(settings, m) })
  })
  h('drive:share', async (_e, meetingId: string, emails: string[]) => {
    let m = store.getMeeting(meetingId)!
    if (!m.drive) m = store.updateMeeting(meetingId, { drive: await syncMeetingToDrive(settings, m) })
    await shareDoc(settings, m.drive!.docId, emails)
    return store.updateMeeting(meetingId, { drive: { ...m.drive!, shared: true } })
  })

  h('export:meeting', async (_e, meetingId: string, format: 'md' | 'txt' | 'srt' | 'json') => {
    const m = store.getMeeting(meetingId)!
    const safe = m.title.replace(/[^\w\- ]+/g, '').trim() || 'meeting'
    const { filePath } = await dialog.showSaveDialog(win!, { defaultPath: `${safe}.${format}` })
    if (!filePath) return null
    const content =
      format === 'md'
        ? meetingToMarkdown(m, { includeTranscript: true })
        : format === 'txt'
          ? transcriptToText(m.transcript)
          : format === 'srt'
            ? transcriptToSrt(m.transcript)
            : JSON.stringify(m, null, 2)
    writeFileSync(filePath, content)
    return filePath
  })
}

app.whenReady().then(() => {
  settings = loadSettings()
  registerIpc()

  // System audio capture: answer getDisplayMedia with the primary screen plus loopback audio.
  // The renderer discards the video track and keeps only the audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, callback) => {
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => callback({ video: sources[0], audio: 'loopback' }))
    },
    { useSystemPicker: false }
  )

  createWindow()
  void pollCalendar()
  setInterval(() => void pollCalendar(), 60_000)
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  stopRecording()
  if (process.platform !== 'darwin') app.quit()
})
