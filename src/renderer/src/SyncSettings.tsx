// Settings → "Phone and sync". Everything here is optional: Mentat is local-only until the user
// pairs a phone on their network (no password) or turns on cloud features with a password profile.
import { useEffect, useState } from 'react'
import { syncApi, type SyncStatus } from './syncApi'
import { WorkspacesSettings } from './WorkspacesSettings'

const ago = (iso?: string) => {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function SyncSettings({ onError }: { onError: (m: string) => void }) {
  const [st, setSt] = useState<SyncStatus | null>(null)
  const [pairing, setPairing] = useState<{ qr: string; name: string; id: string } | null>(null)
  const [phoneName, setPhoneName] = useState('My phone')
  const [mode, setMode] = useState<'create' | 'signin'>('create')
  const [form, setForm] = useState({ serverUrl: '', username: '', password: '', confirm: '', signupCode: '' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void syncApi.status().then(setSt)
    return syncApi.onStatus(setSt)
  }, [])

  // Close the QR once the phone has connected.
  useEffect(() => {
    if (pairing && st?.local.devices.some((d) => d.id === pairing.id && d.lastSeenAt)) setPairing(null)
  }, [st, pairing])

  if (!st) return null

  const run = async (fn: () => Promise<SyncStatus | void>) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r) setSt(r)
    } catch (e) {
      onError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  const submitProfile = () =>
    run(async () => {
      if (mode === 'create' && form.password !== form.confirm) throw new Error('The passwords don’t match.')
      const base = { serverUrl: form.serverUrl.trim(), username: form.username.trim(), password: form.password }
      const r = mode === 'create' ? await syncApi.createProfile({ ...base, signupCode: form.signupCode || undefined }) : await syncApi.signIn(base)
      setForm({ ...form, password: '', confirm: '' })
      return r
    })

  return (
    <>
      <section className="card">
        <h3>Phone on this network</h3>
        <p className="muted small">
          Sync with the Mentat phone app directly over your Wi-Fi. No account or password: you pair each phone once by scanning a code, and
          everything it sends is encrypted with a key only that phone and this computer have.
        </p>
        <label className="check">
          <input type="checkbox" checked={st.local.enabled} disabled={busy} onChange={(e) => run(() => syncApi.setLocalEnabled(e.target.checked))} />
          Allow paired phones to sync on this network {st.local.enabled && (st.local.listening ? <span className="muted small">(port {st.local.port})</span> : null)}
        </label>
        {st.local.error && <p className="warn small">{st.local.error}</p>}

        {st.local.devices.length > 0 && (
          <ul className="device-list">
            {st.local.devices.map((d) => (
              <li key={d.id} className="row">
                <span>{d.name}</span>
                <span className="muted small">last synced {ago(d.lastSeenAt)}</span>
                <span className="spacer" />
                <button className="link danger" onClick={() => run(() => syncApi.removeDevice(d.id))}>
                  Unpair
                </button>
              </li>
            ))}
          </ul>
        )}

        {pairing ? (
          <div className="pair-box">
            <img src={pairing.qr} alt="Pairing code" width={220} height={220} />
            <div>
              <p>
                <b>Scan this with the Mentat phone app</b> (Connect → Pair with computer).
              </p>
              <p className="muted small">
                The phone must be on the same Wi-Fi. This code is the key for “{pairing.name}”, so don’t share it. Unpair the phone to revoke it.
              </p>
              <button className="btn" onClick={() => setPairing(null)}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <input value={phoneName} onChange={(e) => setPhoneName(e.target.value)} placeholder="Phone name" style={{ maxWidth: 200 }} />
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const p = await syncApi.pair(phoneName)
                  setPairing({ qr: p.qr, name: phoneName.trim() || 'Phone', id: p.deviceId })
                  return syncApi.status()
                })
              }
            >
              Pair a phone
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Cloud features</h3>
        {st.cloud.active ? (
          <>
            <p className="small">
              Signed in as <b>{st.cloud.username}</b> on <code>{st.cloud.serverUrl}</code>. Your notes and transcripts are encrypted on this
              computer before they’re uploaded; the server can’t read them.
            </p>
            <p className="muted small">
              {st.cloud.syncing ? 'Syncing…' : `Last synced ${ago(st.cloud.lastSyncAt)}`}
              {st.cloud.lastStats && !st.cloud.syncing ? ` (${st.cloud.lastStats.pulled} in, ${st.cloud.lastStats.pushed} out)` : ''}
            </p>
            {st.cloud.lastError && <p className="warn small">{st.cloud.lastError}</p>}
            <div className="row">
              <button className="btn" disabled={busy || st.cloud.syncing} onClick={() => run(() => syncApi.syncNow())}>
                Sync now
              </button>
              <button className="btn" disabled={busy} onClick={() => run(() => syncApi.signOut())}>
                Sign out
              </button>
              <span className="spacer" />
              <button
                className="link danger"
                disabled={busy}
                onClick={() => confirm('Delete your cloud profile and everything synced to the server? Notes on this computer stay.') && run(() => syncApi.deleteProfile())}
              >
                Delete cloud profile
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              Off. Mentat runs entirely on this computer and needs no account. Turn on cloud features to sync with your phone from anywhere, using a
              password-protected profile on a Mentat sync server (you can host your own; see <code>sync-server/README.md</code>). The password
              never leaves your devices and is also your encryption key, so if you forget it, synced data can’t be recovered (your local notes are
              unaffected).
            </p>
            <div className="row">
              <button className={`btn ghost ${mode === 'create' ? 'active' : ''}`} onClick={() => setMode('create')}>
                Create profile
              </button>
              <button className={`btn ghost ${mode === 'signin' ? 'active' : ''}`} onClick={() => setMode('signin')}>
                Sign in
              </button>
            </div>
            <label>
              Sync server URL
              <input value={form.serverUrl} onChange={(e) => setForm({ ...form, serverUrl: e.target.value })} placeholder="https://sync.example.com" />
            </label>
            <label>
              Username
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="username" />
            </label>
            <label>
              Password
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              />
            </label>
            {mode === 'create' && (
              <>
                <label>
                  Confirm password
                  <input type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoComplete="new-password" />
                </label>
                <label>
                  Signup code (only if your server asks for one)
                  <input value={form.signupCode} onChange={(e) => setForm({ ...form, signupCode: e.target.value })} />
                </label>
              </>
            )}
            <button className="btn primary" disabled={busy || !form.serverUrl || !form.username || !form.password} onClick={submitProfile}>
              {busy ? 'Working…' : mode === 'create' ? 'Create profile and turn on sync' : 'Sign in and turn on sync'}
            </button>
          </>
        )}
      </section>
      <WorkspacesSettings onError={onError} />
    </>
  )
}
