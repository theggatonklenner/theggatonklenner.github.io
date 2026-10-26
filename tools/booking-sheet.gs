// AMA Gradings: booking sheet.
// When a family pays for a grading or presses Book, the Gradings app adds a row to this sheet. A Zap
// (trigger: Google Sheets "New Spreadsheet Row", action: EFC Aquila "Book Session") then books the EFC session.
//
// Set up (once):
// 1. Make a new Google Sheet (e.g. "AMA grading bookings"). Leave it empty: the headings are added on the first booking.
// 2. Extensions > Apps Script. Delete what's there, paste this whole file, and put the key from
//    Gradings > Settings > Booking sheet between the quotes on the KEY line below. Save.
// 3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy, allow access,
//    and copy the Web app URL (https://script.google.com/macros/s/.../exec).
// 4. Paste that URL into Gradings > Settings > Booking sheet, and Save.
// 5. In Zapier: trigger Google Sheets "New Spreadsheet Row" (this sheet, first tab), action EFC Aquila "Book Session":
//    Location = location_id, Date = date, Member ID = member_id, Session = session_id. Turn it on.
// "Anyone" can reach the URL, but rows are only added with the right key, and the URL itself is long and private.

const KEY = 'PASTE-THE-KEY-FROM-GRADINGS-SETTINGS';
const COLUMNS = ['received_at', 'member_id', 'efc_ref', 'student', 'date', 'session_id', 'location_id', 'location', 'belt_to', 'programme', 'paid', 'paid_how'];

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'Not JSON' }); }
  if (!KEY || KEY.indexOf('PASTE') === 0 || d.key !== KEY) return reply({ ok: false, error: 'Wrong key' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);
    d.received_at = new Date();
    d.paid = d.paid ? 'Yes' : 'No';
    sheet.appendRow(COLUMNS.map(c => (d[c] === undefined || d[c] === null) ? '' : d[c]));
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
