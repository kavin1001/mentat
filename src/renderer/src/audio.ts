// Botless capture: microphone + system audio, mixed into a stereo stream
// (left = me, right = them), resampled to 16 kHz PCM16 and streamed to the main process.

const WORKLET = `
class PcmWriter extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.frames = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const l = input[0], r = input[1] || input[0];
    const out = new Int16Array(l.length * 2);
    let peakL = 0, peakR = 0;
    for (let i = 0; i < l.length; i++) {
      const a = Math.max(-1, Math.min(1, l[i])), b = Math.max(-1, Math.min(1, r[i]));
      out[2 * i] = a * 0x7fff; out[2 * i + 1] = b * 0x7fff;
      peakL = Math.max(peakL, Math.abs(a)); peakR = Math.max(peakR, Math.abs(b));
    }
    this.buf.push(out); this.frames += l.length;
    if (this.frames >= 1600) { // ~100 ms at 16 kHz
      const merged = new Int16Array(this.frames * 2);
      let o = 0; for (const c of this.buf) { merged.set(c, o); o += c.length; }
      this.port.postMessage({ pcm: merged.buffer, peakL, peakR }, [merged.buffer]);
      this.buf = []; this.frames = 0;
    }
    return true;
  }
}
registerProcessor('pcm-writer', PcmWriter);
`

export interface CaptureHandle {
  stop: () => void
  hasSystemAudio: boolean
}

export async function startCapture(onLevel: (me: number, them: number) => void): Promise<CaptureHandle> {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  })

  let system: MediaStream | null = null
  try {
    // The main process answers this with loopback (system) audio; no screen picker is shown.
    system = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    system.getVideoTracks().forEach((t) => t.stop())
    if (!system.getAudioTracks().length) system = null
  } catch (err) {
    console.warn('System audio unavailable, recording microphone only', err)
    system = null
  }

  const ctx = new AudioContext({ sampleRate: 16000 })
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)

  const merger = ctx.createChannelMerger(2)
  const micSrc = ctx.createMediaStreamSource(mic)
  const micMono = ctx.createGain()
  micMono.channelCount = 1
  micMono.channelCountMode = 'explicit'
  micMono.channelInterpretation = 'speakers'
  micSrc.connect(micMono).connect(merger, 0, 0)
  if (system) {
    const sysSrc = ctx.createMediaStreamSource(new MediaStream(system.getAudioTracks()))
    const sysMono = ctx.createGain()
    sysMono.channelCount = 1
    sysMono.channelCountMode = 'explicit'
    sysMono.channelInterpretation = 'speakers'
    sysSrc.connect(sysMono).connect(merger, 0, 1)
  }

  const writer = new AudioWorkletNode(ctx, 'pcm-writer', { numberOfInputs: 1, channelCount: 2, channelCountMode: 'explicit' })
  writer.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; peakL: number; peakR: number }>) => {
    window.mentat.sendAudio(e.data.pcm)
    onLevel(e.data.peakL, e.data.peakR)
  }
  merger.connect(writer)
  // Keep the graph pulling without playing anything back.
  const mute = ctx.createGain()
  mute.gain.value = 0
  writer.connect(mute).connect(ctx.destination)

  return {
    hasSystemAudio: !!system,
    stop: () => {
      mic.getTracks().forEach((t) => t.stop())
      system?.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}
