// Builds Mentat for this Mac and installs it into /Applications, replacing any older copy.
// Usage: npm run install:mac [-- --no-open]
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

if (process.platform !== 'darwin') {
  console.error('install:mac only runs on macOS. On Windows use: npm run dist:win')
  process.exit(1)
}
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

run('npm run build')
run(`npx electron-builder --mac dir --${arch} --config electron-builder.config.cjs`)

const built = `dist/${arch === 'arm64' ? 'mac-arm64' : 'mac'}/Mentat.app`
const target = '/Applications/Mentat.app'
if (!existsSync(built)) throw new Error(`Build output not found: ${built}`)

// Quit a running copy so it can be replaced.
try {
  execFileSync('osascript', ['-e', 'if application "Mentat" is running then tell application "Mentat" to quit'])
} catch {
  /* not running */
}
rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [built, target])
// Finder metadata and quarantine flags on the copy would make codesign refuse it.
execFileSync('xattr', ['-cr', target])

// Builds without a Developer ID certificate still need a local (ad-hoc) signature to run on Apple silicon.
try {
  execFileSync('codesign', ['--verify', '--deep', target], { stdio: 'ignore' })
} catch {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' })
}
console.log(`Installed ${target}`)
if (!process.argv.includes('--no-open')) execFileSync('open', [target])
