import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Standalone MCP server (stdio) that Claude Desktop / Claude Code can launch.
          'mcp-server': resolve(__dirname, 'src/mcp/server.ts')
        }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    // Pre-bundle the speech model runtime so Vite does not reload the window the first time the worker starts.
    optimizeDeps: { include: ['@huggingface/transformers'] },
    // Same cross-origin isolation as the app:// handler, so ONNX Runtime can use threads in dev too.
    server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' } },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})
