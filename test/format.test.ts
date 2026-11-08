import { test } from 'node:test'
import assert from 'node:assert/strict'
import { meetingToDocHtml, transcriptToText, transcriptToSrt } from '../src/shared/format'
import { removeEcho } from '../src/shared/echo'
import type { TranscriptSegment } from '../src/shared/types'

const seg = (speaker: 'me' | 'them', start: number, text: string, speakerIndex?: number): TranscriptSegment => ({
  id: `${start}`,
  speaker,
  speakerIndex,
  text,
  start,
  end: start + 3
})

test('one remote person is labelled "Them"', () => {
  const t = transcriptToText([seg('me', 0, 'Hi.'), seg('them', 4, 'Hello.', 0)])
  assert.equal(t, '[00:00] Me: Hi.\n[00:04] Them: Hello.')
})

test('several remote people get Speaker N, and names override', () => {
  const s = [seg('them', 0, 'One.', 0), seg('them', 4, 'Two.', 1), seg('them', 8, 'Three.', 0)]
  assert.equal(transcriptToText(s), '[00:00] Speaker 1: One.\n[00:04] Speaker 2: Two.\n[00:08] Speaker 1: Three.')
  assert.match(transcriptToText(s, { 1: 'Priya' }), /Priya: Two\./)
  assert.match(transcriptToSrt(s, { 0: 'Tom' }), /Tom: One\./)
})

test('echo of the other side is removed from the mic channel', () => {
  const out = removeEcho([
    seg('them', 10, 'We lose maybe thirty minutes per rep per day.'),
    seg('me', 10.5, 'we lose maybe thirty minutes per rep'),
    seg('me', 30, 'Great, I will send the security pack.')
  ])
  assert.deepEqual(out.map((s) => s.start), [10, 30])
})

test('Drive doc puts the transcript after the notes, behind a page break', () => {
  const html = meetingToDocHtml({
    id: 'm1', title: 'Acme sync', createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z',
    attendees: [], folderIds: [], notes: '- pricing',
    transcript: [{ id: 's1', speaker: 'them', text: 'Let us talk pricing', start: 0, end: 3 }]
  })
  const brk = html.indexOf('page-break-before: always')
  assert.ok(brk > html.indexOf('pricing'), 'notes come first')
  assert.ok(html.indexOf('Let us talk pricing') > brk, 'transcript comes after the break')
  assert.equal(html.match(/<html>/g)?.length, 1)
  const noTranscript = meetingToDocHtml({ id: 'm2', title: 'x', createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z', attendees: [], folderIds: [], notes: 'n', transcript: [] })
  assert.ok(!noTranscript.includes('page-break'))
})
