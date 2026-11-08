// Auto-update from GitHub releases (only in packaged builds; dev and unsigned local builds skip it).
import { app } from 'electron'
import electronUpdater from 'electron-updater'

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'none' | 'disabled' }
  | { state: 'available' | 'downloading'; version?: string; percent?: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

let status: UpdateStatus = { state: 'idle' }

export function initUpdater(onStatus: (s: UpdateStatus) => void): { check: () => Promise<UpdateStatus>; status: () => UpdateStatus } {
  const set = (s: UpdateStatus) => onStatus((status = s))
  const enabled = app.isPackaged && !process.env.MENTAT_SMOKE_TEST && !process.env.MENTAT_DISABLE_UPDATES
  if (!enabled) {
    status = { state: 'disabled' }
    return { check: async () => status, status: () => status }
  }
  const { autoUpdater } = electronUpdater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('update-available', (i) => set({ state: 'available', version: i.version }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => set({ state: 'error', message: e.message }))

  const check = async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      set({ state: 'error', message: (e as Error).message })
    }
    return status
  }
  setTimeout(() => void check(), 10_000)
  setInterval(() => void check(), 4 * 60 * 60 * 1000)
  return { check, status: () => status }
}

export function installUpdate(): void {
  if (status.state === 'ready') electronUpdater.autoUpdater.quitAndInstall()
}
