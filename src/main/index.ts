import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, net, Notification, protocol, screen, session, shell, systemPreferences, Tray, type MenuItemConstructorOptions } from 'electron'
import { Store } from '../shared/store'
import { meetingToMarkdown, transcriptToSrt, transcriptToText } from '../shared/format'
import type { CalendarEvent, ChatMessage, Meeting, Settings, Template, TranscriptSegment } from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import { chat, classifyMeeting, enhanceNotes, followUpEmail, preMeetingBrief } from './claude'
import { removeEcho } from '../shared/echo'
import { driveFolderTree, googleCancel, googleConnect, googleDisconnect, googleStatus, shareDoc, syncMeetingToDrive, upcomingEvents } from './google'
import { SyncManager } from './sync/manager'
import { initUpdater, installUpdate } from './updater'
import { watchMic } from './micWatch'
import { CallTracker, type CallApp } from '../shared/calls'

// macOS 13+: let getDisplayMedia return system audio through ScreenCaptureKit, with no virtual audio driver.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride')
}

// One copy at a time: launching it again (Dock, Start menu, login item) just brings the window forward.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => showMain())

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
let tray: Tray | null = null
let quitting = false
const isMac = process.platform === 'darwin'
const rendererUrl = (hash = '') =>
  (process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : 'app://mentat/index.html') + hash

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#f7f6f3',
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  void win.loadURL(rendererUrl())
  // Started at login: stay in the menu bar / tray until called for. The page still loads, so a detected
  // call can start recording right away.
  const startHidden = process.argv.includes('--hidden') || (isMac && app.getLoginItemSettings().wasOpenedAtLogin)
  win.once('ready-to-show', () => !startHidden && win?.show())
  // Closing the window keeps Mentat running in the background (and keeps any recording going).
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
    if (isMac && !recording) app.dock?.hide()
  })
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

function showMain(): void {
  if (!win || win.isDestroyed()) createWindow()
  if (isMac) void app.dock?.show()
  win?.show()
  win?.focus()
}

function openMeeting(id: string, autoRecord = false): void {
  showMain()
  send('meeting:open', id, { autoRecord })
}

function iconPath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons', name) : join(app.getAppPath(), 'resources', 'icons', name)
}

// ---------- menu bar / tray ----------

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(iconPath(isMac ? 'trayTemplate.png' : 'tray.png')))
  tray.setToolTip('Mentat')
  if (!isMac) tray.on('click', showMain)
  updateTray()
}

function updateTray(): void {
  if (!tray) return
  const items: MenuItemConstructorOptions[] = recording
    ? [
        { label: 'Recording… show notes', click: () => recording && openMeeting(recording.meetingId) },
        { label: 'Stop recording', click: () => recording && send('recording:autoStop', recording.meetingId) }
      ]
    : [{ label: 'Start notes now', click: () => openMeeting(store.createMeeting({ title: 'Quick notes' }).id, true) }]
  items.push(
    { type: 'separator' },
    { label: 'Open Mentat', click: showMain },
    {
      label: 'Detect calls automatically',
      type: 'checkbox',
      checked: settings.autoDetectCalls,
      click: (i) => applySettings({ ...settings, autoDetectCalls: i.checked })
    },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: settings.openAtLogin,
      enabled: app.isPackaged,
      click: (i) => applySettings({ ...settings, openAtLogin: i.checked })
    },
    { type: 'separator' },
    { label: 'Quit Mentat', click: () => app.quit() }
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
  if (isMac) tray.setImage(nativeImage.createFromPath(iconPath(recording ? 'trayRecTemplate.png' : 'trayTemplate.png')))
  tray.setToolTip(recording ? 'Mentat: recording' : 'Mentat')
}

function applySettings(s: Settings): Settings {
  settings = saveSettings(s)
  applyLoginItem()
  updateTray()
  return settings
}

function applyLoginItem(): void {
  if (!app.isPackaged || process.env.MENTAT_SMOKE_TEST) return
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: isMac ? undefined : ['--hidden'] })
}

// ---------- call detection ----------
// Watches which apps hold the microphone. When a call app (Zoom, Teams, Meet in a browser…) keeps it for a
// few seconds, a small prompt offers to take notes; when that app lets go, the recording stops.

const calls = new CallTracker()
let micIds: string[] = []
let prompt: BrowserWindow | null = null
let pendingCall: { app: CallApp; event?: CalendarEvent } | null = null
let callAppsAtRecordStart: string[] = []

function startCallDetection(): void {
  if (process.env.MENTAT_SMOKE_TEST) return
  // To try the prompt without a real call: MENTAT_FAKE_MIC=us.zoom.xos npm run dev
  const fake = process.env.MENTAT_FAKE_MIC?.split(',').filter(Boolean)
  if (fake) micIds = fake
  const stop = fake
    ? () => undefined
    : watchMic((ids) => {
        micIds = ids
        tickCalls()
      })
  if (!stop) return
  setInterval(tickCalls, 1000)
  app.on('will-quit', stop)
}

function tickCalls(): void {
  for (const ev of calls.update(micIds)) {
    if (ev.type === 'started') onCallStarted(ev.app)
    else onCallEnded(ev.app)
  }
}

function eventNow(): CalendarEvent | undefined {
  const now = Date.now()
  return cachedEvents.find((e) => new Date(e.start).getTime() - 10 * 60_000 <= now && now <= new Date(e.end).getTime())
}

function onCallStarted(callApp: CallApp): void {
  if (!settings.autoDetectCalls || recording) return
  pendingCall = { app: callApp, event: eventNow() }
  showCallPrompt()
}

function onCallEnded(callApp: CallApp): void {
  if (pendingCall?.app.name === callApp.name) closeCallPrompt()
  if (!recording || !settings.autoStopRecording || !callAppsAtRecordStart.includes(callApp.name)) return
  if (calls.active().some((a) => callAppsAtRecordStart.includes(a.name))) return
  send('recording:autoStop', recording.meetingId)
  new Notification({ title: 'Call ended', body: 'Mentat stopped recording. Your transcript is saved.' }).show()
}

function showCallPrompt(): void {
  closeCallPrompt(false)
  const { workArea } = screen.getPrimaryDisplay()
  const width = 400
  const height = 92
  prompt = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true }
  })
  prompt.setAlwaysOnTop(true, 'floating')
  prompt.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  void prompt.loadURL(rendererUrl('#call-prompt'))
  prompt.once('ready-to-show', () => prompt?.showInactive())
  const p = prompt
  setTimeout(() => p === prompt && closeCallPrompt(), 60_000)
}

function closeCallPrompt(clearPending = true): void {
  if (prompt && !prompt.isDestroyed()) prompt.destroy()
  prompt = null
  if (clearPending) pendingCall = null
}

function acceptCall(): void {
  const call = pendingCall
  closeCallPrompt()
  if (!call || recording) return
  const m = call.event ? meetingForEvent(call.event) : store.createMeeting({ title: call.app.browser ? 'Call' : `${call.app.name} call` })
  openMeeting(m.id, true)
}

// ---------- recording ----------
// Audio capture and transcription both run on-device in the renderer (see renderer/src/stt.worker.ts);
// the main process only persists finished transcript segments.

let recording: { meetingId: string } | null = null

function startRecording(meetingId: string): { offset: number } {
  const m = store.getMeeting(meetingId)
  if (!m) throw new Error('Meeting not found')
  recording = { meetingId }
  callAppsAtRecordStart = calls.active().map((a) => a.name)
  closeCallPrompt()
  updateTray()
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
  if (store.getMeeting(recording.meetingId)) store.updateMeeting(recording.meetingId, { endedAt: new Date().toISOString() })
  recording = null
  callAppsAtRecordStart = []
  updateTray()
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
  h('settings:save', (_e, s: Settings) => applySettings(s))
  h('call:info', () => (pendingCall ? { app: pendingCall.app.name, title: pendingCall.event?.title ?? null } : null))
  h('call:accept', () => acceptCall())
  h('call:dismiss', () => closeCallPrompt())
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
  h('meetings:delete', (_e, id: string) => {
    // Deleting the note that is recording ends the recording first, so no late segment writes it back.
    if (recording?.meetingId === id) {
      recording = null
      callAppsAtRecordStart = []
      updateTray()
    }
    store.deleteMeeting(id)
  })
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

  h('google:status', () => googleStatus(settings))
  h('google:connect', async () => {
    const s = await googleConnect(settings)
    showMain() // the browser had focus; bring Mentat back
    void pollCalendar()
    return s
  })
  h('google:cancel', () => googleCancel())
  h('google:disconnect', () => {
    googleDisconnect()
    cachedEvents = []
    send('calendar:events', [])
    return googleStatus(settings)
  })
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
  createTray()
  applyLoginItem()
  startCallDetection()
  updater = initUpdater((s) => send('app:updateStatus', s))
  void pollCalendar()
  setInterval(() => void pollCalendar(), 60_000)
  app.on('activate', () => showMain())
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  stopRecording()
  if (process.platform !== 'darwin') void sync?.stop()
  if (process.platform !== 'darwin') app.quit()
})
