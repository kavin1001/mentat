import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallTracker, callAppFor, isSelf, parseWindowsMicRegistry } from '../src/shared/calls'

test('maps bundle ids and exe names to call apps', () => {
  assert.equal(callAppFor('us.zoom.xos')?.name, 'Zoom')
  assert.equal(callAppFor('com.microsoft.teams2')?.name, 'Microsoft Teams')
  assert.equal(callAppFor('com.google.Chrome.helper')?.name, 'Chrome')
  assert.equal(callAppFor('com.google.Chrome.helper')?.browser, true)
  assert.equal(callAppFor('Zoom.exe')?.name, 'Zoom')
  assert.equal(callAppFor('MSTeams_8wekyb3d8bbwe')?.name, 'Microsoft Teams')
  assert.equal(callAppFor('com.apple.Music'), null)
  assert.ok(isSelf('ai.mentat.desktop.helper'))
  assert.ok(isSelf('com.github.Electron.helper'))
})

test('a call starts after the mic is held a few seconds and ends after it is released', () => {
  const t = new CallTracker(3000, 10_000)
  assert.deepEqual(t.update(['us.zoom.xos'], 0), [])
  assert.deepEqual(t.update(['us.zoom.xos'], 1000), [])
  assert.deepEqual(t.update(['us.zoom.xos', 'ai.mentat.desktop'], 3000).map((e) => e.type), ['started'])
  assert.deepEqual(t.update(['us.zoom.xos'], 4000), [])
  assert.equal(t.active()[0].name, 'Zoom')
  // brief mute: no end
  assert.deepEqual(t.update([], 5000), [])
  assert.deepEqual(t.update(['us.zoom.xos'], 6000), [])
  assert.deepEqual(t.update([], 7000), [])
  assert.deepEqual(t.update([], 15_999), [])
  assert.deepEqual(t.update([], 16_000).map((e) => e.type), ['ended'])
  assert.equal(t.active().length, 0)
})

test('a quick mic check never prompts, and our own app is ignored', () => {
  const t = new CallTracker(3000, 10_000)
  assert.deepEqual(t.update(['com.tinyspeck.slackmacgap'], 0), [])
  assert.deepEqual(t.update([], 1000), [])
  assert.deepEqual(t.update(['com.tinyspeck.slackmacgap'], 2000), [])
  assert.deepEqual(t.update(['com.tinyspeck.slackmacgap'], 4000), [])
  assert.deepEqual(t.update(['com.tinyspeck.slackmacgap'], 5000).map((e) => e.type), ['started'])
  const self = new CallTracker(0, 0)
  assert.deepEqual(self.update(['ai.mentat.desktop', 'com.github.Electron'], 0), [])
})

test('parses the Windows microphone privacy registry', () => {
  const out = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
    '    Value    REG_SZ    Allow',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe',
    '    Value    REG_SZ    Allow',
    '    LastUsedTimeStart    REG_QWORD    0x1db2a3c4d5e6f70',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged',
    '    Value    REG_SZ    Allow',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#kavin#AppData#Roaming#Zoom#bin#Zoom.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1db2a3c4d5e6f70',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1db2a3c4d5e6f70',
    '    LastUsedTimeStop    REG_QWORD    0x1db2a3c4d5e6f99'
  ].join('\r\n')
  assert.deepEqual(parseWindowsMicRegistry(out), ['msteams_8wekyb3d8bbwe', 'zoom.exe'])
})
