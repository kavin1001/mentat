# Google Drive: the one-click "Connect Google Drive" button

Mentat ships its own Google OAuth client, so people connect Google with one click: no Cloud Console, no
pasting IDs. The client is injected when the app is built and is never committed to this public repo.

What Mentat asks Google for:

| Scope | Why |
| --- | --- |
| `https://www.googleapis.com/auth/drive` | Read and write Drive: save notes and transcripts, file them into folders you already have, and let Claude search and read your Drive files when you ask a question. |
| `https://www.googleapis.com/auth/calendar.readonly` | Name notes after the meeting and remind you when one starts. |
| `openid`, `email` | Show which account is connected. |

Sign-in is the desktop loopback flow with PKCE: Mentat opens your browser, Google redirects to
`http://127.0.0.1:<random port>/callback`, and the tokens are stored encrypted with the OS keychain.

## One-time setup (the maintainer does this once)

1. **Create a project** at <https://console.cloud.google.com/projectcreate>, for example "Mentat".
2. **Turn on the APIs**: [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   and [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com).
3. **Set up the consent screen** at <https://console.cloud.google.com/auth/overview> (Google Auth Platform):
   - App name **Mentat**, your support email, audience **External**.
   - Under **Data access**, add the scopes `.../auth/drive` and `.../auth/calendar.readonly`.
   - Under **Audience**, click **Publish app** so the status is **In production**. Do this even before
     verification: in *Testing* mode Google expires the sign-in after 7 days and you would have to reconnect
     every week.
4. **Create the client** at <https://console.cloud.google.com/auth/clients>: **Create client**, type
   **Desktop app**, name "Mentat desktop". Copy the client ID and client secret.
5. **Give the build the client**:
   - Local builds (`npm run dev`, `npm run install:mac`): copy `.env.example` to `.env.local` in the repo and
     fill in `MAIN_VITE_GOOGLE_CLIENT_ID` and `MAIN_VITE_GOOGLE_CLIENT_SECRET`. `.env.local` is git-ignored.
   - Released builds: add repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
     (Settings → Secrets and variables → Actions). `release.yml` passes them to the build.

Google's docs say a desktop app's "client secret" can't be kept secret (it is inside every copy of the app)
and PKCE is what protects the sign-in. We still keep it out of the repo so it can't be scraped.

## "Google hasn't verified this app"

Full Drive access is a **restricted** scope. Until Google verifies the app, everyone who connects sees a
warning screen and has to click **Advanced → Go to Mentat (unsafe)**. Mentat's settings explain this step.
An unverified app in production also has a lifetime cap of **100 users**.

That is fine for you and a small team. To remove the warning for everyone, submit the app for verification
from the consent screen page. For restricted Drive scopes Google needs:

- A verified domain with a homepage and a privacy policy that describes the Drive data use.
- A short video showing the sign-in and how Mentat uses Drive.
- A yearly third-party security assessment (CASA). This is the slow and costly part (weeks, and usually a
  fee to the assessor).

If that is not worth it, the alternative is to go back to `drive.file` (Mentat sees only files it creates or
that you pick with Google's file picker). That scope needs no security assessment and shows no warning, but
Claude could no longer read the rest of your Drive.

## Using your own client instead

Anyone building Mentat without the built-in client can paste their own Desktop-app client under
**Settings → Google Drive and Calendar → Advanced**. That overrides the built-in one.

## Reconnecting after the upgrade

People who connected before this change gave Mentat only `drive.file` access. Settings shows a
**Reconnect** link that asks Google again with full Drive access.

## Where notes go, and when

- **Folder:** Settings → Google Drive and Calendar → **Choose folder…** picks any folder in My Drive, Shared with me or a shared drive (or makes a
  new one). Without a choice, Mentat creates `Mentat` at the top of My Drive.
- **Filing:** with "Let Claude file each note" on, Claude reads the folders already inside that folder and puts
  each note in the best fit, e.g. `Customers / Acme Corp`, creating a sub-folder only when nothing fits.
  Your filing rules take priority. This needs an Anthropic API key; without one, notes go in the top folder.
- **When:** you decide. Each note has a **Save to Drive** button in its bottom bar (one Google Doc: the notes, then a page break, then
  the full transcript); after the first save it becomes **Update in Drive** and rewrites the same Docs. Recording
  has **Pause** (resume later) and **End** (the meeting is over; a detected call hanging up also ends it).
  After End, the Save to Drive button is highlighted. Settings has an off-by-default option to upload on
  its own when a meeting ends and after Enhance.
- **Delete:** deleting a note in Mentat moves its Doc to the Drive trash, where they can be restored for
  30 days. Turn this off in Settings to keep Drive copies.
