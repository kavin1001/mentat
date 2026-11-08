// Owns the on-device transcription worker for the whole app (the model stays loaded between meetings).
import type { WorkerIn, WorkerOut } from './stt.worker'
import { api } from './api'

type Listener = (m: WorkerOut) => void

let worker: Worker | null = null
let loaded: { model: string; language: string; diarize: boolean } | null = null
let loading: Promise<string> | null = null
let meetingId: string | null = null
const listeners = new Set<Listener>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data
    if (m.type === 'segment' && meetingId) void api.recording.segment(meetingId, { speaker: m.speaker, speakerIndex: m.speakerIndex, text: m.text, start: m.start, end: m.end })
    listeners.forEach((l) => l(m))
  }
  return worker
}

const send = (m: WorkerIn, transfer: Transferable[] = []) => getWorker().postMessage(m, transfer)

export function onTranscriber(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Load (or reuse) the configured model. Resolves with the device used ("webgpu" or "wasm"). */
export function ensureModel(model: string, language: string, diarize: boolean): Promise<string> {
  if (loaded?.model === model && loaded.language === language && loaded.diarize === diarize && loading) return loading
  loaded = { model, language, diarize }
  loading = new Promise<string>((resolve, reject) => {
    const off = onTranscriber((m) => {
      if (m.type === 'ready') {
        off()
        resolve(m.device)
      } else if (m.type === 'error') {
        off()
        loading = null
        loaded = null
        reject(new Error(m.message))
      }
    })
  })
  send({ type: 'load', model, language, diarize, ortBase: new URL('ort/', document.baseURI).href })
  return loading
}

export function beginTranscription(id: string, offset: number): void {
  meetingId = id
  send({ type: 'start', offset, meetingId: id })
}

export function pushAudio(pcm: ArrayBuffer): void {
  send({ type: 'audio', pcm }, [pcm])
}

/** Flush the last utterances and wait until they are transcribed. */
export function endTranscription(): Promise<void> {
  return new Promise((resolve) => {
    const off = onTranscriber((m) => {
      if (m.type === 'drained') {
        off()
        meetingId = null
        resolve()
      }
    })
    send({ type: 'stop' })
  })
}
