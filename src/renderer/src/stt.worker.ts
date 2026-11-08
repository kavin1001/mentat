/// <reference lib="webworker" />
// On-device transcription worker. Receives interleaved stereo 16 kHz PCM16 (left = me, right = them),
// splits each channel into utterances with a simple energy VAD, transcribes each utterance with a local
// Whisper / Moonshine model, streams live partial text while someone is still talking, and tells apart the
// people on the "them" channel with a local speaker-embedding model. Nothing leaves the machine.
import { AutoModel, AutoProcessor, env, pipeline, type AutomaticSpeechRecognitionPipeline, type PreTrainedModel, type Processor } from '@huggingface/transformers'
import { DIARIZATION_MODEL, STT_MODELS } from '../../shared/stt-models'
import { SpeakerClusterer } from '../../shared/speakers'

type Speaker = 'me' | 'them'

export type WorkerIn =
  | { type: 'load'; model: string; language: string; ortBase: string; diarize: boolean }
  | { type: 'start'; offset: number; meetingId: string }
  | { type: 'audio'; pcm: ArrayBuffer }
  | { type: 'stop' }

export type WorkerOut =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; device: string }
  | { type: 'speaking'; speaker: Speaker; active: boolean }
  | { type: 'partial'; speaker: Speaker; text: string }
  | { type: 'segment'; speaker: Speaker; speakerIndex?: number; text: string; start: number; end: number }
  | { type: 'drained' }
  | { type: 'error'; message: string }

const post = (m: WorkerOut) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

// Runtime from the app bundle, never from a CDN.
env.allowLocalModels = false
// The runtime is already a local file; the Cache API cannot store app:// URLs anyway.
env.useWasmCache = false
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } }
function useLocalRuntime(base: string): void {
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${base}ort-wasm-simd-threaded.asyncify.wasm` }
}

const SR = 16000
const FRAME = 480 // 30 ms
const MIN_SPEECH = 0.4 * SR
const END_SILENCE = 0.7 * SR
const MAX_UTTERANCE = 20 * SR
const PAD = 0.2 * SR
const PARTIAL_EVERY_MS = 600 // how often live text refreshes while someone is talking
const PARTIAL_WINDOW = 15 * SR // transcribe at most the last 15 s for live text
const MIN_DIARIZE = 1 * SR // shorter utterances are too short to identify a voice reliably

let asr: AutomaticSpeechRecognitionPipeline | null = null
let language = 'en'
let multilingual = true
let offset = 0
let sampleClock = 0 // samples received since start
let diarize = true
let spkProcessor: Processor | null = null
let spkModel: PreTrainedModel | null = null
const clusterer = new SpeakerClusterer()
let currentMeeting = ''

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

  get speaking(): boolean {
    return this.speech
  }

  /** The utterance so far (last PARTIAL_WINDOW samples), for live text. */
  snapshot(): Float32Array | null {
    if (!this.speech || this.bufLen < 0.5 * SR) return null
    const take = Math.min(this.bufLen, PARTIAL_WINDOW)
    const out = new Float32Array(take)
    let o = take
    for (let i = this.buf.length - 1; i >= 0 && o > 0; i--) {
      const b = this.buf[i]
      const n = Math.min(b.length, o)
      out.set(b.subarray(b.length - n), o - n)
      o -= n
    }
    return out
  }

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

// Utterances are transcribed one at a time, in order; finished utterances always go before live text.
const queue: { speaker: Speaker; audio: Float32Array; start: number; end: number }[] = []
let busy = false
let stopping = false

function enqueue(u: (typeof queue)[number]): void {
  queue.push(u)
  void drain()
}

// Whisper hallucinates these on silence/noise.
const JUNK = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you|\.|bye\.?)$/i

const asrOptions = () => (multilingual ? { language: language === 'multi' ? undefined : language, task: 'transcribe' } : {})

async function speakerOf(u: (typeof queue)[number]): Promise<number | undefined> {
  if (!diarize || u.speaker !== 'them' || !spkModel || !spkProcessor || u.audio.length < MIN_DIARIZE) return undefined
  const inputs = await spkProcessor(u.audio)
  const out = (await spkModel(inputs)) as { embeddings: { data: Float32Array } }
  return clusterer.assign(out.embeddings.data)
}

async function drain(): Promise<void> {
  if (busy || !asr) return
  busy = true
  try {
    while (queue.length) {
      const u = queue.shift()!
      const out = (await asr(u.audio, asrOptions())) as { text: string }
      const text = out.text.trim()
      if (!text || JUNK.test(text)) continue
      let speakerIndex: number | undefined
      try {
        speakerIndex = await speakerOf(u)
      } catch (err) {
        console.warn('speaker id failed', err)
      }
      post({ type: 'segment', speaker: u.speaker, speakerIndex, text, start: offset + u.start, end: offset + u.end })
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
  await asr(new Float32Array(SR), asrOptions())
  if (diarize && !spkModel) {
    spkProcessor = await AutoProcessor.from_pretrained(DIARIZATION_MODEL.id, { progress_callback: progress_callback as never })
    spkModel = await AutoModel.from_pretrained(DIARIZATION_MODEL.id, { device: 'wasm', dtype: 'q8', progress_callback: progress_callback as never })
  }
  post({ type: 'ready', device })
}

// Live text: while someone is talking and the model is idle, re-transcribe their utterance so far.
let partialTurn: Speaker = 'them'
setInterval(async () => {
  if (busy || !asr || queue.length) return
  const order: Speaker[] = partialTurn === 'me' ? ['them', 'me'] : ['me', 'them']
  const speaker = order.find((s) => vads[s].speaking && vads[s].snapshot())
  if (!speaker) return
  partialTurn = speaker
  const audio = vads[speaker].snapshot()!
  busy = true
  try {
    const out = (await asr(audio, asrOptions())) as { text: string }
    const text = out.text.trim()
    if (text && !JUNK.test(text) && vads[speaker].speaking) post({ type: 'partial', speaker, text })
  } catch {
    // live text is best-effort
  } finally {
    busy = false
    if (queue.length) void drain()
  }
}, PARTIAL_EVERY_MS)

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'load':
        useLocalRuntime(msg.ortBase)
        diarize = msg.diarize
        await load(msg.model, msg.language)
        break
      case 'start':
        offset = msg.offset
        sampleClock = 0
        // Keep speaker numbering when a meeting is paused and resumed; start fresh for a new meeting.
        if (msg.meetingId !== currentMeeting) clusterer.reset()
        currentMeeting = msg.meetingId
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
