# Mentat sync server (optional)

Mentat needs no server and no account: by default everything stays on your computer, and a phone can
pair with your computer directly over your Wi-Fi. This relay is only for **cloud features**, so your
phone can sync with your computer from anywhere.

It is end-to-end encrypted. You create a profile (username + password) from the Mentat desktop or phone
app; the password is stretched with scrypt **on your device** and never sent. The server stores only:

- your username, a random salt, and a SHA-256 of a key derived from your password (to check sign-ins),
- for each note, folder and template, an opaque ID (an HMAC, not the meeting ID) and an
  XChaCha20-Poly1305 ciphertext.

So whoever runs the server can't read titles, notes or transcripts. The flip side: if you forget your
password, the synced copy can't be decrypted (the notes on your computer are unaffected; create a new
profile and they upload again).

## Run it

Node 22.13+ (uses the built-in `node:sqlite`, no native modules):

```bash
cd sync-server
npm install
npm run build
MENTAT_SIGNUP_CODE=pick-something PORT=8787 npm start
```

or with Docker, from the repository root:

```bash
docker build -f sync-server/Dockerfile -t mentat-sync .
docker run -d -p 8787:8787 -v mentat-sync:/data -e MENTAT_SIGNUP_CODE=pick-something -e MENTAT_SERVER_SECRET=$(openssl rand -hex 32) mentat-sync
```

Put it behind HTTPS (any reverse proxy, or a host such as Fly.io, Render or Railway with a persistent
volume for `/data`). Payloads are already encrypted, but HTTPS also protects your session token.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `MENTAT_SYNC_DB` | `./data/mentat-sync.db` | SQLite file |
| `MENTAT_SIGNUP_CODE` | unset | If set, creating a profile requires this code. Recommended on a public URL. |
| `MENTAT_ALLOW_SIGNUPS` | `true` | Set `false` after creating your profile to close signups entirely. |
| `MENTAT_SERVER_SECRET` | random per start | Keeps the fake salts returned for unknown usernames stable, so usernames can't be probed. |
| `MENTAT_SYNC_NAME` | `Mentat cloud` | Name shown in the apps |

## Protocol

See `packages/sync-core/src/protocol.ts`. The desktop app's local-network server speaks the same
`/v1/changes` API, so the phone uses one sync client for both. Conflicts resolve last-writer-wins per
note, except that the transcript always comes from the computer (it appends while recording and removes
echo), so a phone editing notes during a recording never drops or brings back transcript lines.

Shared workspaces add the routes in `packages/sync-core/src/workspace-protocol.ts`. The relay stores the
workspace name, every member's key bundle and every record as ciphertext, and enforces membership, roles
(owner, editor, viewer), single-use expiring invites (only a hash of the redeem token is stored), record
authorship and the current key epoch.

## Tests

```bash
npm install            # at the repository root first (the tests run the desktop's real sync code)
cd sync-server && npm install && npm test
```

The end-to-end tests cover: phone <-> desktop over local pairing (pull, edit, create, delete, conflicts,
transcript merge, replay of a captured request), desktop <-> relay <-> phone (signup code, wrong password,
no plaintext in the relay database, sign-out, profile deletion), and phone edits forwarded from the local
network to the cloud.
