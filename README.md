# Mentat

AI meeting notes for macOS and Windows, with no bot in the call.

Mentat listens to your microphone and your computer's audio, writes a full transcript on your own
computer, and uses Claude to turn your rough notes into clean ones. Notes are filed into the right
Google Drive folder automatically.

## What it does

- **Notices your calls.** When Zoom, Google Meet, Teams, Slack, FaceTime or similar start using your mic, a small
  prompt offers to take notes. Recording stops by itself when the call ends. Nobody else sees a bot.
- **Lives in your menu bar** (or the Windows tray) and opens at login, so it's ready before your first call.
- **Transcribes on your computer** with an open-source Whisper model. Audio never leaves your machine.
  Text appears live as people talk, and different voices on the call are told apart as Speaker 1, 2, 3
  (click a name to rename it).
- **Keeps every transcript**, searchable and exportable as Markdown, text, subtitles or JSON.
- **Writes your notes up** with Claude. Your own notes stay in black; what Claude adds from the transcript is grey.
  Pick from templates (1:1, sales call, interview and more) or make your own.
- **Answers questions** about one meeting or all of them.
- **Files notes in Google Drive.** Claude picks or creates a folder such as `Customers / Acme Corp`.
- **Works with your calendar**: reminders when a meeting starts, briefs before it, follow-up emails after.
- **Plugs into Claude Desktop** through MCP, so Claude can search your meetings.
- **Optional extras**: a phone app, and shared workspaces for teams.

## Get started

You need [Node.js 22+](https://nodejs.org), and on a Mac the Xcode command line tools (`xcode-select --install`).

```bash
git clone https://github.com/kavin1001/mentat.git
cd mentat
npm install
npm run dev
```

Then, in **Settings**:

1. Paste an [Anthropic API key](https://console.anthropic.com) (used for notes and chat, never for transcription).
2. Pick a speech model. It downloads once, then works offline.
3. Optional: click **Connect Google Drive**. Mentat can then save notes to Drive, read your Drive files when you
   ask Claude something, and see your calendar. The button needs Mentat's Google sign-in client built in; for
   your own builds, see [docs/google-drive.md](docs/google-drive.md).

On a Mac, allow **Microphone** and **Screen & System Audio Recording** the first time you record. Mentat needs
the second one to hear the other people on the call; it never records your screen.

To install it as a normal app on your Mac, run `npm run install:mac`. It builds Mentat, puts it in
**Applications** and opens it. Run it again to update. On Windows, `npm run dist:win` builds an installer in `dist/`.

## Use your meetings in Claude

Settings → **Use your meetings in Claude** shows a config to paste into Claude Desktop. Claude can then list,
search and read your meetings and transcripts.

## Phone and teams (optional)

- **Phone app**: in `mobile/`. Pair over Wi-Fi with no account. See [mobile/README.md](mobile/README.md).
- **Sync and shared workspaces**: run the small self-hosted server in `sync-server/`. It only ever sees encrypted
  data. See [docs/sharing.md](docs/sharing.md).

## Releases and updates

Installed copies update themselves from GitHub Releases. Pushing a `v*` tag builds signed installers.
See [docs/releasing.md](docs/releasing.md) for the certificates it needs.

## Development

```bash
npm run typecheck && npm test   # types and unit tests
npm run smoke                   # launches the built app and checks it starts cleanly
```

CI runs these on every pull request, and also packages and launches the app on real macOS and Windows machines.

| Folder | What's in it |
| --- | --- |
| `src/main` | Electron main process: storage, Claude, Google, updates |
| `src/renderer` | The UI, audio capture and the on-device speech model |
| `src/shared` | Types, storage and formatting shared with the MCP server |
| `src/mcp` | The MCP server for Claude |
| `mobile`, `sync-server`, `packages/sync-core` | Phone app, sync server and the shared encryption code |

Your data lives in `~/Mentat` as JSON, Markdown and plain-text files.

## Limits to know about

- Call detection needs macOS 14 or newer (or Windows 10+). It sees *which app* is using the mic, so a browser
  using the mic for something other than a call can also trigger the prompt; just pick *Not now*.
- Telling voices apart works best when people talk for a second or more at a time. People with similar voices
  can end up with the same label, and one person can occasionally get two. Give both labels the same name to merge them.
- Live text is redrawn about twice a second while someone speaks, then replaced by the final line when they pause.
