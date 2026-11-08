// App-wide sync state: the on-device record store, the current connection, and automatic syncing
// (on launch, when the app comes to the foreground, every 20 s while open, and shortly after edits).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import {
  HttpError,
  RecordStore,
  SyncClient,
  SyncTransport,
  createProfile,
  deleteProfile,
  signIn,
  signOut,
  type PairingPayload,
  type ServerInfo
} from '@mentat/sync-core'
import { filePersistence, loadAll } from './storage'
import { keysFor, loadConnection, saveConnection, tokenFor, type Connection } from './connection'

export interface SyncStatus {
  syncing: boolean
  lastSyncAt?: string
  error?: string
}

interface SyncContextValue {
  ready: boolean
  store: RecordStore
  /** Increments whenever records change, so screens re-render. */
  version: number
  connection: Connection | null
  status: SyncStatus
  syncNow(): Promise<void>
  pairWithComputer(p: PairingPayload): Promise<void>
  connectCloud(o: { serverUrl: string; username: string; password: string; create: boolean; signupCode?: string }, onProgress?: (f: number) => void): Promise<void>
  disconnect(opts?: { deleteCloudProfile?: boolean }): Promise<void>
}

const Ctx = createContext<SyncContextValue | null>(null)

export const useSync = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSync outside SyncProvider')
  return v
}

const AUTO_MS = 20_000

async function probe(url: string): Promise<ServerInfo | null> {
  try {
    const info = await new SyncTransport(url, () => undefined, undefined, 3000).info()
    return info.app === 'mentat-sync' ? info : null
  } catch {
    return null
  }
}

function friendly(e: unknown, c: Connection | null): string {
  if (e instanceof HttpError) return e.message
  const msg = (e as Error)?.message ?? String(e)
  if (/network request failed|abort|fetch failed|timed? ?out/i.test(msg))
    return c?.type === 'local'
      ? `Can’t reach ${c.name}. Make sure Mentat is open on your computer and both are on the same Wi-Fi.`
      : 'Can’t reach the sync server. Check your connection.'
  return msg
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<RecordStore>(new RecordStore(filePersistence))
  const [ready, setReady] = useState(false)
  const [version, setVersion] = useState(0)
  const [connection, setConnection] = useState<Connection | null>(null)
  const [status, setStatus] = useState<SyncStatus>({ syncing: false })
  const connRef = useRef<Connection | null>(null)
  const clientRef = useRef<SyncClient | null>(null)
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const applyingRemote = useRef(false)

  const setConn = useCallback(async (c: Connection | null) => {
    connRef.current = c
    clientRef.current = null
    setConnection(c)
    await saveConnection(c)
  }, [])

  const clientFor = (c: Connection) => {
    if (!clientRef.current) {
      const url = c.type === 'local' ? (c.lastUrl ?? c.urls[0]) : c.serverUrl
      clientRef.current = new SyncClient(new SyncTransport(url, () => tokenFor(c)), keysFor(c), storeRef.current)
    }
    return clientRef.current
  }

  const syncNow = useCallback(async () => {
    const c = connRef.current
    if (!c) return
    setStatus((s) => ({ ...s, syncing: true }))
    applyingRemote.current = true
    try {
      try {
        await clientFor(c).sync()
      } catch (e) {
        // The computer's address may have changed (new Wi-Fi, DHCP): try the others from the pairing code.
        if (c.type !== 'local' || e instanceof HttpError) throw e
        let found: string | undefined
        for (const u of c.urls) if (u !== c.lastUrl && (await probe(u))) found = u
        if (!found) throw e
        await setConn({ ...c, lastUrl: found })
        await clientFor(connRef.current!).sync()
      }
      setStatus({ syncing: false, lastSyncAt: new Date().toISOString() })
    } catch (e) {
      setStatus((s) => ({ ...s, syncing: false, error: friendly(e, c) }))
    } finally {
      applyingRemote.current = false
    }
  }, [setConn])

  // Load from disk.
  useEffect(() => {
    void (async () => {
      const [{ records, cursor }, conn] = await Promise.all([loadAll(), loadConnection()])
      storeRef.current = new RecordStore(filePersistence, records, cursor)
      connRef.current = conn
      setConnection(conn)
      setReady(true)
      setVersion((v) => v + 1)
    })()
  }, [])

  // Re-render on any change; sync soon after local edits.
  useEffect(() => {
    if (!ready) return
    return storeRef.current.subscribe(() => {
      setVersion((v) => v + 1)
      if (applyingRemote.current || !connRef.current) return
      if (editTimer.current) clearTimeout(editTimer.current)
      editTimer.current = setTimeout(() => void syncNow(), 1500)
    })
  }, [ready, syncNow])

  // Sync on launch, on foreground, and periodically while open.
  useEffect(() => {
    if (!ready || !connection) return
    void syncNow()
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => void syncNow(), AUTO_MS)
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        void syncNow()
        if (!timer) timer = setInterval(() => void syncNow(), AUTO_MS)
      } else if (timer) {
        clearInterval(timer)
        timer = null
      }
    })
    return () => {
      sub.remove()
      if (timer) clearInterval(timer)
    }
  }, [ready, connection?.type, syncNow]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = useCallback(
    async (c: Connection) => {
      if (connRef.current) await storeRef.current.resetForNewTarget()
      await setConn(c)
      setStatus({ syncing: false })
      await syncNow()
    },
    [setConn, syncNow]
  )

  const pairWithComputer = useCallback(
    async (p: PairingPayload) => {
      let url: string | undefined
      for (const u of p.urls) if ((await probe(u))?.mode === 'local') url = url ?? u
      if (!url)
        throw new Error(`Can’t reach ${p.name}. Make sure your phone is on the same Wi-Fi as your computer and Mentat is open there.`)
      await switchTo({ type: 'local', name: p.name, urls: p.urls, secret: p.secret, lastUrl: url })
    },
    [switchTo]
  )

  const connectCloud = useCallback<SyncContextValue['connectCloud']>(
    async (o, onProgress) => {
      const serverUrl = o.serverUrl.trim().replace(/\/+$/, '')
      const session = o.create
        ? await createProfile({ serverUrl, username: o.username, password: o.password, signupCode: o.signupCode, onProgress })
        : await signIn({ serverUrl, username: o.username, password: o.password, onProgress })
      await switchTo({ type: 'cloud', ...session })
    },
    [switchTo]
  )

  const disconnect = useCallback(
    async (opts: { deleteCloudProfile?: boolean } = {}) => {
      const c = connRef.current
      if (c?.type === 'cloud') {
        if (opts.deleteCloudProfile) await deleteProfile(c)
        else await signOut(c)
      }
      await storeRef.current.resetForNewTarget()
      await setConn(null)
      setStatus({ syncing: false })
    },
    [setConn]
  )

  const value = useMemo<SyncContextValue>(
    () => ({ ready, store: storeRef.current, version, connection, status, syncNow, pairWithComputer, connectCloud, disconnect }),
    [ready, version, connection, status, syncNow, pairWithComputer, connectCloud, disconnect]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
