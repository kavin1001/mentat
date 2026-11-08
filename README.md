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
| Claude via MCP | `out/main/mcp-server.js` is a stdio MCP server (list, search, get meeting, get transcript, list workspaces, update notes), covering your own meetings and those shared with you. Settings shows a ready-to-paste Claude Desktop config. |
| Models | Claude Opus 5.5 by default; Sonnet 5.5 or Haiku 5.5 selectable. Refusal fallback enabled. |

## Install

Only steps 1 and 2 are required. With just those, Mentat runs entirely on your
computer: no account, no server.

### 1. Desktop app (macOS 13+ or Windows 10+)

You need [Node.js 22](https://nodejs.org) or newer and git. There are no signed installers yet, so build it
from source:

```bash
git clone https://github.com/kavin1001/mentat.git
cd mentat
npm install
npm run dev          # run the app (with hot reload)
npm run dist:mac     # or: npm run dist:win, to build an installer you can keep in Applications
```

On macOS, grant **Microphone** and **Screen & System Audio Recording** the first time you record (System
Settings → Privacy & Security). Without screen recording, Mentat records your mic only and says so.

### 2. Claude and on-device transcription

Open **Settings** in the app:

1. **Claude**: paste an [Anthropic API key](https://console.anthropic.com). It's used for enhanced notes, chat,
   briefs, follow-up emails and Drive filing. Transcription never uses it.
2. **Transcription (on this computer)**: pick a speech model. *Whisper small* is the default; *Whisper large-v3
   turbo* is more accurate on a fast GPU, *Whisper base* and *Moonshine base* (English only) are lighter. The
   model downloads once from Hugging Face the first time you record (about 80 MB to 800 MB), then works offline.
   It runs on your GPU through WebGPU when available, otherwise on the CPU. Audio never leaves your computer.

### 3. Google Calendar and Drive (optional)

In Google Cloud Console, create an OAuth client of type **Desktop app** and enable the Calendar API and Drive
API. Paste its client ID and secret into Settings → **Google Drive and Calendar**, then click **Connect Google**.
Mentat asks only for read access to your calendar and for the Drive files it creates.

### 4. Your meetings in Claude Desktop or Claude Code (optional)

Settings → **Use your meetings in Claude (MCP)** shows a config to paste into Claude Desktop. In development:

```json
{ "mcpServers": { "mentat": { "command": "node", "args": ["/path/to/mentat/out/main/mcp-server.js"] } } }
```

Run `npm run build` once first so `out/main/mcp-server.js` exists. Claude can then list, search and read every
meeting you can access, including ones teammates share with you (see Shared workspaces below).

### 5. Phone app (optional)

The phone companion lives in `mobile/` (Expo). There's no App Store build yet, so install a development build:

```bash
cd mobile
npm install
npx expo run:ios        # or: npx expo run:android  (needs Xcode or Android Studio)
```

Then either pair it over Wi-Fi with no account (desktop: Settings → **Phone on this network** → Pair a phone;
phone: Connect → Scan pairing code), or sign both in to the same cloud profile. See `mobile/README.md`.

## Backend: the sync server (optional)

Mentat has no hosted backend. Cloud sync (phone from anywhere) and shared workspaces use a small relay you host
yourself, in `sync-server/`. It's one Node process with a SQLite file. It stores only ciphertext: notes,
transcripts, names and workspace keys are encrypted on your devices, so whoever runs it can't read them.

```bash
# from the repository root
docker build -f sync-server/Dockerfile -t mentat-sync .
docker run -d --name mentat-sync -p 8787:8787 -v mentat-sync:/data \
  -e MENTAT_SIGNUP_CODE=pick-a-code \
  -e MENTAT_SERVER_SECRET=$(openssl rand -hex 32) \
  mentat-sync
```

Or without Docker (Node 22.13+): `cd sync-server && npm install && npm run build && MENTAT_SIGNUP_CODE=pick-a-code npm start`.

Then:

1. Put it behind **HTTPS** at a stable URL: a reverse proxy (Caddy, nginx) on your own machine, or a host with a
   persistent volume for `/data` (Fly.io, Render, Railway).
2. In the desktop app: Settings → **Cloud features** → Create profile, with that URL, a username, a password
   (10+ characters) and the signup code. Your password is your encryption key: if you forget it, the synced copy
   can't be recovered (your local notes are fine).
3. Give teammates the URL and signup code so they can create their own profiles. Once everyone has one, you can
   set `MENTAT_ALLOW_SIGNUPS=false` to close signups.

All settings, the protocol and the tests are in `sync-server/README.md`.

## Shared workspaces (teams)

Other people can join your workspace to read the meetings you share to it, including enhanced notes and full
transcripts, in Mentat and through their own Claude. It's opt-in and needs the sync server above.

**Owner (you):**

1. Settings → **Shared workspaces** → type a name → **Create workspace**.
2. Click the workspace to open it. Under *What you share here*, tick the folders to share (every meeting in them,
   including future ones, is shared). To share one meeting, use its ⋯ menu → *Share to …*.
3. Under *Invite someone*, pick **Viewer** (can read) or **Editor** (can read and share their own meetings), then
   **Create invite code** and send the `mentat-invite:…` code privately (DM, not a public channel). Each code
   works once and expires after 7 days; make one per person.

**Teammate joining:**

1. Install the desktop app (steps 1 and 2 above).
2. Settings → **Cloud features** → **Create profile** on *the same sync server URL* as the owner, with the
   signup code they gave you.
3. Settings → **Shared workspaces** → paste the invite code → **Join**.
4. Shared meetings appear in the sidebar under **Workspaces** (read-only). If they set up the MCP server
   (step 4 above), their Claude can also search and read every meeting they have access to.

**Managing access:** the owner can change roles or **Remove** someone in the workspace's member list. Removing
someone ends their access, deletes the shared copies from their computer on its next sync, and replaces the
workspace key so they can't read anything shared later. Members can **Leave**; the owner can **Delete** the
workspace for everyone. Each member's key fingerprint is shown next to their name, so you can compare it with
the one in their Settings if you want to be sure who joined.

How it's secured: each profile has an X25519 key derived from its password, and the workspace key is sealed to
each member's key. An invite binds the joiner's key with a MAC only the invite holder can make, and the owner's
app checks it before sharing new keys, so the sync server can't slip in a key of its own. The server enforces
roles (viewers can't write, members can only change what they shared). Details in
`packages/sync-core/src/workspace.ts`.

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
