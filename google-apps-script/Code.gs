/*
 * Glatt AI preview lead receiver. Copy assets/leads-core.js into Core.gs too.
 * Account-specific values live ONLY in Script Properties (see docs/leads-setup.md).
 * Never log a request, sheet row, raw exception, email address or secret.
 */
var LEAD_HEADERS = [
  'תאריך ושעה (ישראל)', 'שם מלא', 'טלפון', 'אימייל', 'רקע טכנולוגי', 'תהליך לאוטומציה',
  'כתובת העמוד', 'סטטוס טיפול', 'מזהה פנייה', 'request_id', 'payload_hash',
  'notification_status', 'notification_attempts', 'notification_last_attempt',
  'notification_next_attempt_ms', 'notification_error', 'notification_sent_at', 'notification_lease'
];
var COL = {created:0, name:1, phone:2, email:3, background:4, process:5, page:6, status:7,
  leadId:8, requestId:9, hash:10, mailStatus:11, attempts:12, lastAttempt:13, nextAttempt:14,
  error:15, sentAt:16, lease:17};
var MAX_ATTEMPTS = 5;
var MAIL_LEASE_MS = 10 * 60 * 1000;

function config_() {
  var p = PropertiesService.getScriptProperties().getProperties();
  var origins;
  try { origins = JSON.parse(p.ALLOWED_ORIGINS || '[]'); } catch (_) { GlattLeads.fail('CONFIG_ERROR'); }
  if (p.ENVIRONMENT !== 'preview' || !/^[0-9a-f]{64}$/i.test(p.HMAC_SECRET || '') ||
      !/^[\w-]{20,}$/.test(p.SHEET_ID || '') || !/^[A-Za-z0-9_-]{1,50}$/.test(p.SHEET_NAME || '') ||
      !Array.isArray(origins) || !origins.length || !origins.every(GlattLeads.previewOrigin)) GlattLeads.fail('CONFIG_ERROR');
  try { if (!GlattLeads.email(p.NOTIFICATION_EMAIL || '')) GlattLeads.fail('CONFIG_ERROR'); }
  catch (_) { GlattLeads.fail('CONFIG_ERROR'); }
  return {sheetId:p.SHEET_ID, sheetName:p.SHEET_NAME, secret:p.HMAC_SECRET,
    origins:origins, recipient:p.NOTIFICATION_EMAIL.trim(), enabled:p.ENABLED === 'true'};
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function hash_(value) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}
function equalSignature_(a, b) {
  if (typeof b !== 'string' || !/^[a-f0-9]{64}$/i.test(b)) return false;
  b = b.toLowerCase();
  var difference = 0;
  for (var i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function verify_(raw, cfg) {
  if (typeof raw !== 'string' || raw.length > 24576 || Utilities.newBlob(raw).getBytes().length > 24576) GlattLeads.fail('INVALID_INPUT');
  var envelope;
  try { envelope = JSON.parse(raw); } catch (_) { GlattLeads.fail('INVALID_INPUT'); }
  if (!envelope || envelope.version !== 1 || envelope.environment !== 'preview' ||
      !Number.isSafeInteger(envelope.timestamp) || typeof envelope.payload !== 'string') GlattLeads.fail('AUTH_FAILED');
  GlattLeads.requestId(envelope.requestId);
  // Old captures are rejected; a legitimate retry gets a fresh timestamp/signature from the Worker.
  var age = Date.now() - envelope.timestamp;
  if (age > 300000 || age < -30000) GlattLeads.fail('AUTH_FAILED');
  var expected = hex_(Utilities.computeHmacSha256Signature(GlattLeads.signingText(envelope), cfg.secret, Utilities.Charset.UTF_8));
  if (!equalSignature_(expected, envelope.signature)) GlattLeads.fail('AUTH_FAILED');
  var payload;
  try { payload = JSON.parse(envelope.payload); } catch (_) { GlattLeads.fail('INVALID_INPUT'); }
  if (!payload || !GlattLeads.allowedOrigin(payload.origin, cfg.origins)) GlattLeads.fail('INVALID_INPUT');
  GlattLeads.spam(payload);
  var lead = GlattLeads.lead(payload.lead, payload.origin);
  return {requestId:envelope.requestId.toLowerCase(), lead:lead,
    hash:hash_(JSON.stringify({origin:payload.origin, lead:lead}))};
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) GlattLeads.fail('BUSY');
  try { return fn(); } finally { lock.releaseLock(); }
}
function sheet_(cfg) {
  var sheet = SpreadsheetApp.openById(cfg.sheetId).getSheetByName(cfg.sheetName);
  if (!sheet || JSON.stringify(sheet.getRange(1, 1, 1, LEAD_HEADERS.length).getValues()[0]) !== JSON.stringify(LEAD_HEADERS)) GlattLeads.fail('SHEET_NOT_READY');
  return sheet;
}
function findRow_(sheet, column, value) {
  var letter = String.fromCharCode(65 + column);
  var values = readCells_(sheet, letter + '2:' + letter);
  for (var i = 0; i < values.length; i++) if (values[i][0] === value) return i + 2;
  return null;
}
function readCells_(sheet, range) {
  // Read through the same API used for RAW writes; avoid SpreadsheetApp's read cache
  // hiding a just-appended row or an updated notification lease in this execution.
  return Sheets.Spreadsheets.Values.get(sheet.getParent().getId(), "'" + sheet.getName() + "'!" + range,
    {valueRenderOption:'UNFORMATTED_VALUE'}).values || [];
}
function row_(sheet, rowNumber) {
  var values = readCells_(sheet, 'A' + rowNumber + ':R' + rowNumber)[0] || [];
  return LEAD_HEADERS.map(function (_, i) { return values[i] === undefined ? '' : values[i]; });
}

function saveLead_(submission, cfg) {
  return locked_(function () {
    var sheet = sheet_(cfg);
    var existing = findRow_(sheet, COL.requestId, submission.requestId);
    if (existing) {
      var previous = row_(sheet, existing);
      if (previous[COL.hash] !== submission.hash) GlattLeads.fail('ID_CONFLICT');
      // A replay can only acknowledge the existing row, never write or resend an email.
      return {leadId:previous[COL.leadId], duplicate:true};
    }
    var lead = submission.lead;
    var leadId = Utilities.getUuid();
    var values = [
      Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm:ss'),
      lead.name, lead.phone, lead.email, lead.background, lead.process, lead.page, 'חדש', leadId,
      submission.requestId, submission.hash, 'pending', 0, '', Date.now(), '', '', ''
    ];
    // RAW preserves phone numbers as text and prevents ANY submitted text becoming a formula.
    // Enable the Advanced Google Sheets service; do not replace this with appendRow/setValues.
    Sheets.Spreadsheets.Values.append({values:[values]}, cfg.sheetId, "'" + cfg.sheetName + "'!A:R", {
      valueInputOption:'RAW', insertDataOption:'INSERT_ROWS'
    });
    SpreadsheetApp.flush();
    var savedRow = findRow_(sheet, COL.requestId, submission.requestId);
    if (!savedRow) GlattLeads.fail('STORAGE_ERROR');
    var saved = row_(sheet, savedRow);
    if (saved[COL.hash] !== submission.hash || saved[COL.leadId] !== leadId) GlattLeads.fail('STORAGE_ERROR');
    return {leadId:leadId, duplicate:false};
  });
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function doPost(e) {
  try {
    var cfg = config_();
    if (!cfg.enabled) GlattLeads.fail('UNAVAILABLE');
    if (!e || !e.postData || !/^application\/json(?:;|$)/i.test(e.postData.type || '')) GlattLeads.fail('INVALID_INPUT');
    var submission = verify_(e.postData.contents, cfg);
    var saved = saveLead_(submission, cfg);
    // The durable pending state exists before sending. Notification failures never undo the lead.
    if (!saved.duplicate) {
      try { notifyLead_(saved.leadId, cfg); } catch (_) { /* pending/lease is recovered by the retry trigger */ }
    }
    return json_({ok:true, saved:true, requestId:submission.requestId, leadId:saved.leadId});
  } catch (error) {
    var safe = ['INVALID_INPUT','INVALID_REQUEST_ID','SPAM_REJECTED','AUTH_FAILED','ID_CONFLICT','BUSY','CONFIG_ERROR','SHEET_NOT_READY','UNAVAILABLE'];
    return json_({ok:false, code:safe.indexOf(error.code) >= 0 ? error.code : 'STORAGE_ERROR'});
  }
}
function doGet() {
  // No public lead listing, status lookup, configuration disclosure or notification retry endpoint.
  return json_({ok:false, code:'METHOD_NOT_ALLOWED'});
}

function writeMailState_(sheet, number, values) {
  Sheets.Spreadsheets.Values.update({values:[values.slice(COL.mailStatus)]}, sheet.getParent().getId(),
    "'" + sheet.getName() + "'!L" + number + ':R' + number, {valueInputOption:'RAW'});
}
function claimNotification_(leadId, cfg) {
  return locked_(function () {
    var sheet = sheet_(cfg);
    var number = findRow_(sheet, COL.leadId, leadId);
    if (!number) return null;
    var values = row_(sheet, number);
    var state = values[COL.mailStatus];
    var now = Date.now();
    if (state === 'sent' || state === 'failed' || Number(values[COL.nextAttempt]) > now) return null;
    if (Number(values[COL.attempts]) >= MAX_ATTEMPTS) {
      values[COL.mailStatus] = 'failed';
      values[COL.error] = 'RETRY_LIMIT';
      writeMailState_(sheet, number, values);
      return null;
    }
    if (MailApp.getRemainingDailyQuota() < 1) {
      values[COL.mailStatus] = 'retry';
      values[COL.error] = 'EMAIL_QUOTA';
      values[COL.nextAttempt] = now + 60 * 60 * 1000;
      values[COL.lease] = '';
      writeMailState_(sheet, number, values);
      return null;
    }
    values[COL.mailStatus] = 'sending';
    values[COL.attempts] = Number(values[COL.attempts]) + 1;
    values[COL.lastAttempt] = new Date(now).toISOString();
    values[COL.nextAttempt] = now + MAIL_LEASE_MS;
    values[COL.error] = '';
    values[COL.lease] = Utilities.getUuid();
    writeMailState_(sheet, number, values);
    return {values:values, lease:values[COL.lease], sheetGid:sheet.getSheetId()};
  });
}
function notification_(claim, cfg) {
  var v = claim.values;
  var labels = ['תאריך ושעה (ישראל)', 'שם מלא', 'טלפון', 'אימייל', 'רקע טכנולוגי', 'תהליך לאוטומציה', 'כתובת העמוד', 'סטטוס טיפול', 'מזהה פנייה'];
  var details = labels.map(function (label, i) { return label + ': ' + (v[i] || 'לא נמסר'); });
  var whatsapp = 'https://wa.me/' + String(v[COL.phone]).replace(/\D/g, '');
  var sheetUrl = 'https://docs.google.com/spreadsheets/d/' + cfg.sheetId + '/edit#gid=' + claim.sheetGid;
  return {
    to:cfg.recipient, subject:'[Glatt AI Preview] פנייה חדשה — ' + v[COL.leadId],
    body:details.join('\n') + '\n\nWhatsApp: ' + whatsapp + '\nGoogle Sheets: ' + sheetUrl,
    htmlBody:'<div dir="rtl">' + details.map(function (line) { return '<p>' + GlattLeads.html(line).replace(/\n/g, '<br>') + '</p>'; }).join('') +
      '<p><a href="' + whatsapp + '">פתיחת שיחה ב־WhatsApp</a></p>' +
      '<p><a href="' + GlattLeads.html(sheetUrl) + '">פתיחת גיליון הפניות</a></p></div>'
  };
}
function finishNotification_(leadId, claim, sent, cfg) {
  locked_(function () {
    var sheet = sheet_(cfg);
    var number = findRow_(sheet, COL.leadId, leadId);
    if (!number) return;
    var v = row_(sheet, number);
    if (v[COL.lease] !== claim.lease || v[COL.mailStatus] !== 'sending') return;
    v[COL.mailStatus] = sent ? 'sent' : (Number(v[COL.attempts]) >= MAX_ATTEMPTS ? 'failed' : 'retry');
    v[COL.error] = sent ? '' : 'MAIL_SEND_FAILED';
    v[COL.sentAt] = sent ? new Date().toISOString() : '';
    v[COL.nextAttempt] = sent ? '' : Date.now() + Math.min(3600000, 300000 * Math.pow(2, Number(v[COL.attempts]) - 1));
    v[COL.lease] = '';
    writeMailState_(sheet, number, v);
  });
}
function notifyLead_(leadId, cfg) {
  var claim = claimNotification_(leadId, cfg);
  if (!claim) return;
  var sent = false;
  try { MailApp.sendEmail(notification_(claim, cfg)); sent = true; }
  catch (_) { /* Store a fixed code, never the exception (which may contain personal data). */ }
  finishNotification_(leadId, claim, sent, cfg);
}

function retryNotifications() {
  try {
    var cfg = config_();
    if (!cfg.enabled) return;
    var sheet = sheet_(cfg);
    var rows = readCells_(sheet, 'A2:R');
    var started = Date.now();
    var processed = 0;
    for (var i = 0; i < rows.length && processed < 10 && Date.now() - started < 60000; i++) {
      var v = rows[i];
      if (['pending','retry','sending'].indexOf(v[COL.mailStatus]) < 0 || Number(v[COL.nextAttempt]) > Date.now()) continue;
      try { notifyLead_(v[COL.leadId], cfg); } catch (_) { /* leave durable state for the next run */ }
      processed++;
    }
  } catch (_) { throw new Error('LEAD_RETRY_SETUP_OR_STORAGE_ERROR'); }
}

// Editor-only operation: queue exhausted notifications again, then let the trigger send them.
function requeueFailedNotifications() {
  try {
    var cfg = config_();
    locked_(function () {
      var sheet = sheet_(cfg);
      var rows = readCells_(sheet, 'A2:R');
      for (var i = 0; i < rows.length; i++) {
        var v = rows[i];
        if (v[COL.mailStatus] !== 'failed') continue;
        v[COL.mailStatus] = 'pending'; v[COL.attempts] = 0;
        v[COL.nextAttempt] = Date.now(); v[COL.error] = ''; v[COL.lease] = '';
        while (v.length < LEAD_HEADERS.length) v.push('');
        writeMailState_(sheet, i + 2, v);
      }
    });
  } catch (_) { throw new Error('LEAD_REQUEUE_ERROR'); }
}

// Run manually once after setting Script Properties. Never callable through doPost.
function setupLeads() {
  try {
    var cfg = config_();
    locked_(function () {
      var book = SpreadsheetApp.openById(cfg.sheetId);
      book.setSpreadsheetTimeZone('Asia/Jerusalem');
      var sheet = book.getSheetByName(cfg.sheetName) || book.insertSheet(cfg.sheetName);
      if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, LEAD_HEADERS.length).setValues([LEAD_HEADERS]);
      SpreadsheetApp.flush();
      sheet_(cfg); // Reject an existing, incompatible schema rather than overwriting it.
      sheet.setFrozenRows(1);
      sheet.setRightToLeft(true);
      sheet.getRange(1, 1, 1, LEAD_HEADERS.length).setFontWeight('bold');
      // Confirm the advanced service is enabled without submitting or emailing a lead.
      Sheets.Spreadsheets.Values.get(cfg.sheetId, "'" + cfg.sheetName + "'!A1:R1");
      if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'retryNotifications'; })) {
        ScriptApp.newTrigger('retryNotifications').timeBased().everyMinutes(5).create();
      }
    });
  } catch (_) { throw new Error('LEAD_SETUP_ERROR_CHECK_PROPERTIES_PERMISSIONS_AND_SHEETS_SERVICE'); }
}
