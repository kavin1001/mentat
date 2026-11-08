// App settings live in Electron's userData, apart from the meeting data folder,
// and API keys are encrypted with the OS keychain when it is available.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

const SECRET_KEYS = ['anthropicApiKey', 'googleClientSecret'] as const
const path = () => join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  if (!existsSync(path())) return { ...DEFAULT_SETTINGS }
  const raw = JSON.parse(readFileSync(path(), 'utf8')) as Record<string, unknown>
  for (const k of SECRET_KEYS) {
    const v = raw[k]
    if (typeof v === 'string' && v.startsWith('enc:') && safeStorage.isEncryptionAvailable()) {
      try {
        raw[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
      } catch {
        raw[k] = ''
      }
    }
  }
  return { ...DEFAULT_SETTINGS, ...(raw as Partial<Settings>) }
}

export function saveSettings(s: Settings): Settings {
  const out: Record<string, unknown> = { ...s }
  if (safeStorage.isEncryptionAvailable())
    for (const k of SECRET_KEYS) if (s[k]) out[k] = 'enc:' + safeStorage.encryptString(s[k]).toString('base64')
  writeFileSync(path(), JSON.stringify(out, null, 2))
  return s
}
