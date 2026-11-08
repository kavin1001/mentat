/// <reference lib="webworker" />
// On-device transcription worker. Receives interleaved stereo 16 kHz PCM16 (left = me, right = them),
// splits each channel into utterances with a simple energy VAD, and transcribes each utterance with a
// local Whisper / Moonshine model. Nothing leaves the machine.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { STT_MODELS } from '../../shared/stt-models'

type Speaker = 'me' | 'them'

export type WorkerIn =
  | { type: 'load'; model: string; language: string; ortBase: string }
  | { type: 'start'; offset: number }
  | { type: 'audio'; pcm: ArrayBuffer }
  | { type: 'stop' }

export type WorkerOut =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; device: string }
  | { type: 'speaking'; speaker: Speaker; active: boolean }
  | { type: 'segment'; speaker: Speaker; text: string; start: number; end: number }
  | { type: 'drained' }
  | { type: 'error'; message: string }

const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

// Runtime from the app bundle, never from a CDN.
env.allowLocalModels = false
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
function useLocalRuntime(base: string): void {
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`, wasm: `${base}ort-wasm-simd-threaded.jsep.wasm` }
}

const SR = 16000
const FRAME = 480 // 30 ms
const MIN_SPEECH = 0.4 * SR
const END_SILENCE = 0.7 * SR
const MAX_UTTERANCE = 20 * SR
const PAD = 0.2 * SR

let asr: AutomaticSpeechRecognitionPipeline | null = null
let language = 'en'
let multilingual = true
let offset = 0
let sampleClock = 0 // samples received since start

class ChannelVad {
  private buf: Float32Array[] = []
  private bufLen = 0
  private speech = false
  private silence = 0
  private utterStart = 0
  private noise = 0.003
  private pre: Float32Array[] = []
  private frameAcc = new Float32Array(0)

  constructor(private speaker: Speaker) {}

  push(samples: Float32Array, clock: number): void {
    const merged = new Float32Array(this.frameAcc.length + samples.length)
    merged.set(this.frameAcc)
    merged.set(samples, this.frameAcc.length)
    let i = 0
    for (; i + FRAME <= merged.length; i += FRAME) this.frame(merged.subarray(i, i + FRAME), clock - (merged.length - i))
    this.frameAcc = merged.slice(i)
  }

  private frame(f: Float32Array, frameStart: number): void {
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    const rms = Math.sqrt(sum / f.length)
    const isSpeech = rms > Math.max(0.008, this.noise * 3)
    if (!isSpeech) this.noise = this.noise * 0.98 + rms * 0.02
    const copy = f.slice()

    if (!this.speech) {
      this.pre.push(copy)
      if (this.pre.length * FRAME > PAD) this.pre.shift()
      if (isSpeech) {
        this.speech = true
        this.silence = 0
        this.utterStart = frameStart - this.pre.length * FRAME + FRAME
        this.buf = [...this.pre]
        this.bufLen = this.pre.length * FRAME
        this.pre = []
        post({ type: 'speaking', speaker: this.speaker, active: true })
      }
      return
    }
    this.buf.push(copy)
    this.bufLen += FRAME
    this.silence = isSpeech ? 0 : this.silence + FRAME
    if (this.silence >= END_SILENCE || this.bufLen >= MAX_UTTERANCE) this.flush()
  }

  flush(): void {
    if (!this.speech) return
    const len = this.bufLen
    const audio = new Float32Array(len)
    let o = 0
    for (const b of this.buf) {
      audio.set(b, o)
      o += b.length
    }
    const start = this.utterStart
    const voiced = len - Math.min(this.silence, len)
    this.speech = false
    this.buf = []
    this.bufLen = 0
    this.silence = 0
    post({ type: 'speaking', speaker: this.speaker, active: false })
    if (voiced >= MIN_SPEECH) enqueue({ speaker: this.speaker, audio, start: start / SR, end: (start + len) / SR })
  }
}

const vads: Record<Speaker, ChannelVad> = { me: new ChannelVad('me'), them: new ChannelVad('them') }

// Utterances are transcribed one at a time, in order.
const queue: { speaker: Speaker; audio: Float32Array; start: number; end: number }[] = []
let busy = false
let stopping = false

function enqueue(u: (typeof queue)[number]): void {
  queue.push(u)
  void drain()
}

// Whisper hallucinates these on silence/noise.
const JUNK = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you|\.|bye\.?)$/i

async function drain(): Promise<void> {
  if (busy || !asr) return
  busy = true
  try {
    while (queue.length) {
      const u = queue.shift()!
      const out = (await asr(u.audio, multilingual ? { language: language === 'multi' ? undefined : language, task: 'transcribe' } : {})) as { text: string }
      const text = out.text.trim()
      if (text && !JUNK.test(text)) post({ type: 'segment', speaker: u.speaker, text, start: offset + u.start, end: offset + u.end })
    }
  } catch (err) {
    post({ type: 'error', message: `Transcription failed: ${(err as Error).message}` })
  } finally {
    busy = false
    if (stopping && !queue.length) {
      stopping = false
      post({ type: 'drained' })
    }
  }
}

async function load(modelId: string, lang: string): Promise<void> {
  const spec = STT_MODELS.find((m) => m.id === modelId) ?? STT_MODELS[1]
  language = lang
  multilingual = spec.multilingual
  const nav = self.navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }
  const hasGpu = !!(nav.gpu && (await nav.gpu.requestAdapter().catch(() => null)))
  const device = hasGpu ? 'webgpu' : 'wasm'
  const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file) post({ type: 'progress', file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 })
  }
  asr?.dispose()
  asr = (await pipeline('automatic-speech-recognition', spec.id, {
    device,
    dtype: hasGpu ? (spec.dtype as never) : 'q8',
    progress_callback: progress_callback as never
  })) as AutomaticSpeechRecognitionPipeline
  // Warm up so the first real utterance is not slow.
  await asr(new Float32Array(SR))
  post({ type: 'ready', device })
}

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'load':
        useLocalRuntime(msg.ortBase)
        await load(msg.model, msg.language)
        break
      case 'start':
        offset = msg.offset
        sampleClock = 0
        stopping = false
        break
      case 'audio': {
        const pcm = new Int16Array(msg.pcm)
        const n = pcm.length / 2
        const l = new Float32Array(n)
        const r = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          l[i] = pcm[2 * i] / 0x8000
          r[i] = pcm[2 * i + 1] / 0x8000
        }
        sampleClock += n
        vads.me.push(l, sampleClock)
        vads.them.push(r, sampleClock)
        break
      }
      case 'stop':
        stopping = true
        vads.me.flush()
        vads.them.flush()
        if (!busy && !queue.length) {
          stopping = false
          post({ type: 'drained' })
        } else void drain()
        break
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message })
  }
}
