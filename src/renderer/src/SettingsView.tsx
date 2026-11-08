import { useEffect, useState } from 'react'
import type { GoogleStatus, Settings, Template } from '../../shared/types'
import { api } from './api'
import { STT_MODELS } from '../../shared/stt-models'

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best notes)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' }
]

export function SettingsView({ onError }: { onError: (m: string) => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [google, setGoogle] = useState<GoogleStatus>({ connected: false })
  const [templates, setTemplates] = useState<Template[]>([])
  const [info, setInfo] = useState<{ dataDir: string; mcpServerPath: string; nodePath: string } | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void api.settings.get().then(setS)
    void api.google.status().then(setGoogle)
    void api.templates.list().then(setTemplates)
    void api.app.info().then(setInfo)
  }, [])

  if (!s) return null
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS({ ...s, [k]: v })
    setSaved(false)
  }
  const save = async () => {
    await api.settings.save(s)
    setSaved(true)
  }

  const mcpConfig = info
    ? JSON.stringify({ mcpServers: { mentat: { command: info.nodePath, args: [info.mcpServerPath], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2)
    : ''

  return (
    <div className="page settings">
      <h2>Settings</h2>

      <section className="card">
        <h3>Claude</h3>
        <label>
          Anthropic API key
          <input type="password" value={s.anthropicApiKey} onChange={(e) => set('anthropicApiKey', e.target.value)} placeholder="sk-ant-…" />
        </label>
        <label>
          Model
          <select value={s.model} onChange={(e) => set('model', e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Default template
          <select value={s.defaultTemplateId} onChange={(e) => set('defaultTemplateId', e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="card">
        <h3>Transcription (on this computer)</h3>
        <p className="muted small">
          Speech is transcribed locally with an open-source model, using your GPU when available. Audio never leaves this computer and is not stored.
          The model is downloaded once the first time you record, then works offline.
        </p>
        <label>
          Speech model
          <select value={s.sttModel} onChange={(e) => set('sttModel', e.target.value)}>
            {STT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.sizeMb} MB
              </option>
            ))}
          </select>
        </label>
        <label>
          Language
          <select value={s.language} onChange={(e) => set('language', e.target.value)}>
            {[['en', 'English'], ['multi', 'Auto-detect'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['nl', 'Dutch'], ['it', 'Italian']].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dictionary for Claude (names, products, jargon; one per line)
          <textarea rows={4} value={s.dictionary.join('\n')} onChange={(e) => set('dictionary', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean))} />
        </label>
      </section>

      <section className="card">
        <h3>Google Drive and Calendar</h3>
        <p className="muted small">
          Create an OAuth client of type “Desktop app” in Google Cloud Console, enable the Calendar and Drive APIs, and paste its ID and secret here. Mentat asks only for read access to your calendar and access to files it creates in Drive.
        </p>
        <label>
          OAuth client ID
          <input value={s.googleClientId} onChange={(e) => set('googleClientId', e.target.value)} />
        </label>
        <label>
          OAuth client secret
          <input type="password" value={s.googleClientSecret} onChange={(e) => set('googleClientSecret', e.target.value)} />
        </label>
        <div className="row">
          {google.connected ? (
            <>
              <span>Connected{google.email ? ` as ${google.email}` : ''}</span>
              <button className="btn" onClick={async () => { await api.google.disconnect(); setGoogle({ connected: false }) }}>
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api.settings.save(s)
                  setGoogle(await api.google.connect())
                } catch (e) {
                  onError((e as Error).message)
                }
              }}
            >
              Connect Google
            </button>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={s.driveAutoSync} onChange={(e) => set('driveAutoSync', e.target.checked)} /> Push every enhanced note and its full transcript to Google Drive
        </label>
        <label>
          Drive folder
          <input value={s.driveFolderName} onChange={(e) => set('driveFolderName', e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.driveAutoClassify} onChange={(e) => set('driveAutoClassify', e.target.checked)} /> Let Claude file each note into the right sub-folder (e.g. Customers / Acme Corp)
        </label>
        <label>
          Filing rules for Claude (optional)
          <textarea
            rows={3}
            placeholder={'Customer calls go under Customers/<company>\nInterviews go under Hiring/<role>\nAnything with @mycompany.com only goes under Internal/<team>'}
            value={s.driveRules}
            onChange={(e) => set('driveRules', e.target.value)}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoDetectMeetings} onChange={(e) => set('autoDetectMeetings', e.target.checked)} /> Notify me when a calendar meeting starts
        </label>
      </section>

      <section className="card">
        <h3>Use your meetings in Claude (MCP)</h3>
        <p className="muted small">Add this to Claude Desktop’s config (Settings → Developer → Edit config) or Claude Code’s .mcp.json. Claude can then list, search and read every note and full transcript.</p>
        <pre className="code">{mcpConfig}</pre>
        <button className="btn" onClick={() => navigator.clipboard.writeText(mcpConfig)}>
          Copy config
        </button>
      </section>

      <section className="card">
        <h3>Your data</h3>
        <p className="muted small">
          Every note is stored as JSON and Markdown, and every transcript as plain text, in <code>{info?.dataDir}</code>.
        </p>
        <button className="btn" onClick={() => api.app.openDataDir()}>
          Open folder
        </button>
      </section>

      <div className="row end sticky-save">
        {saved && <span className="muted">Saved</span>}
        <button className="btn primary" onClick={save}>
          Save settings
        </button>
      </div>
    </div>
  )
}
