# Mentat

Botless AI meeting notes for macOS and Windows. Mentat captures your microphone and your computer's
audio locally (no bot joins the call), keeps a full, exportable transcript of every meeting, and uses
Claude to turn your rough notes plus the transcript into clean notes.

## Features

| Area | What Mentat does |
| --- | --- |
| Botless capture | Mic + system audio captured on-device (ScreenCaptureKit loopback on macOS 13+, WASAPI loopback on Windows). Mic = "Me", system audio = "Them", with diarization inside "Them". Works with Zoom, Meet, Teams, Slack huddles, phone-over-desktop, anything. |
| Full transcripts | Live transcript panel; every transcript saved as JSON + plain text in `~/Mentat/`. Export as `.md`, `.txt`, `.srt` or `.json`. Pause and resume continue the same timeline. |
| AI-enhanced notes | Your notes stay the backbone (dark text); Claude adds details from the transcript (grey text), plus summary and action items. Regenerate with any template. |
| Templates | 7 built-ins (General, 1:1, Customer discovery, Sales call, Stand-up, Interview, Investor pitch) plus your own. |
| Chat | Ask Claude about one meeting (full transcript in context) or across all meetings (Claude searches and opens meetings with tools). |
| Calendar | Google Calendar: upcoming meetings in the sidebar, attendees pulled in, a notification when a meeting starts that opens a note and starts recording. |
| Pre-meeting briefs | One click on an upcoming event: a brief from past meetings with the same people or topic. |
| Follow-up emails | Drafted from the meeting, opens in your mail app. |
| Google Drive | Auto-sync each enhanced note and its full transcript as Google Docs in a `Mentat` folder (`drive.file` scope only). |
| Sharing | Share a note as a view-only Google Doc link, optionally emailing attendees. |
| Folders and search | Folders, full-text search over notes and transcripts. |
| Dictionary | Custom vocabulary used to bias transcription and Claude's spelling. |
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
2. **Deepgram API key** for live speech-to-text (Nova-3, multichannel). Audio is streamed, never stored.
3. **Google OAuth client** (type "Desktop app", with Calendar API and Drive API enabled), then **Connect Google**.

On macOS, grant Microphone and Screen & System Audio Recording permission the first time you record.
If system audio is blocked, Mentat falls back to mic-only and says so in the dock.

### Using your meetings from Claude Desktop / Claude Code

Copy the config from Settings → "Use your meetings in Claude (MCP)", or for development:

```json
{ "mcpServers": { "mentat": { "command": "node", "args": ["/path/to/mentat/out/main/mcp-server.js"] } } }
```

## Layout

```
src/main/         Electron main: IPC, recording, Claude, Deepgram, Google (OAuth, Calendar, Drive)
src/preload/      Context-isolated bridge
src/renderer/     React UI and the audio capture worklet
src/shared/       Types, file store, templates, formatters (shared with the MCP server)
src/mcp/          Stdio MCP server
```

Data lives in `~/Mentat` (override with `MENTAT_DATA_DIR`): `meetings/<id>.json`, a Markdown mirror
`meetings/<id>.md`, and `transcripts/<id>.txt`.

## Known gaps / next steps

- Not yet tested on a real Mac/Windows machine: system audio capture depends on Electron's loopback
  support and OS permissions.
- Echo: without headphones the mic also hears the other side, so some "Them" speech can appear under "Me".
  Next: drop mic segments that duplicate a simultaneous system-audio segment.
- Local (offline) transcription with whisper.cpp as an alternative to Deepgram.
- Rich-text editor, Slack/Notion/HubSpot/Zapier integrations, team workspaces, Microsoft 365 calendar,
  code signing and auto-update.
