# Sync and shared workspaces

Both are optional and need a small server you host yourself. It stores only encrypted data: notes,
transcripts, names and keys are encrypted on your devices, so whoever runs the server can't read them.

## Run the server

```bash
# from the repository root
docker build -f sync-server/Dockerfile -t mentat-sync .
docker run -d --name mentat-sync -p 8787:8787 -v mentat-sync:/data \
  -e MENTAT_SIGNUP_CODE=pick-a-code \
  -e MENTAT_SERVER_SECRET=$(openssl rand -hex 32) \
  mentat-sync
```

Without Docker (Node 22.13+): `cd sync-server && npm install && npm run build && MENTAT_SIGNUP_CODE=pick-a-code npm start`.

Put it behind HTTPS at a stable URL (Caddy or nginx, or a host such as Fly.io, Render or Railway with a
persistent volume for `/data`). All options are in [sync-server/README.md](../sync-server/README.md).

## Create your profile

In the desktop app: Settings → **Cloud features** → **Create profile**, with the server URL, a username, a
password (10+ characters) and the signup code.

Your password is your encryption key. If you forget it, the synced copy can't be recovered, though your local
notes are fine. Once everyone has a profile, set `MENTAT_ALLOW_SIGNUPS=false` to close signups.

## Share a workspace

**If you own it:**

1. Settings → **Shared workspaces** → name it → **Create workspace**.
2. Open it and tick the folders to share. Everything in them is shared, including future meetings. To share a
   single meeting, use its ⋯ menu → *Share to …*.
3. Under *Invite someone*, choose **Viewer** or **Editor**, create an invite code and send it privately. Each code
   works once and expires after 7 days.

**If you're joining:**

1. Install Mentat and create a profile on the *same* server, with the signup code you were given.
2. Settings → **Shared workspaces** → paste the invite code → **Join**.
3. Shared meetings show up under **Workspaces** in the sidebar, and in your own Claude if you set up MCP.

**Managing access:** owners can change roles or remove people. Removing someone deletes the shared copies from
their computer on its next sync and changes the workspace key, so they can't read anything shared later.
Each member's key fingerprint is shown next to their name if you want to check who joined.

## How it's secured

Each profile has a key derived from its password, and the workspace key is sealed to each member's key. Invites
are checked by the owner's app before it shares keys, so the server can't slip in a key of its own. The server
enforces roles. Details are in `packages/sync-core/src/workspace.ts`.
