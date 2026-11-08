# Mentat for iPhone and Android

The phone companion to the Mentat desktop app. Read every meeting from your computer (your notes,
Claude's enhanced notes, the full transcript), search across them, edit notes, and jot quick notes that
sync back to the computer.

## No account needed

Mentat is local-first. The phone has three modes, and you never need a password unless you choose cloud:

| Mode | How | Account? |
| --- | --- | --- |
| This phone only | Default. Notes you write stay on the phone. | No |
| Paired with your computer | Desktop: Settings → Phone on this network → Pair a phone. Phone: Connect → Scan pairing code. Syncs over your Wi-Fi while Mentat is open on the computer. | No |
| Cloud profile (optional) | Create or sign in to a password-protected profile on a Mentat sync server (`../sync-server`). Syncs from anywhere. | Yes, username + password |

Sync is end-to-end encrypted in both synced modes: with a key from the pairing code, or with a key
derived from your cloud password on the device (scrypt). Neither the desktop's network listener nor the
cloud server accepts anything without that key, and the cloud server can't read your notes.

## Run it

```bash
npm install
npx expo run:ios        # or: npx expo run:android   (development build; needs Xcode / Android Studio)
# or build in the cloud: npx eas-cli@latest build --profile development
```

The camera (QR scanning) and secure storage are native modules, so use a development build rather than
Expo Go. `npm run web` runs a browser version, useful for UI work; pair it by pasting the pairing code.

## Layout

```
src/app/            Screens (Expo Router): notes list, meeting, connect, scan, settings
src/lib/sync.tsx    Sync state: on-device store, current connection, auto sync
src/lib/storage.ts  One JSON file per record in the app's documents folder (storage.web.ts for web)
src/lib/connection.ts  Pairing code parsing; secrets kept in the iOS Keychain / Android Keystore
```

The phone uses the desktop's data types and transcript formatters from `../src/shared` and the sync
client from `../packages/sync-core` (see `metro.config.js`).

## Not built yet

- Recording on the phone (in-person meetings) with on-device transcription.
- Finding the computer automatically when its Wi-Fi address changes (today the phone tries every address
  in the pairing code; pair again if all changed).
- Editing Claude's enhanced notes, folders and templates on the phone (they're read-only there for now).
