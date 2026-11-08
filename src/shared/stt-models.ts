// On-device speech-to-text models (ONNX, run with transformers.js on WebGPU, or WASM as fallback).
// Weights are downloaded once from the Hugging Face Hub on first use and cached locally;
// after that, transcription runs fully offline.
export interface SttModel {
  id: string
  label: string
  sizeMb: number
  multilingual: boolean
  dtype: Record<string, string>
}

export const STT_MODELS: SttModel[] = [
  {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper large-v3 turbo (most accurate, needs a fast GPU)',
    sizeMb: 900,
    multilingual: true,
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }
  },
  {
    id: 'onnx-community/whisper-small',
    label: 'Whisper small (balanced, recommended)',
    sizeMb: 300,
    multilingual: true,
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Whisper base (fast, lower accuracy)',
    sizeMb: 120,
    multilingual: true,
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
  },
  {
    id: 'onnx-community/moonshine-base-ONNX',
    label: 'Moonshine base (fastest, English only)',
    sizeMb: 110,
    multilingual: false,
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }
  }
]

export const DEFAULT_STT_MODEL = 'onnx-community/whisper-small'

/** Speaker-embedding model used to tell apart the people on the "them" channel (runs on CPU, ~100 MB). */
export const DIARIZATION_MODEL = { id: 'Xenova/wavlm-base-plus-sv', sizeMb: 100 }
