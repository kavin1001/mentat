// Copies the ONNX Runtime WASM files into the renderer's public folder so local
// transcription never fetches runtime code from a CDN.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const src = 'node_modules/onnxruntime-web/dist'
const dst = 'src/renderer/public/ort'
// onnxruntime-web 1.22+ runs both WebGPU and WASM on the "asyncify" build (the one transformers.js v4
// loads by default); the older "jsep" glue fails with "webgpuInit is not a function".
const want = /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/
rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
const files = readdirSync(src).filter((f) => want.test(f))
if (files.length !== 2) throw new Error(`expected 2 ONNX Runtime asyncify files in ${src}, found ${files.length}`)
for (const f of files) copyFileSync(join(src, f), join(dst, f))
console.log('copied ONNX Runtime wasm to', dst)
