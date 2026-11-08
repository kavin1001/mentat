// Builds the macOS mic-monitor helper (a universal binary) into resources/bin/. No-op on other platforms.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

if (process.platform !== 'darwin') process.exit(0)
const src = 'native/mic-monitor/main.swift'
const outDir = 'resources/bin'
mkdirSync(outDir, { recursive: true })
const tmp = join(tmpdir(), `mic-monitor-${process.pid}`)
mkdirSync(tmp, { recursive: true })
try {
  const parts = ['arm64', 'x86_64'].map((arch) => {
    const out = join(tmp, arch)
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos13.0`, '-o', out, src], { stdio: 'inherit' })
    return out
  })
  execFileSync('lipo', ['-create', '-output', join(outDir, 'mic-monitor'), ...parts], { stdio: 'inherit' })
  console.log('built', join(outDir, 'mic-monitor'))
} catch (e) {
  // Without Xcode command line tools the app still runs; it just can't notice calls by itself.
  console.warn('Could not build mic-monitor (install Xcode command line tools: xcode-select --install).', e.message)
  if (process.env.CI) process.exit(1)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
