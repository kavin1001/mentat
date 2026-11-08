// Copies the ONNX Runtime WASM files into the renderer's public folder so local
// transcription never fetches runtime code from a CDN.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const src = 'node_modules/onnxruntime-web/dist'
const dst = 'src/renderer/public/ort'
mkdirSync(dst, { recursive: true })
for (const f of readdirSync(src)) if (/^ort-wasm-simd-threaded\.jsep\.(mjs|wasm)$/.test(f)) copyFileSync(join(src, f), join(dst, f))
console.log('copied ONNX Runtime wasm to', dst)
