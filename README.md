# Event QR Code Tracker (Google Apps Script + Google Sheets)

> ## ⚠️ Never change the web app URL
> The deployment's `/exec` URL is printed into every QR code. **When you update the script, always use
> Deploy → Manage deployments → ✏️ Edit → Version: _New version_ → Deploy on the *existing* deployment.**
> Choosing **Deploy → New deployment** creates a *new* URL and breaks every code you've already printed.
> (From the command line, `clasp update-deployment <deploymentId>` is safe. `clasp deploy` is not, because it creates a new deployment.)
>
> The same goes for the **Worker address** (`https://event-qr.<subdomain>.workers.dev`), which is printed in every new code.
> Don't rename the Worker (`name` in `worker/wrangler.toml`) or change your Cloudflare account's workers.dev subdomain.

## Your installation's settings

Everything specific to one installation stays out of git. Each private file has a `.example` next to it:

| File (private) | Holds |
|---|---|
| `apps-script/Config.gs` | `WEB_APP_URL`, `LINK_BASE_URL` (Worker address), `WORKER_KEY` |
| `apps-script/appsscript.json` | the manifest, including your `timeZone` |
| `.clasp.json` | your script ID |
| `worker/wrangler.toml` | Worker name, Apps Script URL, `WORKER_KEY` |
| `.env` | `LINK_BASE_URL`, `WEB_APP_URL` for `generate_qr.py` |

To ship an Apps Script change: `clasp push --force`, then `clasp update-deployment <deploymentId>`.
To ship a Worker change: `npx wrangler deploy --config worker/wrangler.toml`.
(In PowerShell, type `clasp.cmd` / `npx.cmd` if the plain command isn't found.)

## Overview

Each offline event (Event A, B, C, …) gets its own QR code. Every code can point to the same website, and
every scan is counted per event. A free Cloudflare Worker does the instant redirect. A Google Apps Script web app
bound to a Google Sheet does the logging, and the Sheet is the database and the dashboard.

```
QR code ──► https://event-qr.<subdomain>.workers.dev/event-a        (Cloudflare Worker)
              │ 1. look up "event-a" in its copy of Campaigns (refreshed from the Sheet every minute)
              │ 2. 302 redirect straight to destination_url (no page, no tap; ~0.1 s when warm)
              └ 3. in the background: Apps Script ?api=log → append [timestamp, slug, event name, source] to Scans

Older codes ──► https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?e=event-a   (still work)
              "Thanks for scanning!" page → visitor taps Continue to site (logged when the page opens)
```

If the Worker can't reach Google, it sends visitors to the old tap page, which logs the scan itself, so nobody gets stuck.
Chat-app link previews (WhatsApp, Slack, Messenger…) are redirected but **not** counted. The first visit after the Worker
has been idle can take 2–4 s while it fetches the Campaigns list. Later visits are instant.

## Project layout

```
apps-script/
  Code.gs            doGet redirect + logging, setup(), dashboard, menu, runTests()
  QrExport.gs        QR Tracker → Generate QR codes (PNGs to Drive + previews in Campaigns)
  QrCode.gs          built-in QR encoder + PNG writer (no outside services)
  WorkerApi.gs       ?api=campaigns / ?api=log endpoints for the Worker (need WORKER_KEY)
  Config.gs          your WEB_APP_URL, LINK_BASE_URL, WORKER_KEY (private, gitignored; see Config.gs.example)
  Redirect.html      "Thanks for scanning!" page with the Continue to site button (older codes / fallback)
  appsscript.json    V8, web app: execute as me, access anyone, your time zone (private; see appsscript.json.example)
worker/
  src/index.js       Cloudflare Worker: instant redirect + background logging
  wrangler.toml      Worker name, Apps Script URL, WORKER_KEY (private, gitignored; see wrangler.example.toml)
generate_qr.py       backup: makes qr_codes/<slug>.png on your PC from a CSV export (same links)
campaigns.csv        sample Campaigns export (replace with your own export)
requirements.txt     qrcode[pil], python-dotenv
.env.example         LINK_BASE_URL=, WEB_APP_URL=
.clasp.json.example  copy to .clasp.json and fill in your script ID
```

## Sheet structure

| Tab | Columns | Who edits |
|-----|---------|-----------|
| **Campaigns** | `slug` · `name` · `source` · `destination_url` · `active` (checkbox), plus `qr_code` · `qr_file` · `tracker_link` | You, by hand (`qr_code`/`qr_file` are filled in by Generate QR codes; `tracker_link` is a formula) |
| **Scans** | `timestamp` · `slug` · `event_name` · `source` | The script only (tab is protected with a warning) |
| **Dashboard** | Per-campaign totals with source and first/last scan, scans per day per campaign, bar chart, optional start/end date in B3/B4 | Formulas only |
| **Sources** | Scans per source, scans per event name × source, pie chart (uses the Dashboard's dates) | Formulas only |

### Campaign sources (offline, email, social, …)
Give each channel of an event **its own row** with its own slug, the **same `name`**, and a `source`:

| slug | name | source |
|------|------|--------|
| `event_movie` | Event Movie | offline (the printed QR code) |
| `event_movie_email` | Event Movie | email |
| `event_movie_social` | Event Movie | social |

Share each row's `tracker_link` in its channel. Every visit is logged with that row's source. The **Sources** tab adds up
an event's rows by `name`, while the Dashboard keeps each row separate. The `source` dropdown suggests offline, email and
social, but you can type your own label (for example `newsletter`). Blank means `offline`, and a label with characters
other than a-z, 0-9, `-` and `_` is logged as `other`. Changing a row's source only affects future scans; past scans keep
the source they were logged with.

- Slugs: lowercase letters, numbers, hyphens and underscores only (for example `spring-expo-2026` or `event_movie`).
  The slug is what's printed in the code, so **don't rename a slug after printing**. Change the name or link instead.
- `destination_url` must start with `http://` or `https://`.
- Untick `active` to retire a code. Scanning it then shows "This code is no longer active", and the scan is **not** logged.
- A new event needs its own code. Old codes contain their own slug, so they never count toward a new event.
- Changes to Campaigns take effect on the next scan (the cache is cleared on edit). If a change doesn't show up,
  use **QR Tracker → Refresh campaign cache**.
- New campaigns appear on the Dashboard automatically (room for 100). Slugs that have scans but were removed or renamed
  in Campaigns stay on the Dashboard as "<slug> (not in Campaigns)", so no scan is ever hidden.
- `tracker_link` shows each slug's tracked link (the exact link inside its QR code) as soon as the slug is typed; copy it to
  share by email or chat. It's one formula in the header cell, so don't type in that column. Run setup to restore it.
- Every visit to a tracked link counts: QR scans, clicks, typed links, refreshes, and some chat apps' link previews.
  Clicking the `destination_url` itself goes straight to the site and is **not** tracked.
- Dashboard formulas are rewritten each time you **Run setup** (your B3/B4 dates are kept), so a fixed formula
  reaches an existing Dashboard by running setup again.

## Deployment

### 1. Connect clasp (one time)
1. Turn on the Apps Script API for your account at <https://script.google.com/home/usersettings>. The setting must read **On**.
2. Install and log in:
   ```bash
   npm install -g @google/clasp
   ```
   ```bash
   clasp login
   ```

### 2. Create the Sheet and its bound script
The script **must be bound to the Sheet**. A standalone project made from script.google.com → New project won't work, because
`getActiveSpreadsheet()` returns nothing there. Either:

- **Let clasp create both** (recommended). Run:
  ```bash
  clasp create-script --type sheets --title "Event QR Tracker" --rootDir apps-script
  ```
  clasp writes `.clasp.json` for you, and also a default `apps-script/appsscript.json`, which you replace in step 3.
- **Or do it by hand.** Create a Google Sheet, open **Extensions → Apps Script → Project Settings ⚙️**, copy the **Script ID**,
  then copy `.clasp.json.example` to `.clasp.json` and paste it in. Don't use `clasp clone`, because it would overwrite this
  project's files with the editor's blank `Code.gs`. Bound scripts also don't show up in `clasp list-scripts`.

### 3. Add your settings, push the code and run setup
1. Copy `apps-script/appsscript.json.example` to `apps-script/appsscript.json` and set `timeZone` to yours
   (an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Europe/London`).
2. Copy `apps-script/Config.gs.example` to `apps-script/Config.gs`. You fill in `WEB_APP_URL` after step 4.
3. Push:
```bash
clasp push --force
```
`--force` replaces the remote manifest with this project's `appsscript.json`. Then open the **Sheet**, reload it,
and choose **QR Tracker → Run setup**. The first time, Google asks for authorization:

1. Click **OK**, then pick your account.
2. On the "Google hasn't verified this app" screen, click **Advanced → Go to Event QR Tracker**.
3. Tick **Select all** and click **Continue**. If the spreadsheets box is left unticked, setup fails with "You do not have permission to call SpreadsheetApp…".

Run setup again if it stopped for authorization. The Sheet now has **Campaigns** (with 3 sample rows), **Scans** and **Dashboard** tabs.

Choose **QR Tracker → Run self-tests**. A notice should say `All 25 tests passed`. The test logs one scan for the
first active campaign and then deletes it again.

> Time zone: `setup()` copies the `timeZone` from `appsscript.json` to the Sheet (**File → Settings → Time zone**).
> Scan timestamps and the Dashboard's daily counts use it. If you move, change the manifest, push, and run setup again.

### 4. Deploy as a web app (only once)
```bash
clasp create-deployment --description "Production - do not replace"
```
The manifest already sets execute as **Me** and access **Anyone**. In the editor, the equivalent is **Deploy → New deployment →**
⚙️ **Web app**. The printed ID is the **Deployment ID**. The web app URL is
`https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`. This is the URL you must never change (see the warning at the top).

### 5. Generate the QR codes
**In the Sheet (recommended).** Set `WEB_APP_URL` in `apps-script/Config.gs` to the `/exec` URL, push, and run
**QR Tracker → Run setup** again (it fills in `tracker_link`).
Then choose **QR Tracker → Generate QR codes**. The first run asks for Drive access; Google's wording is "all your Drive files",
but the script only writes to its own folder. For every active campaign it:
- saves `<slug>.png` (at least 1000 px, error correction H, wide quiet zone) to the Drive folder **Event QR codes**, next to
  the Sheet. An older file with the same name goes to the Drive trash.
- shows a preview in the `qr_code` column and a link to the file in `qr_file`.

Run it again whenever you add an event. Running it again is safe, because a slug's code never changes.

**Automatic.** Choose **QR Tracker → Turn on automatic QR codes** once. You'll be asked to approve, because it installs an edit
trigger that runs as you. From then on, **ticking `active`** on a campaign saves that row's code within a few seconds, and a
notice in the corner confirms it. Details:
- Fill in the slug first, then tick `active`. If you tick it on a row with no slug, nothing is made; add the slug and tick it again.
- Rows that already have their code (`qr_file` shows `<slug>.png`) are left alone, and so is unticking.
- Invalid or duplicate slugs are skipped with a notice. Pasting several ticked rows at once makes all of their codes.
- **QR Tracker → Turn off automatic QR codes** removes the trigger.

**On your PC (backup).** This produces the same links:
1. Fill in the Campaigns tab, then **File → Download → Comma-separated values (.csv)** while the Campaigns tab is selected.
   Save it as `campaigns.csv` in this folder.
2. Copy `.env.example` to `.env` and set `WEB_APP_URL=` to the `/exec` URL.
3. Generate:
   ```bash
   python -m venv .venv
   ```
   ```bash
   .venv/Scripts/python -m pip install -r requirements.txt
   ```
   ```bash
   .venv/Scripts/python generate_qr.py
   ```
   (On macOS/Linux use `.venv/bin/python`.) You get one `qr_codes/<slug>.png` per active campaign: at least
   1000 px, error correction level H, with a wide quiet zone, ready for print.

### 6. Test before printing
- [ ] Scan every code with an **iPhone** and an **Android** phone. Each one lands on the right site.
- [ ] A new row appears in **Scans** for each scan, with the right slug and event name.
- [ ] Untick `active` for one campaign and scan it. It shows "This code is no longer active". Tick it again.
- [ ] Visiting the `/exec` URL with no `?e=` (or a made-up slug) shows the same friendly page.
- [ ] The Dashboard totals and chart update.

## The Cloudflare Worker (instant redirect)
One-time setup:
1. Create a free account at <https://dash.cloudflare.com/sign-up> and choose a workers.dev subdomain
   (**Workers & Pages → Account details → Subdomain**).
2. Generate a long random key and put it in `WORKER_KEY` in both `apps-script/Config.gs` and `worker/wrangler.toml`
   (copy `worker/wrangler.example.toml` to `worker/wrangler.toml` and set the Apps Script `/exec` URL there too).
   Then push and update the Apps Script deployment.
3. Run `npx wrangler login` (approve in the browser), then `npx wrangler deploy --config worker/wrangler.toml`.
4. Set `LINK_BASE_URL` in `apps-script/Config.gs` and `.env` to the printed address, push, run **QR Tracker → Run setup**
   (updates `tracker_link`), then **Generate QR codes**.

To change the key, edit both files, push the Apps Script (with update-deployment), and redeploy the Worker.
To see the Worker's live logs, run `npx wrangler tail --config worker/wrangler.toml`.

## Updating the script later
1. Edit the files locally, then run `clasp push`.
2. **Deploy → Manage deployments → ✏️ Edit** the existing deployment **→ Version: New version → Deploy**.
   Or, from the command line:
   ```bash
   clasp update-deployment <deploymentId>
   ```
   (`clasp list-deployments` shows the ID.)
3. The URL stays the same and printed codes keep working.

Editing campaigns (names, destinations, active) needs **no** redeploy. It's just data in the Sheet.

## Known limitations
- **No visitor details.** Apps Script doesn't give the script the visitor's IP address or device, so this version logs
  the timestamp and event only. It doesn't log device type or unique visitors.
- **Older codes still need a tap.** Codes made before the Worker point at the Apps Script page. Google only lets that page
  leave after a tap (`allow-top-navigation-by-user-activation`), so those visitors tap **Continue to site**. New codes
  go through the Worker and redirect instantly. Keep the Apps Script deployment live so the older codes keep working.
- **Worker cold start.** After a quiet spell, the first visit waits 2–4 s while the Worker reloads Campaigns from Google.
  Campaign edits reach the Worker within about a minute; a brand-new slug works within about 5 seconds.
- **Quotas.** Apps Script has daily quotas and a limit on how many scripts can run at the same time (about 30). That's
  plenty for typical events, but a very large crowd scanning at the same moment could see occasional slowdowns.
  Logging never blocks the redirect: if a scan can't be written, the visitor is still sent on.
- **Privacy.** The Sheet is private by default. Share it **view-only** with teammates who need the numbers.
