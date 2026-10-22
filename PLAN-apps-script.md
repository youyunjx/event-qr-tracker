# Project Plan: Event QR Code Tracker (Google Apps Script + Google Sheets)

## Goal
Same as the Python version: one unique QR code per offline event (Event A, B, C, ...), all able to point to the same website, with every scan counted per event. Here there is no server or hosting to manage. A Google Apps Script web app, published from a Google Sheet, does the redirect and logging, and the Sheet itself is the database and dashboard.

## How it works
1. Each QR code encodes the Apps Script web app URL plus an event tag:
   `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?e=event-a`
2. When scanned, the script looks up `event-a` in the Sheet, appends a row to the scan log, and sends the visitor on to the destination URL.
3. A Dashboard tab in the same Sheet counts scans per event with formulas and a chart.

## Tools
- Google Apps Script (V8 runtime), bound to one Google Sheet
- `clasp` (Google's Apps Script command-line tool) so Claude Code can write the code locally and push it to Google
- A small local Python script (`qrcode` + Pillow) to generate the QR PNG files

## Google Sheet structure
**Campaigns** tab (one row per event; edited by hand)
| slug | name | destination_url | active |
|------|------|-----------------|--------|
| event-a | Event A – Expo | https://example.com | TRUE |

**Scans** tab (written only by the script; never edit by hand)
| timestamp | slug | event_name |

**Dashboard** tab
- Per-event table: event name, total scans (`COUNTIF` on Scans), first and last scan time
- Scans per day per event (`QUERY` or a pivot table)
- Bar chart of total scans per event
- Optional date-range cells that the formulas respect

## Script requirements (`Code.gs`)
- `doGet(e)`:
  - Read `e.parameter.e`; validate it (lowercase letters, numbers, hyphens only)
  - Look up the slug in Campaigns; cache the Campaigns table with `CacheService` (e.g. 5 minutes) so most scans don't re-read the sheet
  - If the slug is unknown or inactive, return a simple friendly "This code is no longer active" page
  - Append `[new Date(), slug, name]` to Scans using `LockService` (short wait, e.g. 5 seconds) so simultaneous scans don't collide
  - If logging fails, still redirect the visitor; never leave them stuck
  - Return an `HtmlService` page that immediately sends the browser to the destination (`window.top.location.href = url`), and also shows a visible "Continue to site" button as a fallback in case a browser blocks the automatic redirect
  - Only allow `http`/`https` destination URLs
- Keep the page tiny and fast: no external libraries, minimal styling, mobile-friendly
- `setup()` helper: creates the three tabs with headers and the Dashboard formulas if they don't exist

## QR generation (`generate_qr.py`, runs locally)
- Reads the Campaigns tab exported as CSV (or a local `campaigns.csv`)
- For each active slug, builds `{WEB_APP_URL}?e={slug}` and saves `qr_codes/{slug}.png`
- High error correction (level H), generous quiet zone, at least 1000px for printing
- `WEB_APP_URL` comes from a `.env` file

## Deployment steps (document in README)
1. Create a Google Sheet; open Extensions → Apps Script; note the script ID
2. Install clasp (`npm install -g @google/clasp`), run `clasp login`, then `clasp clone <scriptId>`
3. Push code with `clasp push`; run `setup()` once from the editor and approve permissions
4. Deploy → New deployment → type **Web app**, Execute as **Me**, Who has access **Anyone**
5. Copy the `/exec` URL into `.env` and generate QR codes
6. Test-scan every code with a phone before printing; confirm a row appears in Scans

## Critical rule: never change the URL
The deployment URL is printed into every QR code. When updating the script later, use **Manage deployments → Edit → New version** on the *existing* deployment. Creating a *new* deployment produces a new URL and breaks every printed code. Put this warning at the top of the README.

## Known limitations (note in README)
- Apps Script does not give the script the visitor's IP address or device information, so this version logs timestamp and event only, not device type or unique visitors
- The redirect passes through a Google page first, so it is a little slower than a dedicated server, and some personal Google accounts show a small Google notice on the page
- Apps Script has daily quotas and a limit on how many scripts can run at the same time; this is ample for typical events, but a very large crowd scanning at the same moment could see occasional slowdowns
- The Sheet is private by default; share it view-only with teammates who need the numbers

## Tests / checks
- A unit-test-style function in Apps Script that calls the lookup and logging logic with a known slug and an unknown slug
- Manual checklist: scan each code on iPhone and Android, confirm redirect and logged row, confirm an inactive slug shows the "no longer active" page

## Project structure
```
qr-tracker-apps-script/
├── apps-script/
│   ├── Code.gs
│   ├── Redirect.html
│   └── appsscript.json   # webapp settings: executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS
├── generate_qr.py
├── requirements.txt      # qrcode[pil], python-dotenv
├── .env.example          # WEB_APP_URL=
├── .gitignore            # .env, qr_codes/, .clasprc.json
└── README.md
```

## Build order
1. Sheet setup function and tab structure
2. `doGet` redirect + logging, tested in the browser
3. Deploy as web app and confirm a real scan logs correctly
4. Dashboard formulas and chart
5. `generate_qr.py`
6. README with deployment steps and the URL warning
