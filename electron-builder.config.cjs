// Packaging, code signing and auto-update publishing for the desktop app.
// Signing is driven entirely by environment variables (GitHub Actions secrets), so nothing secret lives in
// this public repo. Without them, builds are unsigned (fine for local testing, but macOS auto-update and
// Gatekeeper need a signed + notarized build).
const notarize = Boolean(process.env.APPLE_TEAM_ID && (process.env.APPLE_ID || process.env.APPLE_API_KEY))

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ai.mentat.desktop',
  productName: 'Mentat',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['out/**', 'package.json'],
  asarUnpack: ['**/*.node'],
  icon: 'build/icon.png',
  extraResources: [{ from: 'resources/icons', to: 'icons' }],
  publish: [{ provider: 'github', owner: 'kavin1001', repo: 'mentat', releaseType: 'release' }],
  mac: {
    category: 'public.app-category.productivity',
    // Helper that tells Mentat which apps are using the microphone (built by scripts/build-mic-monitor.mjs).
    extraResources: [{ from: 'resources/bin/mic-monitor', to: 'mic-monitor' }],
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] } // the zip is what auto-update downloads
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    extendInfo: {
      NSMicrophoneUsageDescription: 'Mentat transcribes your side of the conversation on this Mac.',
      NSAudioCaptureUsageDescription: 'Mentat transcribes the other side of the call from your computer audio, on this Mac.',
      NSScreenCaptureUsageDescription: 'macOS requires screen recording permission for Mentat to hear your computer audio. Mentat never records your screen.'
    }
  },
  dmg: { sign: false },
  win: {
    target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
    // Either a .pfx certificate (WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD) or Azure Trusted Signing (below).
    ...(process.env.AZURE_TRUSTED_SIGNING_ACCOUNT
      ? {
          azureSignOptions: {
            endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
            codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
            certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_PROFILE,
            publisherName: process.env.AZURE_TRUSTED_SIGNING_PUBLISHER
          }
        }
      : {})
  },
  nsis: { oneClick: true, perMachine: false },
  linux: { target: ['AppImage'], category: 'Office' }
}
