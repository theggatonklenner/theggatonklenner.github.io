// Tests the "cb" Edge Function (coloured belt booking links and texts) against an in-memory stand-in for Supabase.
// Run: node tests/cb-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'cb-')), 'cb.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/cb/index.ts'), 'utf8'));
const { handle, phoneE164 } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- In-memory tables ----
const TOKEN = 'a'.repeat(64), TOKEN2 = 'b'.repeat(64);
const t = {
  cb_entries: [{ entry_id: 'e1', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN, booked_at: null, booking_error: null, result: null, invited_at: null },
               { entry_id: 'e2', day_id: 'd2', member_key: 'efc:m2', full_name: 'Kim Ng', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: TOKEN2, booked_at: null, booking_error: null, result: null, invited_at: null }],
  cb_days: [{ day_id: 'd1', location: 'Marrickville', grading_date: '2026-11-14', start_time: '10:00:00', efc_session_id: 'sess-1', closed: false },
            { day_id: 'd2', location: 'Sydenham', grading_date: '2026-11-15', start_time: null, efc_session_id: null, closed: true }],
  cb_belts: [{ belt: 'Yellow Belt', fee: 55 }, { belt: 'White Belt', fee: null }],
  cb_settings: [{ id: 1, booking_webhook: null }],
  efc_members: [{ member_key: 'efc:m1', efc_reference: 'AU-023-1', full_name: 'Sam Lee', guardian_name: 'Pat Lee', phone: '0412 345 678', guardian_phone: null, email: 'pat@example.test', guardian_email: null },
                { member_key: 'efc:m2', efc_reference: 'AU-256-2', full_name: 'Kim Ng', guardian_name: 'Jo Ng', phone: null, guardian_phone: null, email: null, guardian_email: null }],
  prep_roles: [{ email: 'grader@ama.test', role: 'grading' }, { email: 'coach@ama.test', role: 'instructor' }, { email: 'desk@ama.test', role: 'attendance' }],
  cb_messages: []
};
const db = {
  from(table) {
    let filters = [], op = 'select', payload = null, single = false;
    const q = {
      select() { return q; }, eq(c, v) { filters.push(r => r[c] === v); return q; }, maybeSingle() { single = true; return q; },
      update(p) { op = 'update'; payload = p; return q; }, insert(p) { op = 'insert'; payload = p; return q; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          const rows = t[table].filter(r => filters.every(f => f(r)));
          if (op === 'update') { rows.forEach(r => Object.assign(r, payload)); return { data: null, error: null }; }
          if (op === 'insert') { t[table].push({ ...payload }); return { data: null, error: null }; }
          return { data: single ? rows[0] || null : rows, error: null };
        }).then(res, rej);
      }
    };
    return q;
  },
  auth: { async getUser(tok) { const email = { 'tok-grader': 'grader@ama.test', 'tok-coach': 'coach@ama.test', 'tok-desk': 'desk@ama.test' }[tok]; return { data: { user: email ? { email } : null } }; } }
};
const hooks = [];
let hookStatus = 200;
const http = async (url, opts) => {
  if (url.startsWith('https://hooks.zapier.com/')) { hooks.push(JSON.parse(opts.body)); return new Response('{"status":"success"}', { status: hookStatus }); }
  throw new Error('unexpected ' + url);
};
const call = async (body, tok, env = {}) => {
  const res = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) }), db, env, http);
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('Booking links (no sign-in)');
let r = await call({ action: 'info', token: TOKEN });
ok(r.status === 200 && r.body.first === 'Sam' && r.body.belt_to === 'Orange Belt' && r.body.school === 'Marrickville' && r.body.time === '10:00' && r.body.fee === 55 && !r.body.booked, 'a booking link shows the first name, belt, school, time and fee');
ok(!JSON.stringify(r.body).includes('0412') && !JSON.stringify(r.body).includes('Lee'), '...and nothing private (no surname or phone)');
r = await call({ action: 'info', token: 'nope' });
ok(r.status === 404 && /isn't valid/.test(r.body.error), 'a wrong link is refused');
r = await call({ action: 'book', token: TOKEN });
ok(r.body.ok === false && /isn't set up/.test(r.body.error) && !hooks.length, 'without a booking Zap saved, it says booking is not set up');
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
hookStatus = 500;
r = await call({ action: 'book', token: TOKEN });
ok(r.status === 502 && t.cb_entries[0].booking_error && !t.cb_entries[0].booked_at, 'if Zapier fails, it is not marked booked and the error is kept for staff');
hookStatus = 200;
r = await call({ action: 'book', token: TOKEN });
const h = hooks[hooks.length - 1];
ok(r.body.ok && r.body.booked && t.cb_entries[0].booked_at && !t.cb_entries[0].booking_error, 'pressing Book marks it booked');
ok(h.member_id === 'm1' && h.efc_ref === 'AU-023-1' && h.date === '2026-11-14' && h.session_id === 'sess-1' && h.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58' && h.belt_to === 'Orange Belt', 'the Zap gets the EFC member ID, date, session and location to book');
const n = hooks.length;
r = await call({ action: 'book', token: TOKEN });
ok(r.body.booked && hooks.length === n, 'booking twice does not book again');
r = await call({ action: 'book', token: TOKEN2 });
ok(r.body.ok === false && /finished/.test(r.body.error), 'a finished grading cannot be booked');
t.cb_settings[0].booking_webhook = 'https://evil.test/steal';
r = await call({ action: 'info', token: TOKEN2 });
ok(r.body.first === 'Kim', 'a link still opens when the day has no EFC session ID');

console.log('\nTexts (staff)');
r = await call({ action: 'send', kind: 'invite', items: [{ member_key: 'efc:m1', body: 'hi' }] });
ok(r.status === 401, 'staff actions need a sign-in');
r = await call({ action: 'check' }, 'tok-desk');
ok(r.status === 403, 'attendance-only staff cannot use it');
r = await call({ action: 'send', kind: 'invite', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'hi' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.status === 403, 'instructors cannot send invitations');
r = await call({ action: 'send', kind: 'not_ready', items: [{ member_key: 'efc:m1', body: 'Keep going' }] }, 'tok-coach');
ok(r.status === 409 && /not set up/.test(r.body.error), 'without GoHighLevel set up, it says so');
r = await call({ action: 'send', kind: 'not_ready', items: [{ member_key: 'efc:m1', body: 'Keep going' }, { member_key: 'efc:m2', body: 'Keep going' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.body.sent === 1 && r.body.testing && r.body.results[1].error === 'No mobile number', 'instructors can send "not yet" messages; a student with no mobile is reported');
ok(t.cb_messages.some(m => m.kind === 'not_ready' && m.status === 'test' && m.phone === '+61412345678' && m.sent_by === 'coach@ama.test'), 'each text is logged with who sent it');
r = await call({ action: 'send', kind: 'invite', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'You are invited' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1 && t.cb_entries[0].invited_at, 'an invitation marks the student invited');
r = await call({ action: 'send', kind: 'party', items: [] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.status === 400, 'unknown kinds are refused');
ok(phoneE164('0412 345 678') === '+61412345678' && phoneE164('+61 412 345 678') === '+61412345678' && phoneE164('12') === null, 'mobiles are turned into +61 form');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
