# Mentat

Botless AI meeting notes for macOS and Windows. Mentat captures your microphone and your computer's
audio locally (no bot joins the call), transcribes it on-device with an open-source speech model, keeps
a full, exportable transcript of every meeting, uses Claude to turn your rough notes plus the transcript
into clean notes, and files every note into the right folder in Google Drive.

## Features

| Area | What Mentat does |
| --- | --- |
| Botless capture | Mic + system audio captured on-device (ScreenCaptureKit loopback on macOS 13+, WASAPI loopback on Windows). Mic = "Me", system audio = "Them". Works with Zoom, Meet, Teams, Slack huddles, anything that plays through the computer. |
| On-device transcription | Whisper (large-v3 turbo, small, base) or Moonshine, run locally with transformers.js on WebGPU (WASM fallback). Audio never leaves the computer. The model downloads once from Hugging Face, then works offline. Echo from speakers is removed from the "Me" channel. |
| Full transcripts | Live transcript panel; every transcript saved as JSON + plain text in `~/Mentat/`. Export as `.md`, `.txt`, `.srt` or `.json`. Pause and resume continue the same timeline. |
| AI-enhanced notes | Your notes stay the backbone (dark text); Claude adds details from the transcript (grey text), plus summary and action items. Regenerate with any template. |
| Templates | 7 built-ins (General, 1:1, Customer discovery, Sales call, Stand-up, Interview, Investor pitch) plus your own. |
| Chat | Ask Claude about one meeting (full transcript in context) or across all meetings (Claude searches and opens meetings with tools). |
| Calendar | Google Calendar: upcoming meetings in the sidebar, attendees pulled in, a notification when a meeting starts that opens a note and starts recording. |
| Pre-meeting briefs | One click on an upcoming event: a brief from past meetings with the same people or topic. |
| Follow-up emails | Drafted from the meeting, opens in your mail app. |
| Google Drive | Every enhanced note and its full transcript are pushed as Google Docs. Claude auto-classifies each note into a sub-folder (e.g. `Mentat/Customers/Acme Corp`, `Mentat/Hiring/Backend Engineer`), reusing existing folders and following your own filing rules. Re-file any note from its menu. Uses the narrow `drive.file` scope. |
| Sharing | Share a note as a view-only Google Doc link, optionally emailing attendees. |
| Folders and search | Folders, full-text search over notes and transcripts. |
| Dictionary | Names and jargon Claude spells exactly in notes. |
| Claude via MCP | `out/main/mcp-server.js` is a stdio MCP server (list, search, get meeting, get transcript, update notes). Settings shows a ready-to-paste Claude Desktop config. |
| Models | Claude Opus 5.5 by default; Sonnet 5.5 or Haiku 5.5 selectable. Refusal fallback enabled. |

## Setup

```bash
npm install
npm run dev          # run the app with hot reload
npm run dist:mac     # build a .dmg (or dist:win)
```

In **Settings** add:

1. **Anthropic API key** for notes, chat, briefs and emails.
2. **Speech model**: pick one (Whisper small is the default). It downloads the first time you record.
3. **Google OAuth client** (type "Desktop app", with Calendar API and Drive API enabled), then **Connect Google**.

On macOS, grant Microphone and Screen & System Audio Recording permission the first time you record.
If system audio is blocked, Mentat falls back to mic-only and says so in the dock.

### Using your meetings from Claude Desktop / Claude Code

Copy the config from Settings → "Use your meetings in Claude (MCP)", or for development:

```json
{ "mcpServers": { "mentat": { "command": "node", "args": ["/path/to/mentat/out/main/mcp-server.js"] } } }
```

## Phone app and sync

Mentat works with no account and no server. Two optional ways to use it on your phone:

- **Phone on this network** (no password): Settings → Phone on this network → Pair a phone, then scan
  the code with the Mentat phone app (`mobile/`). The phone syncs directly with this computer over Wi-Fi.
- **Cloud features** (password-gated): create a profile on a Mentat sync server (`sync-server/`, self-hostable)
  to sync from anywhere. Notes are end-to-end encrypted with a key derived from your password on your devices.

Both use the same protocol (`packages/sync-core`). Sync state is kept in `~/Mentat/.sync/`; secrets are stored
in the OS keychain. See `mobile/README.md` and `sync-server/README.md`.

## Layout

```
src/main/         Electron main: IPC, storage, Claude (notes, chat, Drive filing), Google (OAuth, Calendar, Drive)
src/preload/      Context-isolated bridge
src/renderer/     React UI, audio capture worklet, on-device speech-to-text worker
src/shared/       Types, file store, templates, formatters (shared with the MCP server)
src/mcp/          Stdio MCP server
src/main/sync/    Optional sync: change index, local pairing server, cloud client
packages/sync-core/  Sync protocol and end-to-end encryption (shared with the phone and server)
mobile/           Phone companion (Expo / React Native)
sync-server/      Optional, self-hostable cloud relay
```

Data lives in `~/Mentat` (override with `MENTAT_DATA_DIR`): `meetings/<id>.json`, a Markdown mirror
`meetings/<id>.md`, and `transcripts/<id>.txt`.

## Known gaps / next steps

- Not yet tested on a real Mac/Windows machine: system audio capture depends on Electron's loopback
  support and OS permissions.
- No speaker diarization inside "Them" yet (everyone on the call is "Them").
- Live text appears per utterance (after each pause), not word by word.
- Rich-text editor, code signing and auto-update.
