// Call detection: which apps count as "a call" when they start using the microphone, and a small state
// machine that turns "these apps are using the mic right now" snapshots into call started / call ended events.
// Platform probes (CoreAudio helper on macOS, the privacy registry on Windows) live in src/main/micWatch.ts.

export interface CallApp {
  name: string
  browser?: boolean
}

// macOS bundle id prefixes and Windows exe / package names, lower-case.
const APPS: [string[], CallApp][] = [
  [['us.zoom.', 'zoom.exe', 'cpthost.exe'], { name: 'Zoom' }],
  [['com.microsoft.teams', 'ms-teams.exe', 'teams.exe', 'msteams_'], { name: 'Microsoft Teams' }],
  [['com.tinyspeck.slackmacgap', 'slack.exe', '91750d7e.slack_'], { name: 'Slack' }],
  [['com.apple.facetime', 'com.apple.avconferenced'], { name: 'FaceTime' }],
  [['com.cisco.webex', 'com.webex.', 'atmgr.exe', 'ciscocollabhost.exe', 'webex.exe'], { name: 'Webex' }],
  [['com.hnc.discord', 'discord.exe'], { name: 'Discord' }],
  [['net.whatsapp.', 'desktop.whatsapp', 'whatsapp.exe', '5319275a.whatsappdesktop_'], { name: 'WhatsApp' }],
  [['com.skype.', 'skype.exe', 'microsoft.skypeapp_'], { name: 'Skype' }],
  [['app.tuple.', 'tuple.exe'], { name: 'Tuple' }],
  [['co.teamport.around', 'around.exe'], { name: 'Around' }],
  [['com.google.chrome', 'chrome.exe'], { name: 'Chrome', browser: true }],
  [['com.apple.safari', 'com.apple.webkit'], { name: 'Safari', browser: true }],
  [['org.mozilla.firefox', 'firefox.exe'], { name: 'Firefox', browser: true }],
  [['company.thebrowser.', 'arc.exe', 'thebrowsercompany.arc_'], { name: 'Arc', browser: true }],
  [['com.brave.browser', 'brave.exe'], { name: 'Brave', browser: true }],
  [['com.microsoft.edgemac', 'msedge.exe'], { name: 'Edge', browser: true }],
  [['com.vivaldi.', 'vivaldi.exe'], { name: 'Vivaldi', browser: true }],
  [['com.operasoftware.', 'opera.exe'], { name: 'Opera', browser: true }]
]

/** The call app behind a mic user id (bundle id, exe name or package family), or null if it isn't one. */
export function callAppFor(id: string): CallApp | null {
  const k = id.toLowerCase()
  for (const [prefixes, app] of APPS) if (prefixes.some((p) => k.startsWith(p))) return app
  return null
}

/** Our own processes (dev Electron or the packaged app) never count. */
export function isSelf(id: string): boolean {
  const k = id.toLowerCase()
  return k.startsWith('ai.mentat.') || k.startsWith('com.github.electron') || k === 'mentat.exe' || k === 'electron.exe'
}

export type CallEvent = { type: 'started'; app: CallApp } | { type: 'ended'; app: CallApp }

/**
 * Feed it the ids using the mic every second or so. A call "starts" once an app has held the mic for
 * `startAfterMs` (so a quick mic check doesn't prompt) and "ends" once it has let go for `endAfterMs`
 * (so a brief mute or device switch doesn't stop the notes).
 */
export class CallTracker {
  private seen = new Map<string, { app: CallApp; since: number; lastSeen: number; announced: boolean }>()

  constructor(
    private startAfterMs = 3000,
    private endAfterMs = 10_000
  ) {}

  /** Apps currently in an announced call. */
  active(): CallApp[] {
    return [...this.seen.values()].filter((s) => s.announced).map((s) => s.app)
  }

  update(ids: string[], now = Date.now()): CallEvent[] {
    const events: CallEvent[] = []
    const present = new Map<string, CallApp>()
    for (const id of ids) {
      if (isSelf(id)) continue
      const app = callAppFor(id)
      if (app) present.set(app.name, app)
    }
    for (const [name, app] of present) {
      const s = this.seen.get(name)
      if (!s) this.seen.set(name, { app, since: now, lastSeen: now, announced: false })
      else s.lastSeen = now
    }
    for (const [name, s] of this.seen) {
      if (!present.has(name) && now - s.lastSeen >= (s.announced ? this.endAfterMs : 0)) {
        this.seen.delete(name)
        if (s.announced) events.push({ type: 'ended', app: s.app })
      } else if (!s.announced && present.has(name) && now - s.since >= this.startAfterMs) {
        s.announced = true
        events.push({ type: 'started', app: s.app })
      }
    }
    return events
  }
}

/**
 * Parse `reg query HKCU\...\CapabilityAccessManager\ConsentStore\microphone /s` output into the apps
 * using the mic right now (LastUsedTimeStart set and LastUsedTimeStop zero). Returns exe names
 * (e.g. "zoom.exe") for desktop apps and package family names for Store apps.
 */
export function parseWindowsMicRegistry(out: string): string[] {
  const inUse: string[] = []
  let key = ''
  let start = 0n
  let stop = -1n
  const flush = () => {
    if (key && start > 0n && stop === 0n) {
      const leaf = key.split('\\').pop() ?? ''
      inUse.push((leaf.split('#').pop() ?? leaf).toLowerCase())
    }
  }
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('HKEY_')) {
      flush()
      key = line
      start = 0n
      stop = -1n
      continue
    }
    const m = line.match(/^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i)
    if (m) {
      const v = BigInt(m[2])
      if (m[1] === 'LastUsedTimeStart') start = v
      else stop = v
    }
  }
  flush()
  return inUse.filter((k) => k !== 'nonpackaged')
}
