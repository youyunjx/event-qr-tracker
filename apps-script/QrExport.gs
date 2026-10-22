/**
 * QR code export
 *
 * Saves one print-ready PNG per active campaign to a Drive folder ("Event QR codes", next to this Sheet)
 * and writes a preview (qr_code) and a file link (qr_file) into the Campaigns tab.
 * Produces the same links as generate_qr.py, so either can be used.
 *
 *   QR Tracker → Generate QR codes            every active campaign, on demand
 *   QR Tracker → Turn on automatic QR codes   ticking `active` makes that row's code (installable edit trigger)
 */

// WEB_APP_URL and LINK_BASE_URL (the installation's links) live in Config.gs, which stays out of git.

const QR_FOLDER_NAME = 'Event QR codes';
const QR_FOLDER_PROPERTY = 'qrFolderId';
const QR_MIN_SIZE_PX = 1000;
const QR_BORDER_MODULES = 6; // quiet zone; the QR spec minimum is 4
const QR_PREVIEW_SCALE = 2;
const QR_PREVIEW_ROW_HEIGHT = 140;
const QR_AUTO_HANDLER = 'onCampaignEditInstalled';

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

function generateQrCodes() {
  const ctx = qrExportContext_(SpreadsheetApp.getActiveSpreadsheet());
  const made = [];
  const skipped = [];
  const seen = {};
  for (let r = 1; r < ctx.values.length; r++) {
    const raw = String(ctx.values[r][ctx.col.slug]).trim();
    if (!raw) continue;
    const slug = normalizeSlug_(raw);
    if (!slug) { skipped.push(raw + ' (invalid slug)'); continue; }
    if (seen[slug]) { skipped.push(slug + ' (duplicate)'); continue; }
    seen[slug] = true;
    if (!isTruthy_(ctx.values[r][ctx.col.active])) continue;
    generateQrForRow_(ctx, r + 1, slug);
    made.push(slug);
  }
  finishQrExport_(ctx);

  const message = 'Saved ' + made.length + ' QR code(s) to the Drive folder "' + ctx.folder.getName() + '" (next to this Sheet). ' +
    'Open them from the qr_file column.' +
    (skipped.length ? '\n\nSkipped: ' + skipped.join(', ') : '') +
    '\n\nTest-scan each code with a phone before printing.';
  try {
    SpreadsheetApp.getUi().alert('QR codes generated', message, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    console.log(message); // run from the editor: no Sheet UI
  }
  return made;
}

function enableAutoQrCodes() {
  disableAutoQrCodes_();
  ScriptApp.newTrigger(QR_AUTO_HANDLER).forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Ticking "active" on a campaign now saves its QR code automatically.', 'Automatic QR codes: on', 10);
}

function disableAutoQrCodes() {
  const removed = disableAutoQrCodes_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    removed ? 'Use QR Tracker → Generate QR codes to make codes.' : 'It was not turned on.', 'Automatic QR codes: off', 10);
}

function disableAutoQrCodes_() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === QR_AUTO_HANDLER) { ScriptApp.deleteTrigger(t); removed++; }
  });
  return removed;
}

// ---------------------------------------------------------------------------
// Installable edit trigger: tick `active` → that row's QR code
// ---------------------------------------------------------------------------

function onCampaignEditInstalled(e) {
  const range = e && e.range;
  if (!range || range.getSheet().getName() !== SHEET_CAMPAIGNS || range.getLastRow() < 2) return;

  const sheet = range.getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });
  const activeCol = headers.indexOf('active') + 1;
  if (!activeCol || activeCol < range.getColumn() || activeCol > range.getLastColumn()) return; // `active` not edited

  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ctx = qrExportContext_(e.source);
    const made = [];
    const problems = [];
    for (let rowNum = Math.max(2, range.getRow()); rowNum <= range.getLastRow(); rowNum++) {
      const row = ctx.values[rowNum - 1];
      if (!row || !isTruthy_(row[ctx.col.active])) continue; // unticked: keep the existing code
      const raw = String(row[ctx.col.slug]).trim();
      const slug = normalizeSlug_(raw);
      if (!slug) { if (raw) problems.push(raw + ': invalid slug'); else problems.push('row ' + rowNum + ' (add the slug, then tick active again)'); continue; }
      if (firstRowWithSlug_(ctx, slug) !== rowNum) { problems.push(slug + ': duplicate slug'); continue; }
      if (sheet.getRange(rowNum, ctx.fileCol).getDisplayValue() === slug + '.png') continue; // already has its code
      generateQrForRow_(ctx, rowNum, slug);
      made.push(slug);
    }
    if (made.length) finishQrExport_(ctx);
    if (made.length || problems.length) {
      e.source.toast(
        (made.length ? 'Saved ' + made.map(function (s) { return s + '.png'; }).join(', ') + ' to "' + ctx.folder.getName() + '". ' : '') +
        (problems.length ? 'No code made for ' + problems.join('; ') + '.' : ''),
        'QR Tracker', 10);
    }
  } finally {
    lock.releaseLock();
  }
}

function firstRowWithSlug_(ctx, slug) {
  for (let r = 1; r < ctx.values.length; r++) {
    if (normalizeSlug_(ctx.values[r][ctx.col.slug]) === slug) return r + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function qrExportContext_(ss) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(WEB_APP_URL)) {
    throw new Error('Set WEB_APP_URL in QrExport.gs to the deployment\'s /exec URL.');
  }
  const sheet = ss.getSheetByName(SHEET_CAMPAIGNS);
  if (!sheet) throw new Error('Missing "' + SHEET_CAMPAIGNS + '" tab. Run setup().');

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const col = {};
  ['slug', 'name', 'active'].forEach(function (name) {
    col[name] = headers.indexOf(name);
    if (col[name] === -1) throw new Error('Campaigns tab is missing the "' + name + '" column.');
  });
  return {
    ss: ss,
    sheet: sheet,
    values: values,
    col: col,
    previewCol: ensureColumn_(sheet, headers, 'qr_code'),
    fileCol: ensureColumn_(sheet, headers, 'qr_file'),
    folder: getQrFolder_(ss),
  };
}

/** Saves <slug>.png to Drive and writes the preview and file link into the row. */
function generateQrForRow_(ctx, rowNum, slug) {
  const link = qrLinkFor_(slug);
  const modules = qrEncode_(link, 'H');
  const scale = Math.ceil(QR_MIN_SIZE_PX / (modules.length + 2 * QR_BORDER_MODULES));
  const name = String(ctx.values[rowNum - 1][ctx.col.name]).trim() || slug;
  const file = saveQrPng_(ctx.folder, slug + '.png', qrToPngBytes_(modules, scale, QR_BORDER_MODULES), name + ' – ' + link);

  try {
    const preview = 'data:image/png;base64,' +
      Utilities.base64Encode(toSignedBytes_(qrToPngBytes_(modules, QR_PREVIEW_SCALE, 2)));
    ctx.sheet.getRange(rowNum, ctx.previewCol).setValue(
      SpreadsheetApp.newCellImage().setSourceUrl(preview).setAltTextTitle(slug).build());
    ctx.sheet.setRowHeight(rowNum, QR_PREVIEW_ROW_HEIGHT);
  } catch (err) {
    console.warn('Preview failed for "' + slug + '": ' + err); // the PNG in Drive is what matters
  }
  ctx.sheet.getRange(rowNum, ctx.fileCol).setFormula('=HYPERLINK("' + file.getUrl() + '", "' + slug + '.png")');
}

function finishQrExport_(ctx) {
  ctx.sheet.setColumnWidth(ctx.previewCol, QR_PREVIEW_ROW_HEIGHT);
  ctx.sheet.getRange(1, ctx.fileCol)
    .setNote('PNG files are in the Drive folder "' + ctx.folder.getName() + '":\n' + ctx.folder.getUrl());
}

function qrLinkFor_(slug) {
  return trackerLinkPrefix_() + encodeURIComponent(slug);
}

/** Everything before the slug in a tracked link (also used by the tracker_link formula). */
function trackerLinkPrefix_() {
  return LINK_BASE_URL ? LINK_BASE_URL.replace(/\/+$/, '') + '/' : WEB_APP_URL + '?e=';
}

/** Returns the 1-based column with this header, adding it after the last column if missing. */
function ensureColumn_(sheet, headers, name) {
  const index = headers.indexOf(name);
  if (index !== -1) return index + 1;
  const column = sheet.getLastColumn() + 1;
  sheet.getRange(1, column).setValue(name).setFontWeight('bold').setBackground('#f1f3f4');
  headers.push(name);
  return column;
}

/** The export folder, remembered per spreadsheet; recreated next to the Sheet if missing or trashed. */
function getQrFolder_(ss) {
  const props = PropertiesService.getDocumentProperties();
  const id = props.getProperty(QR_FOLDER_PROPERTY);
  if (id) {
    try {
      const existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (err) {
      // deleted or no longer accessible; make a new one
    }
  }
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const folder = parent.createFolder(QR_FOLDER_NAME);
  props.setProperty(QR_FOLDER_PROPERTY, folder.getId());
  return folder;
}

/** Saves the PNG, moving any older file with the same name to the Drive trash first. */
function saveQrPng_(folder, fileName, bytes, description) {
  const old = folder.getFilesByName(fileName);
  while (old.hasNext()) old.next().setTrashed(true);
  return folder.createFile(Utilities.newBlob(toSignedBytes_(bytes), 'image/png', fileName))
    .setDescription(description);
}

/** Apps Script blobs take Java-style signed bytes (-128..127). */
function toSignedBytes_(bytes) {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
  return out;
}
