// Reports which apps are using the microphone, about once a second.
// macOS: the bundled mic-monitor helper (CoreAudio process list, macOS 14+). Windows: the microphone
// privacy registry, which marks apps holding the mic with LastUsedTimeStop = 0. Neither opens the mic.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseWindowsMicRegistry } from '../shared/calls'

export type MicListener = (ids: string[]) => void

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'

export function helperPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'mic-monitor') : join(app.getAppPath(), 'resources', 'bin', 'mic-monitor')
}

/** Start watching. Returns a stop function, or null when this platform can't be watched. */
export function watchMic(onChange: MicListener): (() => void) | null {
  if (process.platform === 'darwin') return watchMac(onChange)
  if (process.platform === 'win32') return watchWindows(onChange)
  return null
}

function watchMac(onChange: MicListener): (() => void) | null {
  const exe = helperPath()
  if (!existsSync(exe)) {
    console.warn('mic-monitor helper not found at', exe, '- call detection is off')
    return null
  }
  let child: ChildProcess | null = null
  let stopped = false
  let buf = ''
  const start = () => {
    child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const ids = JSON.parse(line)
          if (Array.isArray(ids)) onChange(ids.map(String))
        } catch {
          /* ignore partial lines */
        }
      }
    })
    child.on('exit', () => {
      child = null
      if (!stopped) setTimeout(start, 5000) // restart if it crashes
    })
  }
  start()
  return () => {
    stopped = true
    child?.kill()
  }
}

function watchWindows(onChange: MicListener): () => void {
  let last = ''
  const poll = () =>
    execFile('reg', ['query', WIN_KEY, '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return
      const ids = parseWindowsMicRegistry(out)
      const key = ids.join('|')
      if (key !== last) {
        last = key
        onChange(ids)
      }
    })
  poll()
  const t = setInterval(poll, 1500)
  return () => clearInterval(t)
}
