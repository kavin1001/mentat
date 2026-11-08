// Streaming speech-to-text. Audio arrives from the renderer as interleaved stereo 16 kHz PCM16:
// channel 0 = microphone ("me"), channel 1 = system audio ("them"). Splitting by channel gives
// reliable me/them attribution without a bot, and diarization separates speakers within "them".
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import type { Settings, Speaker, TranscriptSegment } from '../shared/types'

export interface TranscriberEvents {
  onFinal: (seg: TranscriptSegment) => void
  onPartial: (speaker: Speaker, text: string) => void
  onError: (message: string) => void
  onClose: () => void
}

interface DeepgramResult {
  type: string
  channel_index?: [number, number]
  is_final?: boolean
  start?: number
  duration?: number
  channel?: { alternatives: { transcript: string; words?: { speaker?: number }[] }[] }
}

export class DeepgramTranscriber {
  private ws: WebSocket | null = null
  private keepAlive: NodeJS.Timeout | null = null
  private queue: Buffer[] = []

  constructor(
    private settings: Settings,
    private events: TranscriberEvents,
    /** Seconds to add to every timestamp, so a resumed recording continues the timeline. */
    private offset = 0
  ) {}

  start(): void {
    if (!this.settings.deepgramApiKey) throw new Error('Add a Deepgram API key in Settings to transcribe.')
    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '2',
      multichannel: 'true',
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      language: this.settings.language || 'en'
    })
    for (const term of this.settings.dictionary.slice(0, 50)) params.append('keyterm', term)
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.settings.deepgramApiKey}` }
    })
    this.ws.on('open', () => {
      for (const b of this.queue) this.ws!.send(b)
      this.queue = []
      this.keepAlive = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: 'KeepAlive' })), 8000)
    })
    this.ws.on('message', (raw) => this.handle(JSON.parse(raw.toString()) as DeepgramResult))
    this.ws.on('error', (err) => this.events.onError(`Transcription error: ${err.message}`))
    this.ws.on('close', () => {
      if (this.keepAlive) clearInterval(this.keepAlive)
      this.events.onClose()
    })
  }

  private handle(r: DeepgramResult): void {
    if (r.type !== 'Results' || !r.channel) return
    const alt = r.channel.alternatives[0]
    const text = alt?.transcript?.trim()
    if (!text) return
    const speaker: Speaker = (r.channel_index?.[0] ?? 0) === 0 ? 'me' : 'them'
    if (!r.is_final) {
      this.events.onPartial(speaker, text)
      return
    }
    const speakers = (alt.words ?? []).map((w) => w.speaker).filter((s): s is number => s !== undefined)
    const speakerIndex = speaker === 'them' && speakers.length ? mode(speakers) : undefined
    const start = this.offset + (r.start ?? 0)
    this.events.onFinal({ id: randomUUID(), speaker, speakerIndex, text, start, end: start + (r.duration ?? 0) })
  }

  send(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm)
    else if (this.ws?.readyState === WebSocket.CONNECTING) this.queue.push(pcm)
  }

  stop(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }))
    setTimeout(() => this.ws?.close(), 3000)
  }
}

function mode(xs: number[]): number {
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}
