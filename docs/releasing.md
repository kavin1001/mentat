# Releasing, signing and auto-update

## Make a release

1. Bump `version` in `package.json` (for example to `0.2.0`) and merge it.
2. Tag it: `git tag v0.2.0 && git push origin v0.2.0`.

The **Release** workflow builds the Mac (`.dmg`, `.zip`) and Windows (`.exe`) installers, signs them when the
secrets below are set, and publishes them to GitHub Releases. Installed copies check for updates a few seconds
after launch and every four hours, download in the background and install when you quit (or from
Settings → **Updates** → *Restart to update*).

Without signing secrets the workflow still builds, but macOS won't open the app without a right-click → Open,
macOS auto-update won't work, and Windows shows a SmartScreen warning.

## Secrets to add

Add these in the repository's **Settings → Secrets and variables → Actions**. Nothing secret goes in the repo.

### macOS (needs an Apple Developer account, $99/year)

| Secret | What it is |
| --- | --- |
| `MAC_CERT_P12_BASE64` | Your **Developer ID Application** certificate exported from Keychain as `.p12`, then `base64 -i cert.p12` |
| `MAC_CERT_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | Made at [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | The 10-character Team ID from [developer.apple.com/account](https://developer.apple.com/account) |

### Windows (pick one)

**A certificate file** from a certificate authority:

| Secret | What it is |
| --- | --- |
| `WIN_CERT_PFX_BASE64` | The `.pfx` file, base64-encoded |
| `WIN_CERT_PASSWORD` | Its password |

**Or Azure Trusted Signing** (usually cheaper, no hardware token):

`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_TRUSTED_SIGNING_PROFILE`,
`AZURE_TRUSTED_SIGNING_PUBLISHER`, plus a service principal: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`.

## Building locally

`npm run dist:mac` or `npm run dist:win` builds an unsigned installer in `dist/`. Set the same variables in your
shell to sign locally. `npm run dist:dir` builds an unpacked app, which is quicker for testing.
