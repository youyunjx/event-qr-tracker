/**
 * Event QR Code Tracker
 *
 * Bound to a Google Sheet and deployed as a web app. Each QR code points to
 *   <WEB_APP_URL>?e=<slug>
 * doGet() looks the slug up in the Campaigns tab, appends a row to Scans and
 * sends the visitor on to the campaign's destination URL.
 *
 * Tabs:
 *   Campaigns  slug | name | destination_url | active   (edited by hand)
 *   Scans      timestamp | slug | event_name            (written by this script only)
 *   Dashboard  formulas + chart                         (created by setup())
 */

const SHEET_CAMPAIGNS = 'Campaigns';
const SHEET_SCANS = 'Scans';
const SHEET_DASHBOARD = 'Dashboard';
const SHEET_SOURCES = 'Sources';

const CAMPAIGN_HEADERS = ['slug', 'name', 'source', 'destination_url', 'active']; // for a new Campaigns tab
const CAMPAIGN_REQUIRED = ['slug', 'name', 'destination_url', 'active']; // `source` is optional
const SCAN_HEADERS = ['timestamp', 'slug', 'event_name', 'source'];

// Each campaign row has a source (its channel); every scan of that row is logged with it.
// Blank = offline; anything outside the slug character rules = other.
const SOURCE_DEFAULT = 'offline';
const SOURCE_INVALID = 'other';
const SOURCE_SUGGESTIONS = ['offline', 'email', 'social'];

const CACHE_KEY = 'campaigns_v2'; // bump when the cached campaign shape changes
const CACHE_SECONDS = 300; // 5 minutes
const LOCK_WAIT_MS = 5000;
const SLUG_PATTERN = /^[a-z0-9_-]{1,64}$/; // lowercase letters, numbers, hyphens, underscores

// Rows reserved on the Dashboard for the per-event table and chart.
const DASHBOARD_MAX_EVENTS = 100;

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

function doGet(e) {
  if (e && e.parameter && e.parameter.api) return handleWorkerApi_(e.parameter); // Cloudflare Worker (WorkerApi.gs)

  const slug = normalizeSlug_(e && e.parameter && e.parameter.e);
  if (!slug) return inactivePage_();

  let campaign;
  try {
    campaign = getCampaign_(slug);
  } catch (err) {
    console.error('Campaign lookup failed for "' + slug + '": ' + err);
    return inactivePage_();
  }
  if (!campaign || !campaign.active || !isSafeUrl_(campaign.url)) {
    return inactivePage_();
  }

  // Logging must never block the redirect.
  try {
    logScan_(slug, campaign.name, campaign.source);
  } catch (err) {
    console.error('Scan logging failed for "' + slug + '": ' + err);
  }

  return redirectPage_(campaign.url);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Returns a valid lowercase slug, or '' if the input is missing or invalid. */
function normalizeSlug_(value) {
  const slug = String(value == null ? '' : value).trim().toLowerCase();
  return SLUG_PATTERN.test(slug) ? slug : '';
}

/** A campaign's source label: same character rules as slugs; blank = offline, unusable = other. */
function normalizeSource_(value) {
  if (value == null || String(value).trim() === '') return SOURCE_DEFAULT;
  return normalizeSlug_(value) || SOURCE_INVALID;
}

/** Returns {slug, name, source, url, active} for the slug, or null if unknown. */
function getCampaign_(slug) {
  return getCampaigns_()[slug] || null;
}

/** Campaigns keyed by slug, served from CacheService when possible. */
function getCampaigns_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const campaigns = readCampaignsFromSheet_();
  try {
    cache.put(CACHE_KEY, JSON.stringify(campaigns), CACHE_SECONDS);
  } catch (err) {
    // Cache values are limited to 100 KB; fall back to reading the sheet each time.
    console.warn('Could not cache campaigns: ' + err);
  }
  return campaigns;
}

function readCampaignsFromSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CAMPAIGNS);
  if (!sheet) throw new Error('Missing "' + SHEET_CAMPAIGNS + '" tab. Run setup().');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};

  // Locate columns by header name so column order in the sheet doesn't matter.
  const headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const col = {};
  CAMPAIGN_REQUIRED.forEach(function (name) {
    col[name] = headers.indexOf(name);
    if (col[name] === -1) throw new Error('Campaigns tab is missing the "' + name + '" column.');
  });
  col.source = headers.indexOf('source');

  const campaigns = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const slug = normalizeSlug_(row[col.slug]);
    if (!slug || campaigns[slug]) continue; // skip blank/invalid rows; first row wins on duplicates
    campaigns[slug] = {
      slug: slug,
      name: String(row[col.name]).trim() || slug,
      source: normalizeSource_(col.source === -1 ? '' : row[col.source]),
      url: String(row[col.destination_url]).trim(),
      active: isTruthy_(row[col.active]),
    };
  }
  return campaigns;
}

function isTruthy_(value) {
  if (value === true) return true;
  return ['true', 'yes', 'y', '1'].indexOf(String(value).trim().toLowerCase()) !== -1;
}

/** Only absolute http/https URLs are allowed as destinations. */
function isSafeUrl_(url) {
  return /^https?:\/\/[^\s"'<>]+$/i.test(String(url || '').trim());
}

/** Clears the campaign cache so edits to the Campaigns tab take effect immediately. */
function clearCampaignCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logScan_(slug, eventName, source) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SCANS);
  if (!sheet) throw new Error('Missing "' + SHEET_SCANS + '" tab. Run setup().');

  const row = [new Date(), slug, eventName, source || SOURCE_DEFAULT];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    // Better to try an unlocked append than to drop the scan entirely.
    console.warn('Lock timeout; appending scan without lock for "' + slug + '"');
    sheet.appendRow(row);
    return;
  }
  try {
    sheet.appendRow(row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function redirectPage_(url) {
  const template = HtmlService.createTemplateFromFile('Redirect');
  template.url = url;
  template.host = url.replace(/^https?:\/\/(www\.)?/i, '').split(/[\/?#:]/)[0];
  return template.evaluate()
    .setTitle('Continue to site')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function inactivePage_() {
  const html =
    '<!DOCTYPE html><html><head><base target="_top">' +
    '<style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:48px 24px;' +
    'text-align:center;color:#222}h1{font-size:1.4em;margin:0 0 .5em}p{color:#555}</style>' +
    '</head><body><h1>This code is no longer active</h1>' +
    '<p>Thanks for scanning. This event link has ended or is not available.</p></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('Code not active')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// Sheet setup (run once from the Apps Script editor or the QR Tracker menu)
// ---------------------------------------------------------------------------

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const originalSheets = ss.getSheets();
  // Scan timestamps and the Dashboard's daily counts use the Sheet's time zone; match it to appsscript.json.
  ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());

  const campaigns = getOrCreateSheet_(ss, SHEET_CAMPAIGNS);
  if (campaigns.getLastRow() === 0) {
    campaigns.getRange(1, 1, 1, CAMPAIGN_HEADERS.length).setValues([CAMPAIGN_HEADERS]);
    campaigns.getRange('E2:E').setDataValidation(
      SpreadsheetApp.newDataValidation().requireCheckbox().build());
    campaigns.getRange(2, 1, 3, CAMPAIGN_HEADERS.length).setValues([
      ['event-a', 'Event A – Expo', 'offline', 'https://example.com', true],
      ['event-a_email', 'Event A – Expo', 'email', 'https://example.com', true],
      ['event-a_social', 'Event A – Expo', 'social', 'https://example.com', true],
    ]);
    styleHeader_(campaigns, CAMPAIGN_HEADERS.length);
    campaigns.setColumnWidth(2, 220);
    campaigns.setColumnWidth(4, 320);
  }
  ensureSourceColumn_(campaigns);
  writeTrackerLinkColumn_(campaigns);

  const scans = getOrCreateSheet_(ss, SHEET_SCANS);
  if (scans.getLastRow() === 0) {
    scans.getRange(1, 1, 1, SCAN_HEADERS.length).setValues([SCAN_HEADERS]);
    scans.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
    styleHeader_(scans, SCAN_HEADERS.length);
    scans.setColumnWidth(1, 170);
    scans.setColumnWidth(3, 220);
    scans.protect()
      .setDescription('Written by the QR tracker script. Do not edit by hand.')
      .setWarningOnly(true);
  } else {
    addSourceColumnToScans_(scans);
  }

  const dashboard = getOrCreateSheet_(ss, SHEET_DASHBOARD);
  if (dashboard.getLastRow() === 0) buildDashboard_(dashboard);
  else writeDashboardFormulas_(dashboard);

  const sources = getOrCreateSheet_(ss, SHEET_SOURCES);
  if (sources.getLastRow() === 0) buildSourcesTab_(sources);
  else writeSourcesFormulas_(sources);

  // Remove the empty default tab ("Sheet1", "工作表1", ...) a brand-new spreadsheet comes with.
  if (originalSheets.length === 1) {
    const defaultSheet = originalSheets[0];
    const ours = [SHEET_CAMPAIGNS, SHEET_SCANS, SHEET_DASHBOARD, SHEET_SOURCES];
    if (ours.indexOf(defaultSheet.getName()) === -1 && defaultSheet.getLastRow() === 0) {
      ss.deleteSheet(defaultSheet);
    }
  }

  clearCampaignCache();
  ss.setActiveSheet(dashboard);
}

/**
 * Campaigns → `source`: inserted right after `name` if missing, with a dropdown of suggestions.
 * Other labels can still be typed (they're flagged but accepted); blank means offline.
 */
function ensureSourceColumn_(sheet) {
  const headerRow = function () {
    return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
      .map(function (h) { return String(h).trim().toLowerCase(); });
  };
  let headers = headerRow();
  if (headers.indexOf('source') === -1) {
    const nameCol = headers.indexOf('name') + 1;
    if (!nameCol) return;
    sheet.insertColumnAfter(nameCol);
    sheet.getRange(1, nameCol + 1).setValue('source').setFontWeight('bold').setBackground('#f1f3f4');
    headers = headerRow();
  }
  const col = headers.indexOf('source') + 1;
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(SOURCE_SUGGESTIONS, true).setAllowInvalid(true).build());
  sheet.setColumnWidth(col, 110);
}

/**
 * Campaigns → `tracker_link`: one array formula in the header cell that shows each slug's tracked link
 * (the link inside its QR code) as soon as the slug is typed. Rewritten and re-locked on every setup() run.
 */
function writeTrackerLinkColumn_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });
  const slugIndex = headers.indexOf('slug');
  if (slugIndex === -1) return;

  let col = headers.indexOf('tracker_link') + 1;
  if (!col) {
    col = lastCol + 1;
    sheet.getRange(1, col).setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setColumnWidth(col, 520);
  }
  const slugs = columnLetter_(slugIndex + 1) + '2:' + columnLetter_(slugIndex + 1);
  const slug = 'LOWER(TRIM(' + slugs + '))';
  const link = '"' + trackerLinkPrefix_() + '" & ' + slug;
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).clearContent(); // the array needs empty cells below
  sheet.getRange(1, col).setFormula(
    '={"tracker_link"; ARRAYFORMULA(IF(LEN(TRIM(' + slugs + '))=0, "", ' +
    'IF(REGEXMATCH(' + slug + ', "' + SLUG_PATTERN.source + '"), HYPERLINK(' + link + ', ' + link + '), "(invalid slug)")))}');

  // Warning-only lock: owners can't be locked out of their own Sheet, so everyone (owner included)
  // gets a confirm prompt before editing. Replaced on every run so it follows the column.
  const description = 'tracker_link is filled in automatically. Do not edit.';
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === description) p.remove();
  });
  const letter = columnLetter_(col);
  sheet.getRange(letter + ':' + letter).protect().setDescription(description).setWarningOnly(true);
}

/** Older Scans tabs had no source column: add it and mark existing scans as offline (the default). */
function addSourceColumnToScans_(scans) {
  const header = scans.getRange(1, 4);
  if (String(header.getValue()).trim() === '') {
    header.setValue('source').setFontWeight('bold').setBackground('#f1f3f4');
  }
  const lastRow = scans.getLastRow();
  if (lastRow < 2) return;
  const range = scans.getRange(2, 4, lastRow - 1, 1);
  const values = range.getValues();
  let changed = false;
  values.forEach(function (row) {
    if (String(row[0]).trim() === '') { row[0] = SOURCE_DEFAULT; changed = true; }
  });
  if (changed) range.setValues(values);
}

/** Sources tab: scans per source and per event × source, using the Dashboard's date range. */
function buildSourcesTab_(sheet) {
  sheet.getRange('A1').setValue('Scans by source').setFontSize(16).setFontWeight('bold');
  sheet.getRange('A2').setValue('Uses the Start / End dates on the Dashboard tab. Each scan takes the source of its ' +
    'campaign row; give an event\'s rows the same name to add them up here.').setFontColor('#777777').setFontStyle('italic');
  sheet.getRange('A3').setValue('Total per source').setFontWeight('bold');
  sheet.getRange('F3').setValue('Per event and source').setFontWeight('bold');
  sheet.setColumnWidth(1, 140);
  writeSourcesFormulas_(sheet);

  const chart = sheet.newChart()
    .asPieChart()
    .addRange(sheet.getRange('A4:B30'))
    .setNumHeaders(1)
    .setOption('title', 'Scans by source')
    .setOption('width', 420)
    .setOption('height', 300)
    .setPosition(16, 1, 0, 0)
    .build();
  sheet.insertChart(chart);
}

function writeSourcesFormulas_(sheet) {
  const start = 'IF(Dashboard!$B$3="", 0, Dashboard!$B$3)';
  const end = 'IF(Dashboard!$B$4="", 2958465, Dashboard!$B$4 + 1)';
  const where = ' where A is not null' +
    ' and A >= datetime \'"&TEXT(' + start + ', "yyyy-mm-dd HH:mm:ss")&"\'' +
    ' and A < datetime \'"&TEXT(' + end + ', "yyyy-mm-dd HH:mm:ss")&"\'';
  sheet.getRange('A4').setFormula(
    '=IFERROR(QUERY(Scans!A2:D, "select D, count(C)' + where +
    ' group by D order by count(C) desc label D \'Source\', count(C) \'Scans\'", 0), "No scans in range yet")');
  sheet.getRange('F4').setFormula(
    '=IFERROR(QUERY(Scans!A2:D, "select C, count(B)' + where +
    ' group by C pivot D label C \'Event\'", 0), "No scans in range yet")');
}

function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function styleHeader_(sheet, width) {
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
}

/**
 * Dashboard layout:
 *   B3 / B4      optional start / end date (inclusive; blank = all time)
 *   A7:E         per-event table: slug, event, total scans, first scan, last scan
 *   G2           bar chart of total scans per event
 *   G25          scans per day (rows) per event slug (columns)
 */
function buildDashboard_(sheet) {
  const lastRow = 7 + DASHBOARD_MAX_EVENTS;

  sheet.getRange('A1').setValue('Event QR Tracker – Dashboard').setFontSize(16).setFontWeight('bold');
  sheet.getRange('A3:A5').setValues([
    ['Start date (optional)'],
    ['End date (optional)'],
    ['Leave blank for all time. Both dates are inclusive.'],
  ]);
  sheet.getRange('A5').setFontColor('#777777').setFontStyle('italic');
  sheet.getRange('B3:B4').setNumberFormat('yyyy-mm-dd').setBackground('#fff8e1')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  sheet.getRange('D3').setValue('Total scans in range');
  sheet.getRange('E3').setFormula('=SUM(C8:C' + lastRow + ')').setFontWeight('bold');

  sheet.getRange('A7:E7').setValues([['Slug', 'Event', 'Total scans', 'First scan', 'Last scan']])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.getRange('D8:E' + lastRow).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('G24').setValue('Scans per day per event (newest first)').setFontWeight('bold');
  sheet.getRange('G26:G').setNumberFormat('yyyy-mm-dd');
  writeDashboardFormulas_(sheet);

  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2, 220);
  sheet.setColumnWidths(3, 3, 140);

  const chart = sheet.newChart()
    .asBarChart()
    .addRange(sheet.getRange('B7:C' + lastRow))
    .setNumHeaders(1)
    .setOption('title', 'Total scans per event')
    .setOption('legend', { position: 'none' })
    .setOption('width', 600)
    .setOption('height', 400)
    .setPosition(2, 7, 0, 0)
    .build();
  sheet.insertChart(chart);
}

/**
 * (Re)writes every Dashboard formula. setup() calls this on each run, so formula fixes reach
 * existing Dashboards; the date inputs in B3/B4 are left alone.
 */
function writeDashboardFormulas_(sheet) {
  const lastRow = 7 + DASHBOARD_MAX_EVENTS;
  // Shared date-range bounds used by every formula below (end is exclusive).
  const start = 'IF($B$3="", 0, $B$3)';
  const end = 'IF($B$4="", 2958465, $B$4 + 1)'; // 2958465 = 9999-12-31, the latest date Sheets supports

  sheet.getRange('E3').setFormula('=SUM(C8:C' + lastRow + ')');
  // Every campaign, plus any slug that has scans but was since removed or renamed in Campaigns.
  sheet.getRange('A8').setFormula(
    '=IFERROR(UNIQUE(FILTER({Campaigns!A2:A; Scans!B2:B}, {Campaigns!A2:A; Scans!B2:B}<>"")), "")');
  sheet.getRange('B8').setFormula(
    '=BYROW(A8:A' + lastRow + ', LAMBDA(s, IF(s="", "", ' +
    'IFERROR(VLOOKUP(s, Campaigns!A2:B, 2, FALSE), s & " (not in Campaigns)"))))');
  sheet.getRange('C8').setFormula(
    '=BYROW(A8:A' + lastRow + ', LAMBDA(s, IF(s="", "", ' +
    'COUNTIFS(Scans!B2:B, s, Scans!A2:A, ">="&' + start + ', Scans!A2:A, "<"&' + end + '))))');
  sheet.getRange('D8').setFormula(
    '=BYROW(A8:A' + lastRow + ', LAMBDA(s, IF(s="", "", LET(v, ' +
    'MINIFS(Scans!A2:A, Scans!B2:B, s, Scans!A2:A, ">="&' + start + ', Scans!A2:A, "<"&' + end + '), ' +
    'IF(v=0, "", v)))))');
  sheet.getRange('E8').setFormula(
    '=BYROW(A8:A' + lastRow + ', LAMBDA(s, IF(s="", "", LET(v, ' +
    'MAXIFS(Scans!A2:A, Scans!B2:B, s, Scans!A2:A, ">="&' + start + ', Scans!A2:A, "<"&' + end + '), ' +
    'IF(v=0, "", v)))))');

  // Source of each listed campaign (blank = offline), looked up by header so column order doesn't matter.
  const campaignSheet = sheet.getParent().getSheetByName(SHEET_CAMPAIGNS);
  const campaignHeaders = campaignSheet.getRange(1, 1, 1, Math.max(campaignSheet.getLastColumn(), 1)).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });
  const slugCol = campaignHeaders.indexOf('slug') + 1;
  const sourceCol = campaignHeaders.indexOf('source') + 1;
  sheet.getRange('F7').setValue('Source').setFontWeight('bold').setBackground('#f1f3f4');
  if (slugCol && sourceCol) {
    const slugs = 'Campaigns!' + columnLetter_(slugCol) + '2:' + columnLetter_(slugCol);
    const sources = 'Campaigns!' + columnLetter_(sourceCol) + '2:' + columnLetter_(sourceCol);
    sheet.getRange('F8').setFormula(
      '=BYROW(A8:A' + lastRow + ', LAMBDA(s, IF(s="", "", IFERROR(LET(v, XLOOKUP(s, ' + slugs + ', ' + sources + '), ' +
      'IF(TRIM(v)="", "' + SOURCE_DEFAULT + '", LOWER(TRIM(v)))), ""))))');
  }

  // count(C), not count(B): QUERY can't aggregate the column it pivots on (AGG_IN_SELECT_NO_PIVOT).
  sheet.getRange('G25').setFormula(
    '=IFERROR(QUERY(Scans!A2:C, ' +
    '"select toDate(A), count(C) where A is not null' +
    ' and A >= datetime \'"&TEXT(' + start + ', "yyyy-mm-dd HH:mm:ss")&"\'' +
    ' and A < datetime \'"&TEXT(' + end + ', "yyyy-mm-dd HH:mm:ss")&"\'' +
    ' group by toDate(A) pivot B order by toDate(A) desc label toDate(A) \'Date\'", 0), ' +
    '"No scans in range yet")');
}

// ---------------------------------------------------------------------------
// Menu & triggers
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QR Tracker')
    .addItem('Generate QR codes', 'generateQrCodes')
    .addItem('Turn on automatic QR codes', 'enableAutoQrCodes')
    .addItem('Turn off automatic QR codes', 'disableAutoQrCodes')
    .addSeparator()
    .addItem('Run setup', 'setup')
    .addItem('Refresh campaign cache', 'clearCampaignCache')
    .addItem('Run self-tests', 'runTests')
    .addToUi();
}

/** Edits to the Campaigns tab take effect on the next scan instead of after the cache expires. */
function onEdit(e) {
  try {
    if (e && e.range && e.range.getSheet().getName() === SHEET_CAMPAIGNS) clearCampaignCache();
  } catch (err) {
    console.warn('onEdit cache clear failed: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Self-tests (run from the editor: select runTests → Run, then check the log)
// ---------------------------------------------------------------------------

function runTests() {
  const results = [];
  function check(name, condition) {
    results.push((condition ? 'PASS  ' : 'FAIL  ') + name);
  }

  // Pure helpers
  check('normalizeSlug_ accepts valid slug', normalizeSlug_('event-a') === 'event-a');
  check('normalizeSlug_ lowercases', normalizeSlug_('Event-A') === 'event-a');
  check('normalizeSlug_ accepts underscores', normalizeSlug_('event_movie') === 'event_movie');
  check('normalizeSource_ defaults to offline', normalizeSource_(undefined) === 'offline' && normalizeSource_(' ') === 'offline');
  check('normalizeSource_ keeps a valid source', normalizeSource_('Email ') === 'email');
  check('normalizeSource_ maps junk to other', normalizeSource_('bad src!') === 'other');
  check('normalizeSlug_ rejects bad characters', normalizeSlug_('event a<script>') === '');
  check('normalizeSlug_ rejects empty', normalizeSlug_(undefined) === '');
  check('isSafeUrl_ allows https', isSafeUrl_('https://example.com/page?x=1'));
  check('isSafeUrl_ rejects javascript:', !isSafeUrl_('javascript:alert(1)'));
  check('isSafeUrl_ rejects relative', !isSafeUrl_('/relative'));

  // QR encoder and PNG writer (QrCode.gs); full decode tests run locally against a real QR reader
  const qr = qrEncode_('HELLO', 'H');
  check('qrEncode_ picks version 1 for short text', qr.length === 21);
  check('qrEncode_ draws finder patterns', qr[0][0] && qr[0][20] && qr[20][0] && !qr[1][1]);
  check('qrEncode_ fits the event links', qrEncode_(qrLinkFor_('event-a'), 'H').length >= 21);
  const png = qrToPngBytes_(qr, 4, 4);
  check('qrToPngBytes_ writes a PNG signature', png.slice(0, 8).join() === '137,80,78,71,13,10,26,10');
  check('qrLinkFor_ builds the tracked link', qrLinkFor_('event-a') === trackerLinkPrefix_() + 'event-a');
  check('Worker API rejects a wrong key', handleWorkerApi_({ api: 'campaigns', key: 'wrong' }).getContent().indexOf('forbidden') !== -1);

  // Lookup against the real Campaigns tab
  clearCampaignCache();
  const campaigns = getCampaigns_();
  const known = Object.keys(campaigns).filter(function (s) {
    return campaigns[s].active && isSafeUrl_(campaigns[s].url);
  })[0];
  check('Campaigns tab has at least one active campaign', !!known);
  check('Unknown slug returns null', getCampaign_('no-such-event-zz9') === null);
  check('Cache returns same data', JSON.stringify(getCampaigns_()) === JSON.stringify(campaigns));

  // Unknown slug → inactive page, nothing logged
  const scans = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SCANS);
  const rowsBefore = scans.getLastRow();
  const unknownPage = doGet({ parameter: { e: 'no-such-event-zz9' } }).getContent();
  check('Unknown slug shows inactive page', unknownPage.indexOf('no longer active') !== -1);
  check('Unknown slug is not logged', scans.getLastRow() === rowsBefore);

  // Known slug → redirect page + one logged row (removed again afterwards)
  if (known) {
    const page = doGet({ parameter: { e: known } }).getContent();
    check('Known slug shows redirect page', page.indexOf('Continue to site') !== -1);
    const lastRow = scans.getLastRow();
    const logged = scans.getRange(lastRow, 1, 1, 4).getValues()[0];
    const isOurRow = lastRow === rowsBefore + 1 && logged[1] === known;
    check('Known slug is logged to Scans', isOurRow);
    check('Scan records the campaign\'s source', isOurRow && logged[3] === campaigns[known].source);
    if (isOurRow) {
      const lock = LockService.getScriptLock();
      lock.waitLock(LOCK_WAIT_MS);
      try {
        if (scans.getLastRow() === lastRow) scans.deleteRow(lastRow);
      } finally {
        lock.releaseLock();
      }
    }
  }

  const failed = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
  const summary = (failed ? failed + ' test(s) FAILED' : 'All ' + results.length + ' tests passed');
  console.log(results.join('\n') + '\n\n' + summary);
  SpreadsheetApp.getActiveSpreadsheet().toast(summary, 'QR Tracker self-tests', 10);
  return summary;
}
