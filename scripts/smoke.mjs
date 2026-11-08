// Launch the built app with MENTAT_SMOKE_TEST=1 and fail if the UI does not load cleanly.
// Usage: node scripts/smoke.mjs [path-to-packaged-executable]   (defaults to the dev build in out/)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'

const exe = process.argv[2]
const cmd = exe ?? electron
const args = exe ? [] : ['.']
if (process.platform === 'linux') args.push('--no-sandbox')
const dir = mkdtempSync(join(tmpdir(), 'mentat-smoke-'))
const resultFile = join(dir, 'smoke-result.txt') // GUI apps on Windows may not write to a piped stdout
const env = { ...process.env, MENTAT_SMOKE_TEST: '1', MENTAT_DATA_DIR: join(dir, 'data'), MENTAT_SMOKE_RESULT: resultFile }
delete env.ELECTRON_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
const kill = setTimeout(() => child.kill('SIGKILL'), 90_000)
child.on('exit', (code) => {
  clearTimeout(kill)
  if (existsSync(resultFile)) out += '\n' + readFileSync(resultFile, 'utf8')
  const ok = code === 0 && out.includes('SMOKE OK')
  console.log(out.split('\n').filter((l) => /SMOKE|renderer|load failed|timed out|Error/i.test(l)).join('\n'))
  console.log(ok ? 'Smoke test passed' : `Smoke test failed (exit ${code})`)
  process.exit(ok ? 0 : 1)
})
