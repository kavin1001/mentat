// Shared workspaces end to end: real relay, real desktop WorkspaceService for each person, and the same
// read path the MCP server uses (shared/workspaces.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createProfile, type CloudSession, type KdfParams } from '@mentat/sync-core'
import { decodeInvite, inviteKeys, identityFromMaster, bindIdentity } from '@mentat/sync-core/src/workspace'
import { Store } from '../../src/shared/store'
import { listLocalWorkspaces, workspaceStore } from '../../src/shared/workspaces'
import { WorkspaceService } from '../../src/main/sync/workspaces'
import { createRelay } from '../src/server'

const FAST_KDF: KdfParams = { alg: 'scrypt', N: 2 ** 14, r: 8, p: 1 }
const tmp = () => mkdtempSync(join(tmpdir(), 'mentat-ws-'))

async function person(url: string, username: string) {
  const session: CloudSession = await createProfile({ serverUrl: url, username, password: 'correct horse battery', kdf: FAST_KDF })
  const store = new Store(tmp())
  let current: CloudSession | null = session
  const ws = new WorkspaceService(store, () => current)
  return { session, store, ws, signOut: () => (current = null) }
}

const api = (url: string, token: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: r.status, body: (await r.json()) as any }
}

test('workspaces: invite, roles, read shared notes and transcripts, revoke with key rotation', async () => {
  const dbPath = join(tmp(), 'relay.db')
  const { server } = createRelay({ dbPath })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const kavin = await person(url, 'kavin')
    const sam = await person(url, 'sam')
    const ana = await person(url, 'ana')
    const eve = await person(url, 'eve')

    // Kavin's notes: one in a shared folder, one shared directly, one private.
    const customers = kavin.store.createFolder('Customers')
    const acme = kavin.store.createMeeting({
      title: 'Acme discovery call',
      notes: '- budget?',
      folderIds: [customers.id],
      drive: { docId: 'd1', webViewLink: 'https://docs.google.com/x', syncedAt: new Date().toISOString() },
      transcript: [{ id: 's1', speaker: 'them', text: 'We spend about forty thousand a year on this.', start: 1, end: 4 }],
      enhanced: { templateId: 'general', generatedAt: new Date().toISOString(), summary: 'Acme wants a pilot in Q1.', sections: [], actionItems: [] }
    })
    const standup = kavin.store.createMeeting({ title: 'Team standup', notes: 'shipping friday' })
    const oneOnOne = kavin.store.createMeeting({ title: 'Private 1:1', notes: 'compensation discussion' })

    // Create the workspace and share.
    let st = await kavin.ws.create('Sales team')
    assert.equal(st.lastError, undefined)
    assert.equal(st.workspaces.length, 1)
    const wsId = st.workspaces[0].id
    assert.equal(st.workspaces[0].name, 'Sales team')
    assert.equal(st.workspaces[0].role, 'owner')
    await kavin.ws.shareFolder(wsId, customers.id, true)
    st = await kavin.ws.shareMeeting(wsId, standup.id, true)
    assert.equal(st.lastError, undefined, st.lastError)

    // Invite Sam as a viewer and Ana as an editor.
    const samInvite = await kavin.ws.invite(wsId, 'viewer')
    const anaInvite = await kavin.ws.invite(wsId, 'editor')
    const decoded = decodeInvite(samInvite.code)
    assert.equal(decoded.name, 'Sales team')
    assert.equal(decoded.role, 'viewer')

    // Sam joins and gets exactly the shared meetings, including the transcript and AI notes.
    st = await sam.ws.join(samInvite.code)
    assert.equal(st.lastError, undefined, st.lastError)
    assert.equal(st.workspaces[0].role, 'viewer')
    assert.equal(st.workspaces[0].name, 'Sales team')
    const local = listLocalWorkspaces(sam.store.dataDir)
    assert.equal(local.length, 1)
    assert.deepEqual(local[0].members.map((m) => `${m.username}:${m.role}`), ['kavin:owner', 'sam:viewer'])
    const samCache = workspaceStore(sam.store.dataDir, wsId)
    const titles = samCache.allMeetings().map((m) => m.title).sort()
    assert.deepEqual(titles, ['Acme discovery call', 'Team standup'])
    const acmeCopy = samCache.getMeeting(acme.id)!
    assert.equal(acmeCopy.transcript[0].text, 'We spend about forty thousand a year on this.')
    assert.equal(acmeCopy.enhanced?.summary, 'Acme wants a pilot in Q1.')
    assert.equal(acmeCopy.sharedBy, 'kavin')
    assert.equal(acmeCopy.drive, undefined, 'Drive links stay private')
    assert.deepEqual(acmeCopy.folderIds, [])
    assert.equal(samCache.search('forty thousand')[0].meeting.id, acme.id)
    // Sam's own notes are untouched and the shared copies don't leak into them.
    assert.equal(sam.store.allMeetings().length, 0)

    // An invite works once.
    const again = await person(url, 'mallory')
    await assert.rejects(again.ws.join(samInvite.code).then((s) => { if (s.lastError) throw new Error(s.lastError) }), /already used/)

    // Viewers can't write, even by talking to the relay directly.
    const samApi = api(url, sam.session.token)
    const denied = await samApi('POST', `/v1/workspaces/${wsId}/changes`, { changes: [] })
    assert.equal(denied.status, 403)
    // Sam sharing a folder of his own into the workspace does nothing (view-only).
    const samFolder = sam.store.createFolder('Mine')
    sam.store.createMeeting({ title: 'Sam secret', folderIds: [samFolder.id] })
    st = await sam.ws.shareFolder(wsId, samFolder.id, true)
    assert.equal(workspaceStore(kavin.store.dataDir, wsId).allMeetings().length, 0)

    // Non-members can't see the workspace at all.
    const eveApi = api(url, eve.session.token)
    assert.equal((await eveApi('GET', `/v1/workspaces/${wsId}/changes?since=0`)).status, 404)
    assert.equal((await eveApi('GET', `/v1/workspaces/${wsId}`)).status, 404)
    assert.equal((await eveApi('POST', `/v1/workspaces/${wsId}/invites`, {})).status, 404)

    // Ana (editor) joins and shares one of her own meetings; Kavin and Sam receive it.
    await ana.ws.join(anaInvite.code)
    const anaFolder = ana.store.createFolder('Ana calls')
    const anaMeeting = ana.store.createMeeting({
      title: 'Beta Corp renewal',
      folderIds: [anaFolder.id],
      transcript: [{ id: 'a1', speaker: 'me', text: 'Renewal is at risk unless we fix SSO.', start: 0, end: 3 }]
    })
    st = await ana.ws.shareFolder(wsId, anaFolder.id, true)
    assert.equal(st.lastError, undefined)
    assert.equal(st.workspaces[0].error, undefined, st.workspaces[0].error)
    await kavin.ws.sync()
    await sam.ws.sync()
    assert.equal(workspaceStore(kavin.store.dataDir, wsId).getMeeting(anaMeeting.id)?.sharedBy, 'ana')
    assert.equal(samCache.getMeeting(anaMeeting.id)?.transcript[0].text, 'Renewal is at risk unless we fix SSO.')
    // Kavin's own meetings never come back into his cache.
    assert.equal(workspaceStore(kavin.store.dataDir, wsId).getMeeting(acme.id), null)

    // Ana can't overwrite Kavin's meeting even though she can write.
    const anaApi = api(url, ana.session.token)
    const ws0 = (await anaApi('GET', `/v1/workspaces/${wsId}/changes?since=0`)).body
    const kavinsRecord = ws0.changes.find((c: any) => c.author === 'kavin')
    const overwrite = await anaApi('POST', `/v1/workspaces/${wsId}/changes`, { changes: [{ key: kavinsRecord.key, baseSeq: 999, blob: kavinsRecord.blob }] })
    assert.equal(overwrite.status, 403)

    // Edits and unsharing propagate.
    kavin.store.updateMeeting(acme.id, { notes: '- budget: 40k' })
    await kavin.ws.shareMeeting(wsId, standup.id, false)
    await sam.ws.sync()
    assert.equal(samCache.getMeeting(acme.id)?.notes, '- budget: 40k')
    assert.equal(samCache.getMeeting(standup.id), null)
    assert.equal(samCache.getMeeting(oneOnOne.id), null)

    // The owner sees members with verified keys.
    const det = await kavin.ws.detail(wsId)
    assert.deepEqual(det.members.map((m) => [m.username, m.role, m.verified]), [
      ['kavin', 'owner', true],
      ['sam', 'viewer', true],
      ['ana', 'editor', true]
    ])

    // Role change: Ana becomes a viewer and can no longer push.
    await kavin.ws.setRole(wsId, 'ana', 'viewer')
    assert.equal((await anaApi('POST', `/v1/workspaces/${wsId}/changes`, { changes: [] })).status, 403)

    // Remove Sam: keys rotate, his local copy is deleted on next sync, and new content uses a key he never got.
    const oldEpoch = (await samApi('GET', `/v1/workspaces/${wsId}`)).body.epoch
    st = await kavin.ws.removeMember(wsId, 'sam')
    assert.equal(st.workspaces[0].error, undefined, st.workspaces[0].error)
    const after = (await api(url, kavin.session.token)('GET', `/v1/workspaces/${wsId}`)).body
    assert.equal(after.epoch, oldEpoch + 1)
    assert.equal(after.rotateNeeded, false)
    st = await sam.ws.sync()
    assert.equal(st.workspaces.length, 0)
    assert.equal(listLocalWorkspaces(sam.store.dataDir).length, 0)
    assert.equal(existsSync(join(sam.store.dataDir, 'workspaces', wsId)), false)
    assert.equal((await samApi('GET', `/v1/workspaces/${wsId}/changes?since=0`)).status, 404)
    // Ana (still a member) keeps reading, including content written after the rotation.
    kavin.store.updateMeeting(acme.id, { notes: '- budget: 45k' })
    await kavin.ws.sync()
    await ana.ws.sync()
    assert.equal(workspaceStore(ana.store.dataDir, wsId).getMeeting(acme.id)?.notes, '- budget: 45k')

    // A pending invite from before the rotation is revoked by it.
    const stale = await kavin.ws.invite(wsId, 'viewer')
    await kavin.ws.removeMember(wsId, 'ana')
    const eveJoin = await eve.ws.join(stale.code).catch((e) => e as Error)
    assert.match(String((eveJoin as Error).message ?? (eveJoin as any).lastError), /doesn’t exist|revoked/)

    // A relay that swaps in its own key for a member is caught: the owner won't seal keys to it.
    const fresh = await kavin.ws.invite(wsId, 'viewer')
    const inv = decodeInvite(fresh.code)
    const ik = inviteKeys(inv.secretBytes)
    const evePub = identityFromMaster(eve.session.master).publicKey
    const eveApi2 = api(url, eve.session.token)
    // Eve redeems with a binding that doesn't match the key she presents (as a key-swapping relay would).
    const bad = await eveApi2('POST', '/v1/invites/redeem', { workspaceId: wsId, token: ik.token, publicKey: evePub, binding: bindIdentity(ik, 'eve', 'ab'.repeat(32)) })
    assert.equal(bad.status, 200)
    const det2 = await kavin.ws.detail(wsId)
    assert.equal(det2.members.find((m) => m.username === 'eve')?.verified, false)

    // The relay never stored any plaintext: names, notes and transcripts are all ciphertext.
    const raw = readFileSync(dbPath).toString('latin1') + (existsSync(dbPath + '-wal') ? readFileSync(dbPath + '-wal').toString('latin1') : '')
    for (const secret of ['forty thousand', 'Acme', 'Sales team', 'SSO', 'budget', 'Beta Corp']) assert.ok(!raw.includes(secret), `relay db contains "${secret}"`)

    // Signing out removes every shared copy from this computer.
    kavin.ws.clearLocal()
    assert.equal(listLocalWorkspaces(kavin.store.dataDir).length, 0)

    // Deleting the workspace removes it for everyone.
    const del = await api(url, kavin.session.token)('DELETE', `/v1/workspaces/${wsId}`)
    assert.equal(del.status, 200)
    assert.equal((await eveApi2('GET', '/v1/workspaces')).body.workspaces.length, 0)
  } finally {
    server.close()
  }
})
