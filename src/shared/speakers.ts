// Online speaker clustering for the "them" channel. Each utterance gets a speaker embedding
// (from a local WavLM x-vector model); utterances whose embeddings are close enough are the same
// person. Pure code, so it can be unit-tested and reused outside the worker.

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}

export class SpeakerClusterer {
  private centroids: { sum: Float64Array; count: number }[] = []

  /**
   * @param threshold cosine similarity above which an utterance joins an existing speaker
   * @param maxSpeakers cap on distinct speakers; beyond it, utterances go to the nearest one
   */
  constructor(
    private threshold = 0.86,
    private maxSpeakers = 8
  ) {}

  get size(): number {
    return this.centroids.length
  }

  reset(): void {
    this.centroids = []
  }

  /** Assign an embedding to a speaker index (0-based), creating a new speaker when nobody matches. */
  assign(embedding: ArrayLike<number>): number {
    let best = -1
    let bestSim = -Infinity
    this.centroids.forEach((c, i) => {
      const sim = cosine(embedding, c.sum)
      if (sim > bestSim) {
        bestSim = sim
        best = i
      }
    })
    if (best === -1 || (bestSim < this.threshold && this.centroids.length < this.maxSpeakers)) {
      this.centroids.push({ sum: Float64Array.from(normalize(embedding)), count: 1 })
      return this.centroids.length - 1
    }
    const c = this.centroids[best]
    const n = normalize(embedding)
    for (let i = 0; i < c.sum.length; i++) c.sum[i] += n[i]
    c.count++
    return best
  }
}

function normalize(v: ArrayLike<number>): Float64Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  const out = new Float64Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}
