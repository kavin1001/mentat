import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpeakerClusterer, cosine } from '../src/shared/speakers'

// Fake 64-d "voices": each speaker is a random direction; utterances add a little noise.
function voice(seed: number): number[] {
  let x = seed
  return Array.from({ length: 64 }, () => ((x = (x * 9301 + 49297) % 233280) / 233280) * 2 - 1)
}
const noisy = (v: number[], amt: number, seed: number) => {
  let x = seed
  return v.map((a) => a + (((x = (x * 9301 + 49297) % 233280) / 233280) * 2 - 1) * amt)
}

test('cosine of identical vectors is 1', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
})

test('clusters utterances by voice and keeps numbering stable', () => {
  const a = voice(1)
  const b = voice(2)
  const c = new SpeakerClusterer(0.8)
  const seq = [a, a, b, a, b, b].map((v, i) => c.assign(noisy(v, 0.15, i + 10)))
  assert.deepEqual(seq, [0, 0, 1, 0, 1, 1])
  assert.equal(c.size, 2)
})

test('respects the speaker cap', () => {
  const c = new SpeakerClusterer(0.99, 2)
  for (let i = 0; i < 5; i++) c.assign(voice(i + 100))
  assert.equal(c.size, 2)
})
