import type { TranscriptSegment } from './types'

// Without headphones the microphone also hears the other side through the speakers, so the same words
// show up as both "Me" and "Them". System audio is the clean source: drop a "me" segment when most of its
// words were also said by "them" at about the same time.
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

export function removeEcho(segments: TranscriptSegment[]): TranscriptSegment[] {
  const them = segments.filter((s) => s.speaker === 'them')
  return segments.filter((s) => {
    if (s.speaker !== 'me') return true
    const mine = words(s.text)
    if (mine.length < 2) return true
    const nearby = them.filter((t) => t.start < s.end + 2 && t.end > s.start - 2)
    if (!nearby.length) return true
    const theirs = new Set(nearby.flatMap((t) => words(t.text)))
    const overlap = mine.filter((w) => theirs.has(w)).length / mine.length
    return overlap < 0.6
  })
}
