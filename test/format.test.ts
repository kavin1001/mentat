import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transcriptToText, transcriptToSrt } from '../src/shared/format'
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
