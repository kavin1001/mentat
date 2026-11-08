import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, net, Notification, protocol, session, shell, systemPreferences } from 'electron'
import { Store } from '../shared/store'
import { meetingToMarkdown, transcriptToSrt, transcriptToText } from '../shared/format'
import type { CalendarEvent, ChatMessage, Meeting, Settings, Template, TranscriptSegment } from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import { chat, classifyMeeting, enhanceNotes, followUpEmail, preMeetingBrief } from './claude'
import { removeEcho } from '../shared/echo'
import { driveFolderTree, googleConnect, googleDisconnect, googleStatus, shareDoc, syncMeetingToDrive, upcomingEvents } from './google'
import { SyncManager } from './sync/manager'
import { initUpdater, installUpdate } from './updater'

// macOS 13+: let getDisplayMedia return system audio through ScreenCaptureKit, with no virtual audio driver.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride')
}

// The UI is served from app://mentat/ (not file://) so the on-device speech model can fetch its WASM
// runtime, and with cross-origin isolation so ONNX Runtime can use multiple threads.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

function serveRenderer(): void {
  const root = join(__dirname, '../renderer')
  protocol.handle('app', async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname)
    const file = join(root, path === '/' ? 'index.html' : path)
    if (!file.startsWith(root)) return new Response('Not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless')
    if (file.endsWith('.mjs') || file.endsWith('.js')) headers.set('Content-Type', 'text/javascript')
    if (file.endsWith('.wasm')) headers.set('Content-Type', 'application/wasm')
    return new Response(res.body, { status: res.status, headers })
  })
}

const store = new Store()
let settings: Settings
let sync: SyncManager | null = null
let win: BrowserWindow | null = null
let updater: ReturnType<typeof initUpdater> | null = null

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
  else void win.loadURL('app://mentat/index.html')
  if (process.env.MENTAT_SMOKE_TEST) smokeTest(win)
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

// CI launches the packaged app with MENTAT_SMOKE_TEST=1: it must load the UI without renderer errors, then quit.
function smokeTest(w: BrowserWindow): void {
  const errors: string[] = []
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error') errors.push(e.message)
  })
  w.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`))
  w.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`load failed: ${code} ${desc}`))
  const finish = async () => {
    const mounted = await w.webContents.executeJavaScript("!!document.querySelector('#root')?.children.length").catch(() => false)
    if (!mounted) errors.push('UI did not mount')
    const result = errors.length ? `SMOKE FAIL\n${errors.join('\n')}` : 'SMOKE OK'
    console.log(result)
    if (process.env.MENTAT_SMOKE_RESULT) writeFileSync(process.env.MENTAT_SMOKE_RESULT, result)
    app.exit(errors.length ? 1 : 0)
  }
  w.webContents.once('did-finish-load', () => setTimeout(() => void finish(), 5000))
  setTimeout(() => {
    errors.push('timed out')
    void finish()
  }, 60_000)
}

const send = (channel: string, ...args: unknown[]) => win?.webContents.send(channel, ...args)

// ---------- recording ----------
// Audio capture and transcription both run on-device in the renderer (see renderer/src/stt.worker.ts);
// the main process only persists finished transcript segments.

let recording: { meetingId: string } | null = null

function startRecording(meetingId: string): { offset: number } {
  const m = store.getMeeting(meetingId)
  if (!m) throw new Error('Meeting not found')
  recording = { meetingId }
  if (!m.startedAt) store.updateMeeting(meetingId, { startedAt: new Date().toISOString() })
  return { offset: m.transcript.reduce((max, s) => Math.max(max, s.end), 0) }
}

function addSegment(meetingId: string, seg: Omit<TranscriptSegment, 'id'>): void {
  const m = store.getMeeting(meetingId)
  if (!m) return
  const full: TranscriptSegment = { ...seg, id: randomUUID() }
  const before = m.transcript.length + 1
  m.transcript = removeEcho([...m.transcript, full]).sort((a, b) => a.start - b.start)
  store.saveMeeting(m)
  if (m.transcript.length === before && m.transcript.includes(full)) send('transcript:final', meetingId, full)
  else send('transcript:reset', meetingId, m.transcript)
}

function stopRecording(): void {
  if (!recording) return
  store.updateMeeting(recording.meetingId, { endedAt: new Date().toISOString() })
  recording = null
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

/** Classify (once per meeting, unless asked again) and push notes + transcript to Drive. */
async function pushToDrive(m: Meeting, reclassify = false): Promise<Meeting> {
  let folderPath = m.drive?.folderPath
  if (settings.driveAutoClassify && (reclassify || !folderPath)) {
    try {
      folderPath = (await classifyMeeting(settings, m, await driveFolderTree(settings))).folderPath
    } catch (err) {
      send('app:error', `Could not classify the note, saving it to the top folder: ${(err as Error).message}`)
    }
  }
  const drive = await syncMeetingToDrive(settings, m, folderPath ?? [])
  // Mirror the Drive category as a local folder so the sidebar matches Drive.
  let folderIds = m.folderIds
  if (folderPath?.length) {
    const name = folderPath.join(' / ')
    const folder = store.listFolders().find((f) => f.name === name) ?? store.createFolder(name)
    folderIds = [folder.id]
  }
  return store.updateMeeting(m.id, { drive, folderIds })
}

async function maybeSyncDrive(m: Meeting): Promise<Meeting> {
  if (!settings.driveAutoSync || !googleStatus().connected) return m
  try {
    return await pushToDrive(m)
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
  h('app:version', () => app.getVersion())
  h('app:updateStatus', () => updater?.status() ?? { state: 'disabled' })
  h('app:checkForUpdates', () => updater?.check() ?? { state: 'disabled' })
  h('app:installUpdate', () => installUpdate())
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
  h('recording:segment', (_e, meetingId: string, seg: Omit<TranscriptSegment, 'id'>) => addSegment(meetingId, seg))

  h('ai:enhance', async (_e, meetingId: string, templateId?: string) => {
    const m = store.getMeeting(meetingId)
    if (!m) throw new Error('Meeting not found')
    const tpl = store.listTemplates().find((t) => t.id === (templateId ?? settings.defaultTemplateId)) ?? store.listTemplates()[0]
    const { enhanced, title } = await enhanceNotes(settings, m, tpl)
    const keepTitle = m.title && m.title !== 'Untitled meeting'
    const saved = store.updateMeeting(meetingId, { enhanced, title: keepTitle ? m.title : title })
    return maybeSyncDrive(saved)
  })
  h('ai:chat', async (e, reqId: string, history: ChatMessage[], scope: { meetingId?: string }) => {
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
  h('drive:sync', async (_e, meetingId: string, reclassify?: boolean) => pushToDrive(store.getMeeting(meetingId)!, reclassify))
  h('drive:share', async (_e, meetingId: string, emails: string[]) => {
    let m = store.getMeeting(meetingId)!
    if (!m.drive) m = await pushToDrive(m)
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
          ? transcriptToText(m.transcript, m.speakerNames)
          : format === 'srt'
            ? transcriptToSrt(m.transcript, m.speakerNames)
            : JSON.stringify(m, null, 2)
    writeFileSync(filePath, content)
    return filePath
  })
}

app.whenReady().then(() => {
  settings = loadSettings()
  serveRenderer()
  registerIpc()

  // Optional sync (phone on this network and/or cloud profile). Off by default.
  sync = new SyncManager(store, {
    dataChanged: () => send('sync:dataChanged'),
    statusChanged: (s) => send('sync:status', s),
    workspacesChanged: (s) => send('ws:status', s)
  })
  sync.registerIpc(ipcMain)
  void sync.start()

  // System audio capture: answer getDisplayMedia with the primary screen plus loopback audio.
  // The renderer discards the video track and keeps only the audio.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_req, callback) => {
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => callback({ video: sources[0], audio: 'loopback' }))
    },
    { useSystemPicker: false }
  )

  createWindow()
  updater = initUpdater((s) => send('app:updateStatus', s))
  void pollCalendar()
  setInterval(() => void pollCalendar(), 60_000)
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

app.on('window-all-closed', () => {
  stopRecording()
  if (process.platform !== 'darwin') void sync?.stop()
  if (process.platform !== 'darwin') app.quit()
})
