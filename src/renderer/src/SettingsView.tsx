import { useEffect, useRef, useState } from 'react'
import type { GoogleStatus, Settings, Template } from '../../shared/types'
import { api, type UpdateStatus } from './api'
import { DIARIZATION_MODEL, STT_MODELS } from '../../shared/stt-models'
import { SyncSettings } from './SyncSettings'

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best notes)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' }
]

export function SettingsView({ onError }: { onError: (m: string) => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [google, setGoogle] = useState<GoogleStatus>({ connected: false, canConnect: true })
  const [templates, setTemplates] = useState<Template[]>([])
  const [info, setInfo] = useState<{ dataDir: string; mcpServerPath: string; nodePath: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    void api.settings.get().then(setS)
    void api.google.status().then(setGoogle)
    void api.templates.list().then(setTemplates)
    void api.app.info().then(setInfo)
    void api.app.version().then(setVersion)
    void api.app.updateStatus().then(setUpdate)
    return api.app.onUpdateStatus(setUpdate)
  }, [])

  // Settings save themselves a moment after each change, so nothing is lost by navigating away.
  const dirty = useRef(false)
  useEffect(() => {
    if (!s || !dirty.current) return
    const t = setTimeout(() => {
      dirty.current = false
      void api.settings.save(s).then(() => setSaved(true))
    }, 500)
    return () => clearTimeout(t)
  }, [s])

  if (!s) return null
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    dirty.current = true
    setS({ ...s, [k]: v })
    setSaved(false)
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
        <h3>Google Drive and Calendar</h3>
        <GoogleConnect s={s} google={google} setGoogle={setGoogle} set={set} onError={onError} />
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
        <label className="check">
          <input type="checkbox" checked={s.diarize ?? true} onChange={(e) => set('diarize', e.target.checked)} /> Tell apart the other people on the call by voice (Speaker 1, Speaker 2…; click a name in the transcript to rename). Adds a {DIARIZATION_MODEL.sizeMb} MB model.
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
        <h3>Calls</h3>
        <p className="muted small">
          Mentat notices when Zoom, Google Meet, Teams, Slack, FaceTime and similar apps start using your microphone, and
          offers to take notes. It only checks which app holds the mic; nothing is recorded until you say so.
        </p>
        <label className="check">
          <input type="checkbox" checked={s.autoDetectCalls ?? true} onChange={(e) => set('autoDetectCalls', e.target.checked)} /> Offer to take notes when a call starts
        </label>
        <label className="check">
          <input type="checkbox" checked={s.autoStopRecording ?? true} onChange={(e) => set('autoStopRecording', e.target.checked)} /> Stop recording when the call ends
        </label>
        <label className="check">
          <input type="checkbox" checked={s.openAtLogin ?? true} onChange={(e) => set('openAtLogin', e.target.checked)} /> Open Mentat in the background when I log in
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

      <SyncSettings onError={onError} />

      <section className="card">
        <h3>Your data</h3>
        <p className="muted small">
          Every note is stored as JSON and Markdown, and every transcript as plain text, in <code>{info?.dataDir}</code>.
        </p>
        <button className="btn" onClick={() => api.app.openDataDir()}>
          Open folder
        </button>
      </section>

      <section className="card">
        <h3>Updates</h3>
        <p className="muted small">
          Mentat {version}. {updateText(update)}
        </p>
        {update.state === 'ready' ? (
          <button className="btn primary" onClick={() => api.app.installUpdate()}>
            Restart to update
          </button>
        ) : (
          update.state !== 'disabled' && (
            <button className="btn" disabled={update.state === 'checking' || update.state === 'downloading'} onClick={() => void api.app.checkForUpdates().then(setUpdate)}>
              Check for updates
            </button>
          )
        )}
      </section>

      <div className="row end sticky-save">
        <span className="muted small">{saved ? 'All changes saved' : 'Changes save automatically'}</span>
      </div>
    </div>
  )
}

function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case 'disabled':
      return 'Automatic updates are on in installed builds only.'
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return 'You have the latest version.'
    case 'available':
    case 'downloading':
      return `Downloading ${u.version ?? 'an update'}${u.percent != null ? ` (${u.percent}%)` : ''}…`
    case 'ready':
      return `Version ${u.version} is ready to install.`
    case 'error':
      return `Update check failed: ${u.message}`
    default:
      return 'Updates install automatically when you quit.'
  }
}

/** One-click Google connection, with plain-language guidance for each step of Google's consent screens. */
function GoogleConnect({
  s,
  google,
  setGoogle,
  set,
  onError
}: {
  s: Settings
  google: GoogleStatus
  setGoogle: (g: GoogleStatus) => void
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  onError: (m: string) => void
}) {
  const [waiting, setWaiting] = useState(false)
  const connect = async () => {
    setWaiting(true)
    try {
      await api.settings.save(s) // in case an Advanced client was just entered
      setGoogle(await api.google.connect())
    } catch (e) {
      const msg = (e as Error).message
      if (!/cancelled/.test(msg)) onError(msg)
    } finally {
      setWaiting(false)
    }
  }

  return (
    <div className="google-connect">
      {google.connected ? (
        <>
          <div className="status">
            <span>
              ✓ Connected{google.email ? ` as ${google.email}` : ''}
            </span>
            <span className="spacer" />
            <button className="btn" onClick={async () => setGoogle(await api.google.disconnect())}>
              Disconnect
            </button>
          </div>
          <p className="muted small">
            {google.drive === 'full'
              ? 'Mentat can read and write your Google Drive: it saves notes and transcripts there, and Claude can look things up in your Drive when you ask a question.'
              : null}
            {google.calendar ? ' It can also see your calendar (read only) to name notes and remind you when meetings start.' : null}
          </p>
          {google.drive !== 'full' && (
            <div className="notice">
              {google.drive === 'limited'
                ? 'Mentat can only see files it created itself. Reconnect to let it read your Drive and file notes into folders you already have.'
                : 'Google Drive access was not granted (the Drive box was left unticked). Reconnect and tick every box.'}{' '}
              <button className="link" onClick={connect} disabled={waiting}>
                Reconnect
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="muted small">
            Connect your Google account so Mentat can save every note and full transcript to Drive, let Claude read your Drive files when you ask a
            question, and see upcoming meetings on your calendar.
          </p>
          <div className="status">
            {waiting ? (
              <>
                <span>Waiting for you to finish in your browser…</span>
                <button className="btn" onClick={() => void api.google.cancel()}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn primary" onClick={connect} disabled={!google.canConnect && !s.googleClientId}>
                Connect Google Drive
              </button>
            )}
          </div>
          {google.canConnect || s.googleClientId ? (
            <div className="muted small">
              What happens next:
              <ol>
                <li>Your browser opens Google sign-in. Pick your account.</li>
                <li>
                  If Google says <em>“Google hasn’t verified this app”</em>, click <strong>Advanced</strong>, then <strong>Go to Mentat</strong>. Mentat is a
                  personal app that hasn’t been through Google’s review yet. Your files only travel between this computer and Google.
                </li>
                <li>
                  Tick <strong>every box</strong> (Drive and Calendar) and click <strong>Continue</strong>.
                </li>
                <li>Come back here. Mentat shows “Connected” when it’s done.</li>
              </ol>
            </div>
          ) : (
            <div className="notice">
              This copy of Mentat was built without its Google sign-in client, so the button is off. Installed releases include it. If you built Mentat
              yourself, follow docs/google-drive.md, or add your own client under Advanced below.
            </div>
          )}
        </>
      )}
      <details className="small">
        <summary className="muted">Advanced: use your own Google OAuth client</summary>
        <p className="muted small">
          Only needed if you build Mentat yourself without its client, or want to use your own Google Cloud project. Create an OAuth client of type
          “Desktop app”, enable the Drive and Calendar APIs, and paste it here. Leave both empty to use Mentat’s built-in client
          {google.builtInClient ? '' : ' (this build has none)'}.
        </p>
        <label>
          OAuth client ID
          <input value={s.googleClientId} onChange={(e) => set('googleClientId', e.target.value.trim())} />
        </label>
        <label>
          OAuth client secret
          <input type="password" value={s.googleClientSecret} onChange={(e) => set('googleClientSecret', e.target.value.trim())} />
        </label>
      </details>
    </div>
  )
}
