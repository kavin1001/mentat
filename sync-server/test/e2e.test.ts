// End-to-end sync tests: real desktop sync code (file store, change index, local pairing server,
// cloud adapter), the real relay server, and a "phone" using the same RecordStore the mobile app uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  RecordStore,
  SyncClient,
  SyncTransport,
  bytesToHex,
  cloudKeys,
  createProfile,
  fromBase64,
  keysFromMaster,
  signIn,
  sealRecord,
  PAIRING_PREFIX,
  type PairingPayload,
  type KdfParams
} from '@mentat/sync-core'
import { Store } from '../../src/shared/store'
import type { Meeting } from '../../src/shared/types'
import { LocalIndex } from '../../src/main/sync/local-index'
import { LocalSyncServer, newPairing, pairingPayload } from '../../src/main/sync/local-server'
import { DesktopCloudAdapter } from '../../src/main/sync/cloud-adapter'
import { createRelay } from '../src/server'

const FAST_KDF: KdfParams = { alg: 'scrypt', N: 2 ** 14, r: 8, p: 1 }
const tmp = () => mkdtempSync(join(tmpdir(), 'mentat-sync-'))

function seedDesktop() {
  const store = new Store(tmp())
  const a = store.createMeeting({
    title: 'Acme discovery call',
    notes: '- budget?\n',
    transcript: [{ id: 's1', speaker: 'them', text: 'We spend about forty thousand a year.', start: 1, end: 4 }]
  })
  const b = store.createMeeting({ title: 'Weekly 1:1 with Sam', notes: 'career goals' })
  const folder = store.createFolder('Customers')
  store.updateMeeting(a.id, { folderIds: [folder.id] })
  return { store, a, b, folder }
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function phonePairing(payload: string, url: string) {
  assert.ok(payload.startsWith(PAIRING_PREFIX))
  const p = JSON.parse(payload.slice(PAIRING_PREFIX.length)) as PairingPayload
  const keys = keysFromMaster(fromBase64(p.secret))
  const phone = new RecordStore()
  const client = new SyncClient(new SyncTransport(url, () => bytesToHex(keys.authKey)), keys, phone)
  return { phone, client }
}

test('local pairing: phone pulls, edits, and the desktop file updates; deletes and conflicts resolve', async () => {
  const { store, a, b } = seedDesktop()
  const index = new LocalIndex(store)
  let remoteChanges = 0
  const server = new LocalSyncServer(index, { onRemoteChange: () => remoteChanges++ })
  const device = newPairing('Test phone')
  server.setDevices([device])
  await server.start(0, '127.0.0.1')
  const url = `http://127.0.0.1:${server.port}`
  try {
    // Unpaired requests are refused.
    const res = await fetch(`${url}/v1/changes?since=0`)
    assert.equal(res.status, 401)
    const bogus = await fetch(`${url}/v1/changes?since=0`, { headers: { authorization: `Bearer ${'ab'.repeat(32)}` } })
    assert.equal(bogus.status, 401)

    const { phone, client } = phonePairing(pairingPayload(device, server.port!), url)
    let stats = await client.sync()
    assert.equal(stats.errors.length, 0)
    assert.equal(phone.list<Meeting>('meeting').length, 2)
    assert.equal(phone.list('folder').length, 1)
    assert.equal(phone.get<Meeting>('meeting', a.id)!.transcript[0].text, 'We spend about forty thousand a year.')

    // Phone edits notes -> desktop file changes, with the phone's updatedAt kept.
    const edited = await phone.put('meeting', { ...phone.get<Meeting>('meeting', a.id)!, notes: '- budget: 40k/yr\n- follow up Tuesday' })
    stats = await client.sync()
    assert.equal(stats.pushed, 1)
    assert.equal(remoteChanges, 1)
    const onDisk = store.getMeeting(a.id)!
    assert.equal(onDisk.notes, '- budget: 40k/yr\n- follow up Tuesday')
    assert.equal(onDisk.updatedAt, edited.updatedAt)
    assert.ok(readFileSync(join(store.meetingsDir, `${a.id}.md`), 'utf8').includes('40k/yr'), 'markdown mirror updated')

    // Phone creates a quick note -> appears on desktop.
    const quick = await phone.put('meeting', { id: 'phone-note-1', title: 'Hallway chat', createdAt: new Date().toISOString(), attendees: [], folderIds: [], notes: 'Ask about Q3 hiring', transcript: [] } as unknown as Meeting)
    await client.sync()
    assert.equal(store.getMeeting(quick.id)!.title, 'Hallway chat')

    // Desktop deletes a meeting -> phone gets the tombstone.
    store.deleteMeeting(b.id)
    await client.sync()
    assert.equal(phone.get('meeting', b.id), undefined)

    // Conflict: phone edits notes on a stale copy while the desktop keeps recording (appends transcript)
    // and saves later. The desktop's newer write wins the notes; the transcript is always the computer's.
    await phone.put('meeting', { ...phone.get<Meeting>('meeting', a.id)!, notes: 'phone wins?' })
    await new Promise((r) => setTimeout(r, 5))
    const m = store.getMeeting(a.id)!
    m.transcript.push({ id: 's2', speaker: 'me', text: 'Great, let us send a proposal.', start: 5, end: 7 })
    store.saveMeeting(m)
    stats = await client.sync()
    assert.equal(stats.errors.length, 0)
    const phoneCopy = phone.get<Meeting>('meeting', a.id)!
    const deskCopy = store.getMeeting(a.id)!
    assert.equal(phoneCopy.notes, '- budget: 40k/yr\n- follow up Tuesday', 'newer desktop write wins')
    assert.deepEqual(phoneCopy.transcript.map((s) => s.id), ['s1', 's2'])
    assert.equal(deskCopy.notes, phoneCopy.notes)
    assert.equal(phone.pendingCount(), 0)

    // Opposite order: desktop appends transcript, then the phone edits notes later on its stale copy.
    // The phone's notes win, and the desktop's new transcript line is kept on both sides.
    const m2 = store.getMeeting(a.id)!
    m2.transcript.push({ id: 's3', speaker: 'them', text: 'Send it by Friday.', start: 8, end: 9 })
    store.saveMeeting(m2)
    await new Promise((r) => setTimeout(r, 5))
    await phone.put('meeting', { ...phone.get<Meeting>('meeting', a.id)!, notes: 'phone edited last' })
    stats = await client.sync()
    assert.equal(stats.errors.length, 0)
    assert.equal(store.getMeeting(a.id)!.notes, 'phone edited last')
    assert.deepEqual(store.getMeeting(a.id)!.transcript.map((s) => s.id), ['s1', 's2', 's3'])
    assert.deepEqual(phone.get<Meeting>('meeting', a.id)!.transcript.map((s) => s.id), ['s1', 's2', 's3'])
    assert.equal(phone.get<Meeting>('meeting', a.id)!.notes, 'phone edited last')

    // Echo removal: the computer deletes a transcript segment, then the phone edits notes on a stale copy
    // that still has it. The phone's notes win, but the removed segment must not come back.
    const m3 = store.getMeeting(a.id)!
    m3.transcript = m3.transcript.filter((x) => x.id !== 's2')
    store.saveMeeting(m3)
    await new Promise((r) => setTimeout(r, 5))
    await phone.put('meeting', { ...phone.get<Meeting>('meeting', a.id)!, notes: 'phone after echo removal' })
    assert.ok(phone.get<Meeting>('meeting', a.id)!.transcript.some((x) => x.id === 's2'), 'phone copy is stale')
    stats = await client.sync()
    assert.equal(stats.errors.length, 0)
    assert.equal(store.getMeeting(a.id)!.notes, 'phone after echo removal')
    assert.deepEqual(store.getMeeting(a.id)!.transcript.map((x) => x.id), ['s1', 's3'])
    assert.deepEqual(phone.get<Meeting>('meeting', a.id)!.transcript.map((x) => x.id), ['s1', 's3'])

    // Real push conflict: the desktop saves between the phone's pull and its push.
    await phone.put('meeting', { ...phone.get<Meeting>('meeting', a.id)!, title: 'Phone title' })
    const origPending = phone.pendingChanges.bind(phone)
    phone.pendingChanges = async () => {
      phone.pendingChanges = origPending
      await new Promise((r) => setTimeout(r, 5))
      store.updateMeeting(a.id, { title: 'Desktop title (newer)' })
      return origPending()
    }
    stats = await client.sync()
    assert.equal(stats.conflicts, 1)
    assert.equal(phone.get<Meeting>('meeting', a.id)!.title, 'Desktop title (newer)')
    assert.equal(store.getMeeting(a.id)!.title, 'Desktop title (newer)')

    // Replay: someone on the Wi-Fi who captured an old push resends it. It must not roll the note back.
    const keys = keysFromMaster(fromBase64(device.secret))
    const old = sealRecord(keys, { v: 1, kind: 'meeting', id: a.id, updatedAt: '2020-01-01T00:00:00.000Z', data: { ...store.getMeeting(a.id)!, title: 'Rolled back' } })
    const replay = await fetch(`${url}/v1/changes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bytesToHex(keys.authKey)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{ ...old, baseSeq: 1e9 }] })
    })
    const rj = (await replay.json()) as { results: { ok: boolean }[] }
    assert.equal(rj.results[0].ok, false)
    assert.equal(store.getMeeting(a.id)!.title, 'Desktop title (newer)')

    // Converged: another sync moves nothing.
    stats = await client.sync()
    assert.equal(stats.pushed, 0)
  } finally {
    await server.stop()
  }
})

test('cloud profile: desktop and phone sync through the relay, which only sees ciphertext', async () => {
  const dir = tmp()
  const dbPath = join(dir, 'relay.db')
  const { server } = createRelay({ dbPath, signupCode: 'let-me-in' })
  const relayUrl = await listen(server)
  try {
    const { store, a } = seedDesktop()
    const index = new LocalIndex(store)

    // Signup is gated by the code.
    await assert.rejects(createProfile({ serverUrl: relayUrl, username: 'kavin', password: 'correct horse battery', kdf: FAST_KDF }), /signup code/)
    await assert.rejects(createProfile({ serverUrl: relayUrl, username: 'kavin', password: 'short', signupCode: 'let-me-in', kdf: FAST_KDF }), /at least/)

    const deskSession = await createProfile({ serverUrl: relayUrl, username: 'Kavin', password: 'correct horse battery', signupCode: 'let-me-in', kdf: FAST_KDF })
    assert.equal(deskSession.username, 'kavin')
    const deskAdapter = new DesktopCloudAdapter(index)
    const desk = new SyncClient(new SyncTransport(relayUrl, () => deskSession.token), cloudKeys(deskSession), deskAdapter)
    let stats = await desk.sync()
    assert.equal(stats.pushed, 3) // 2 meetings + 1 folder

    // Nothing readable on the server.
    const raw = readFileSync(dbPath).toString('latin1') + (existsSync(dbPath + '-wal') ? readFileSync(dbPath + '-wal').toString('latin1') : '')
    for (const secret of ['Acme', 'forty thousand', 'Customers', a.id, 'correct horse']) assert.ok(!raw.includes(secret), `relay db leaks "${secret}"`)

    // Wrong password is refused; unknown users get a plausible kdf answer (no enumeration).
    await assert.rejects(signIn({ serverUrl: relayUrl, username: 'kavin', password: 'wrong password!!' }), /Wrong username or password/)
    const unknown = (await (await fetch(`${relayUrl}/v1/profiles/nobody/kdf`)).json()) as { salt: string }
    assert.ok(unknown.salt.length > 10)

    // Phone signs in with the same password and gets everything.
    const phoneSession = await signIn({ serverUrl: relayUrl, username: 'kavin', password: 'correct horse battery' })
    assert.equal(phoneSession.master, deskSession.master)
    const phone = new RecordStore()
    const phoneClient = new SyncClient(new SyncTransport(relayUrl, () => phoneSession.token), cloudKeys(phoneSession), phone)
    await phoneClient.sync()
    assert.equal(phone.list('meeting').length, 2)

    // Phone edit reaches the desktop's files through the relay.
    await phone.put('meeting', { ...phone.get<Meeting>('meeting', a.id)!, title: 'Acme discovery call (renamed on phone)' })
    await phoneClient.sync()
    stats = await desk.sync()
    assert.equal(stats.pulled >= 1, true)
    assert.equal(store.getMeeting(a.id)!.title, 'Acme discovery call (renamed on phone)')

    // And the desktop doesn't echo it back as a new change.
    stats = await desk.sync()
    assert.equal(stats.pushed, 0)

    // Signed-out token is rejected.
    await fetch(`${relayUrl}/v1/sessions`, { method: 'DELETE', headers: { authorization: `Bearer ${phoneSession.token}` } })
    await assert.rejects(phoneClient.sync(), /Signed out/)

    // Deleting the profile wipes its data.
    await fetch(`${relayUrl}/v1/profiles/me`, { method: 'DELETE', headers: { authorization: `Bearer ${deskSession.token}` } })
    await assert.rejects(desk.sync(), /Signed out/)
  } finally {
    server.close()
  }
})

test('desktop forwards phone edits from the local network to the cloud', async () => {
  const { server: relay } = createRelay({ dbPath: join(tmp(), 'r.db') })
  const relayUrl = await listen(relay)
  const { store, a } = seedDesktop()
  const index = new LocalIndex(store)
  const lan = new LocalSyncServer(index)
  const device = newPairing('Phone A')
  lan.setDevices([device])
  await lan.start(0, '127.0.0.1')
  try {
    const s = await createProfile({ serverUrl: relayUrl, username: 'kavin', password: 'correct horse battery', kdf: FAST_KDF })
    const desk = new SyncClient(new SyncTransport(relayUrl, () => s.token), cloudKeys(s), new DesktopCloudAdapter(index))
    await desk.sync()

    const { phone: phoneA, client: lanClient } = phonePairing(pairingPayload(device, lan.port!), `http://127.0.0.1:${lan.port}`)
    await lanClient.sync()
    await phoneA.put('meeting', { ...phoneA.get<Meeting>('meeting', a.id)!, notes: 'edited on the LAN phone' })
    await lanClient.sync()

    const st = await desk.sync()
    assert.equal(st.pushed, 1)

    const phoneB = new RecordStore()
    const s2 = await signIn({ serverUrl: relayUrl, username: 'kavin', password: 'correct horse battery' })
    await new SyncClient(new SyncTransport(relayUrl, () => s2.token), cloudKeys(s2), phoneB).sync()
    assert.equal(phoneB.get<Meeting>('meeting', a.id)!.notes, 'edited on the LAN phone')

    // Deleting a meeting on the phone removes the desktop file.
    await phoneA.remove('meeting', a.id)
    await lanClient.sync()
    assert.equal(existsSync(join(store.meetingsDir, `${a.id}.json`)), false)
  } finally {
    await lan.stop()
    relay.close()
  }
})
