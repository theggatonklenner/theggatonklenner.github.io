// Tests the "cb" Edge Function (coloured belt booking links and texts) against an in-memory stand-in for Supabase.
// Run: node tests/cb-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(mkdtempSync(join(tmpdir(), 'cb-')), 'cb.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/cb/index.ts'), 'utf8'));
const { handle, phoneE164, signatureOk, backTo } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- In-memory tables ----
const TOKEN = 'a'.repeat(64), TOKEN2 = 'b'.repeat(64);
const t = {
  cb_entries: [{ entry_id: 'e1', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN, booked_at: null, booking_error: null, result: null, invited_at: null },
               { entry_id: 'e2', day_id: 'd2', member_key: 'efc:m2', full_name: 'Kim Ng', belt_from: 'White Belt', belt_to: 'Yellow Belt', token: TOKEN2, booked_at: null, booking_error: null, result: null, invited_at: null }],
  cb_days: [{ day_id: 'd1', location: 'Marrickville', grading_date: '2026-11-14', start_time: '10:00:00', efc_session_id: 'sess-1', closed: false },
            { day_id: 'd2', location: 'Sydenham', grading_date: '2026-11-15', start_time: null, efc_session_id: null, closed: true }],
  cb_belts: [{ programme: 'Taekwondo', belt: 'Yellow Belt', fee: 55 }, { programme: 'Taekwondo', belt: 'White Belt', fee: null }, { programme: 'Kung Fu', belt: 'Yellow Belt', fee: 99 }],
  cb_settings: [{ id: 1, booking_webhook: null }],
  efc_members: [{ member_key: 'efc:m1', efc_reference: 'AU-023-1', full_name: 'Sam Lee', guardian_name: 'Pat Lee', phone: '0412 345 678', guardian_phone: null, email: 'pat@example.test', guardian_email: null },
                { member_key: 'efc:m2', efc_reference: 'AU-256-2', full_name: 'Kim Ng', guardian_name: 'Jo Ng', phone: null, guardian_phone: null, email: null, guardian_email: null }],
  prep_roles: [{ email: 'grader@ama.test', role: 'grading' }, { email: 'coach@ama.test', role: 'instructor' }, { email: 'desk@ama.test', role: 'attendance' }],
  cb_messages: [],
  cb_payments: []
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
  // The nightly clean-up's database helpers
  async rpc(name, args) {
    if (name === 'cb_cron_ok') return { data: args.p_secret === 'night-secret', error: null };
    if (name === 'cb_old_photos') return { data: oldPhotos.slice(), error: null };
    if (name === 'cb_photos_removed') { let n = 0; for (const e of t.cb_entries) if (args.p_names.includes(e.photo_path)) { e.photo_path = null; e.photo_removed_at = 'now'; n++; } return { data: n, error: null }; }
    return { data: null, error: { message: 'no rpc ' + name } };
  },
  storage: { from(bucket) { return { async remove(names) { removedFiles.push(...names.map(n => bucket + '/' + n)); return { data: [], error: null }; }, async createSignedUrl(path, secs, opts) { signed.push({ bucket, path, secs, opts }); return { data: { signedUrl: `https://store.test/${bucket}/${path}?ttl=${secs}${opts && opts.download ? '&download=' + opts.download : ''}` }, error: null }; } }; } },
  auth: { async getUser(tok) { const email = { 'tok-grader': 'grader@ama.test', 'tok-coach': 'coach@ama.test', 'tok-desk': 'desk@ama.test' }[tok]; return { data: { user: email ? { email } : null } }; } }
};
const signed = [], removedFiles = [], oldPhotos = [];
const hooks = [];
let hookStatus = 200;
// Stripe stand-in: Checkout sessions are created here and can be marked paid
const stripeCalls = [], stripeSessions = {}, sheetRows = [], ghlCalls = [];
let nextSess = 1;
const http = async (url, opts) => {
  if (url.startsWith('https://script.google.com/')) { const b = JSON.parse(opts.body); sheetRows.push(b); return new Response(JSON.stringify(b.key === 'sheet-key' ? { ok: true } : { ok: false, error: 'Wrong key' }), { status: 200 }); }
  if (url.startsWith('https://hooks.zapier.com/')) { hooks.push(JSON.parse(opts.body)); return new Response('{"status":"success"}', { status: hookStatus }); }
  if (url.startsWith('https://services.leadconnectorhq.com/')) {
    ghlCalls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('/contacts/search/duplicate')) return new Response(JSON.stringify({ contact: { id: 'c-1' } }), { status: 200 });
    return new Response(JSON.stringify({ messageId: 'm-' + ghlCalls.length }), { status: 200 });
  }
  if (url.startsWith('https://api.stripe.com/v1/payment_intents/')) { const id = decodeURIComponent(url.split('/').pop().split('?')[0]); return new Response(JSON.stringify({ id, latest_charge: { receipt_url: 'https://pay.stripe.test/receipts/' + id } }), { status: 200 }); }
  if (url.startsWith('https://api.stripe.com/v1/checkout/sessions')) {
    stripeCalls.push({ url, method: opts.method, body: opts.body ? decodeURIComponent(opts.body) : '', auth: opts.headers.Authorization });
    if (opts.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(opts.body));
      const id = 'cs_test_' + nextSess++;
      stripeSessions[id] = { id, url: 'https://checkout.stripe.test/' + id, payment_status: 'unpaid', amount_total: Number(f['line_items[0][price_data][unit_amount]']), metadata: { kind: f['metadata[kind]'], entry_id: f['metadata[entry_id]'] }, client_reference_id: f.client_reference_id, payment_intent: 'pi_' + id, _form: f };
      return new Response(JSON.stringify(stripeSessions[id]), { status: 200 });
    }
    const id = decodeURIComponent(url.split('/').pop());
    return new Response(JSON.stringify(stripeSessions[id] || {}), { status: stripeSessions[id] ? 200 : 404 });
  }
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
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
r = await call({ action: 'book', token: TOKEN }, null, { STRIPE_SECRET_KEY: 'sk_test_x' });
ok(r.body.ok === false && /pay the grading fee by card/.test(r.body.error) && !t.cb_entries[0].booked_at && !hooks.length, 'with a fee, the link can\'t book without paying by card (no "pay at the desk")');
r = await call({ action: 'book', token: TOKEN });
ok(r.body.ok === false && /call us/.test(r.body.error), '...and without card payments set up, it says to call');
t.cb_settings[0].booking_webhook = null;
t.cb_belts[0].fee = null;   // no fee: the link books straight away (the booking tests below)
r = await call({ action: 'info', token: 'nope' });
ok(r.status === 404 && /isn't valid/.test(r.body.error) && /9569 1943/.test(r.body.error), 'a wrong or replaced link is refused, with the number to call');
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
ok(h.member_id === 'm1' && h.efc_ref === 'AU-023-1' && h.date === '2026-11-14' && h.session_id === 'sess-1' && h.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58' && h.belt_to === 'Orange Belt' && h.programme === 'Taekwondo', 'the Zap gets the EFC member ID, date, session and location to book');
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
r = await call({ action: 'send', kind: 'reminder', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'See you Saturday' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1 && t.cb_messages.some(m => m.kind === 'reminder'), 'grading staff can send the newer texts (reminders, fee, re-test)');
r = await call({ action: 'send', kind: 'unpaid', items: [{ member_key: 'efc:m1', body: 'Fee' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.status === 403, '...instructors cannot send fee reminders');
r = await call({ action: 'send', kind: 'party', items: [] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.status === 400, 'unknown kinds are refused');
ok(phoneE164('0412 345 678') === '+61412345678' && phoneE164('+61 412 345 678') === '+61412345678' && phoneE164('12') === null, 'mobiles are turned into +61 form');


console.log('\nGrading photo links (no sign-in)');
r = await call({ action: 'photo', token: 'nope' });
ok(r.status === 404 && /isn't valid/.test(r.body.error), 'a wrong photo link is refused');
r = await call({ action: 'photo', token: TOKEN });
ok(r.body.ok && r.body.first === 'Sam' && r.body.photo === false && /isn't ready/.test(r.body.error) && !signed.length, 'before the photo is taken, the link says it is not ready yet');
t.cb_entries[0].photo_path = 'd1/e1-1.jpg'; t.cb_entries[0].photo_code = 'Ab3dE9xYz1';
r = await call({ action: 'photo', code: 'Ab3dE9xYz1' });
ok(r.body.photo && r.body.first === 'Sam', 'the short code from a photo text finds the photo');
r = await call({ action: 'photo', code: 'Zz9zZz9zZz' });
ok(r.status === 404, 'a wrong short code is refused');
r = await call({ action: 'photo', code: "x' or 1=1" });
ok(r.status === 404, 'a malformed code is refused');
r = await call({ action: 'photo', token: TOKEN });
ok(r.body.photo && r.body.url.startsWith('https://store.test/grading-photos/d1/e1-1.jpg') && /download=Sam-Lee-AMA-grading\.jpg/.test(r.body.download), 'with a photo, the family gets a short-lived link to view it and one to save it');
ok(signed.every(x => x.bucket === 'grading-photos' && x.secs <= 3600), '...the links come from the private bucket and last an hour at most');
ok(!JSON.stringify(r.body).includes('0412') && r.body.school === 'Marrickville', '...and nothing private comes back');
r = await call({ action: 'send', kind: 'photo', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'Your photo' }] }, 'tok-coach', { GHL_TEST: '1' });
ok(r.status === 403, 'instructors cannot text photos');
r = await call({ action: 'send', kind: 'photo', items: [{ member_key: 'efc:m1', entry_id: 'e1', body: 'Your photo' }] }, 'tok-grader', { GHL_TEST: '1' });
ok(r.body.sent === 1 && t.cb_messages.some(m => m.kind === 'photo' && m.entry_id === 'e1'), 'grading staff can text photo links, and each is logged');


console.log('\nPhotos removed after 30 days');
const callCron = async (secret) => { const res = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-cb-cron': secret } : {}) }, body: JSON.stringify({ action: 'cleanup' }) }), db, {}, http); return { status: res.status, body: await res.json() }; };
r = await callCron(null);
ok(r.status === 403 && !removedFiles.length, 'the clean-up refuses anyone without the nightly secret');
r = await callCron('guess');
ok(r.status === 403, '...or with the wrong one');
oldPhotos.push('d1/e1-1.jpg', 'd1/old-retake.jpg');
r = await callCron('night-secret');
ok(r.body.ok && r.body.removed === 2 && removedFiles.join() === 'grading-photos/d1/e1-1.jpg,grading-photos/d1/old-retake.jpg', 'it deletes photos older than 30 days from storage (including old retakes)');
ok(t.cb_entries[0].photo_path === null && t.cb_entries[0].photo_removed_at && r.body.cleared === 1, '...and marks the student\'s photo as removed');
r = await call({ action: 'photo', code: 'Ab3dE9xYz1' });
ok(r.body.ok && r.body.removed && !r.body.photo && /kept for 30 days/.test(r.body.error), 'the family\'s link then says the photo was removed after 30 days');


console.log('\nPay by card, then book (Stripe)');
t.cb_belts[0].fee = 55;
const TOKEN3 = 'c'.repeat(64), TOKEN4 = 'd'.repeat(64);
t.cb_entries.push({ entry_id: 'e3', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN3, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null },
                  { entry_id: 'e4', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN4, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET_GRADING: 'whsec_grading' };
r = await call({ action: 'info', token: TOKEN3 });
ok(r.body.card === false && r.body.fee === 55, 'without Stripe set up, the booking page doesn\'t offer card payment');
r = await call({ action: 'pay', token: TOKEN3 });
ok(r.status === 409 && /front desk/.test(r.body.error), '...and paying by card says to pay at the front desk');
r = await call({ action: 'info', token: TOKEN3 }, null, STRIPE_ENV);
ok(r.body.card === true && r.body.paid === false && r.body.booked === false, 'with Stripe set up and a fee, the family can pay by card');
r = await call({ action: 'pay', token: TOKEN3, back: 'https://evil.test/steal' }, null, STRIPE_ENV);
const cs = stripeSessions[Object.keys(stripeSessions).pop()];
ok(cs._form.customer_email === 'pat@example.test' && cs._form['payment_intent_data[receipt_email]'] === 'pat@example.test', 'Stripe is given the family\'s email from EFC, so it emails them a receipt');
ok(r.body.ok && r.body.url === cs.url && cs.amount_total === 5500 && cs._form['line_items[0][price_data][currency]'] === 'aud' && cs.metadata.kind === 'grading' && cs.metadata.entry_id === 'e3', 'Pay sends them to Stripe for the belt\'s fee ($55, AUD), tagged as a grading payment');
ok(cs._form.success_url === 'https://theggatonklenner.github.io/grading/coloured-belts/book/?paid=1#t=' + TOKEN3 && !cs._form.success_url.includes('evil'), '...and Stripe only sends them back to AMA\'s own booking page');
ok(backTo('https://app.australianmartialarts.com.au/grading/coloured-belts/book/') === 'https://app.australianmartialarts.com.au/grading/coloured-belts/book/', '...including on the AMA domain later');
ok(t.cb_payments.length === 1 && t.cb_payments[0].status === 'pending' && t.cb_payments[0].amount === 55 && !t.cb_entries.find(e => e.entry_id === 'e3').paid, 'a pending payment is recorded; they are not paid until Stripe says so');
const before = hooks.length;
const hook = async (obj, secret = 'whsec_grading', type = 'checkout.session.completed') => {
  const raw = JSON.stringify({ type, data: { object: obj } }), ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigHex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '.' + raw)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const res = await handle(new Request('https://x.test/functions/v1/cb', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sigHex}` }, body: raw }), db, STRIPE_ENV, http);
  return { status: res.status, body: await res.json() };
};
r = await hook({ ...cs, payment_status: 'paid' }, 'whsec_wrong');
ok(r.status === 400 && !t.cb_entries.find(e => e.entry_id === 'e3').paid, 'a webhook with the wrong signature is refused');
r = await hook({ ...cs, payment_status: 'paid' });
const e3 = t.cb_entries.find(e => e.entry_id === 'e3');
ok(r.body.received && e3.paid && e3.paid_how === 'card' && t.cb_payments[0].status === 'paid' && t.cb_payments[0].amount === 55, 'when Stripe confirms the payment, they are marked paid by card');
ok(t.cb_payments[0].receipt_url === 'https://pay.stripe.test/receipts/pi_' + cs.id, '...and Stripe\'s receipt is kept');
r = await call({ action: 'info', token: TOKEN3 }, null, STRIPE_ENV);
ok(r.body.receipt === t.cb_payments[0].receipt_url, 'the booking page links to the receipt');
ok(e3.booked_at && hooks.length === before + 1 && hooks[hooks.length - 1].paid === true && hooks[hooks.length - 1].session_id === 'sess-1' && hooks[hooks.length - 1].member_id === 'm1', '...and the Zap is sent the booking (member, session, school, date) straight away');
r = await hook({ ...cs, payment_status: 'paid' });
ok(hooks.length === before + 1 && t.cb_payments.length === 1, 'Stripe sending the same payment twice does not book twice');
r = await call({ action: 'pay', token: TOKEN3 }, null, STRIPE_ENV);
ok(r.body.ok === false && /already paid/.test(r.body.error), 'a paid grading cannot be paid again');
r = await hook({ id: 'cs_polo', payment_status: 'paid', metadata: { order_id: 'o1' } });
ok(r.body.received && t.cb_payments.length === 1, 'polo shirt payments are ignored here');
// Coming back from Stripe before the webhook arrives
r = await call({ action: 'pay', token: TOKEN4 }, null, STRIPE_ENV);
const cs4 = stripeSessions[Object.keys(stripeSessions).pop()];
cs4.payment_status = 'paid'; hookStatus = 500;
r = await call({ action: 'info', token: TOKEN4 }, null, STRIPE_ENV);
const e4 = t.cb_entries.find(e => e.entry_id === 'e4');
ok(r.body.paid && e4.paid_how === 'card', 'coming back from Stripe, the page checks with Stripe and shows it paid (even before the webhook)');
ok(!e4.booked_at && e4.booking_error && r.body.booking_failed, '...and if the Zap fails, it stays paid and the page says the booking needs doing (staff see the error)');
hookStatus = 200;



console.log('\nPayments taken by staff (cash, EFTPOS)');
const TOKEN7 = '7'.repeat(64);
t.cb_entries.push({ entry_id: 'e7', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN7, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
const staffCall = (b, tok) => call(b, tok, {});
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'cash' }, 'tok-coach');
ok(r.status === 403, 'instructors cannot record payments');
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'bitcoin' }, 'tok-grader');
ok(r.status === 400, 'the payment type must be cash, EFTPOS, bank transfer or other');
const hb = hooks.length;
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'eftpos' }, 'tok-grader');
const e7 = t.cb_entries.find(e => e.entry_id === 'e7');
ok(r.body.ok && r.body.booked && e7.paid && e7.paid_how === 'eftpos' && e7.booked_at && hooks.length === hb + 1, 'grading staff record an EFTPOS payment: marked paid and booked into the EFC session');
r = await staffCall({ action: 'record_payment', entry_id: 'e7', how: 'cash' }, 'tok-grader');
ok(r.body.already && hooks.length === hb + 1 && e7.paid_how === 'eftpos', 'recording it twice changes nothing');
t.cb_belts[0].fee = null;

console.log('\nBooking sheet (Google Sheets, then a Zap books from new rows)');
const TOKEN5 = 'f'.repeat(64);
t.cb_entries.push({ entry_id: 'e5', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN5, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
t.cb_settings[0].booking_webhook = 'https://script.google.com/macros/s/AKfycbx-Test_123/exec'; t.cb_settings[0].booking_key = 'wrong';
r = await call({ action: 'book', token: TOKEN5 });
const e5 = t.cb_entries.find(e => e.entry_id === 'e5');
ok(r.status === 502 && !e5.booked_at && /Wrong key/.test(e5.booking_error), 'if the sheet\'s script has a different key, it is not marked booked and staff see why');
t.cb_settings[0].booking_key = 'sheet-key';
r = await call({ action: 'book', token: TOKEN5 });
const row = sheetRows[sheetRows.length - 1];
ok(r.body.booked && e5.booked_at && row.key === 'sheet-key' && row.member_id === 'm1' && row.session_id === 'sess-1' && row.location_id === 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58' && row.date === '2026-11-14' && row.student === 'Sam Lee', 'Book adds a row to the booking sheet with everything the Zap needs (member, session, school, date)');
t.cb_settings[0].booking_webhook = 'https://script.google.com/macros/s/x/exec/../evil'; e5.booked_at = null;
r = await call({ action: 'book', token: TOKEN5 });
ok(r.body.ok === false && /isn't set up/.test(r.body.error), 'only a real Apps Script web app address (or Zapier hook) is used');

console.log('\nBookings close at a set time; a new link lets someone book late');
const TOKEN6 = '6'.repeat(64);
t.cb_days.push({ day_id: 'd6', location: 'Marrickville', grading_date: '2026-11-21', start_time: '10:00:00', efc_session_id: 'sess-6', closed: false, book_by: new Date(Date.now() - 3600e3).toISOString() });
t.cb_entries.push({ entry_id: 'e6', day_id: 'd6', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN6, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null, late_ok_until: null });
t.cb_settings[0].contact_phone = '(02) 9569 1943'; t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
r = await call({ action: 'info', token: TOKEN6 }, null, STRIPE_ENV);
ok(r.body.booking_closed === true && r.body.phone === '(02) 9569 1943', 'after the closing time the booking page says bookings have closed');
r = await call({ action: 'book', token: TOKEN6 });
const e6 = t.cb_entries.find(e => e.entry_id === 'e6');
ok(r.body.ok === false && /closed.*9569 1943/.test(r.body.error) && !e6.booked_at, '...Book is refused, saying to call');
r = await call({ action: 'pay', token: TOKEN6 }, null, STRIPE_ENV);
ok(r.body.ok === false && /closed/.test(r.body.error), '...and so is paying');
e6.late_ok_until = new Date(Date.now() + 48 * 3600e3).toISOString();
r = await call({ action: 'info', token: TOKEN6 }, null, STRIPE_ENV);
ok(r.body.booking_closed === false && r.body.book_by === e6.late_ok_until, 'with a new (late) link from staff, they can book again until it runs out');
r = await call({ action: 'book', token: TOKEN6 });
ok(r.body.booked && e6.booked_at, '...and booking works');

console.log('\nAutomatic emails through GoHighLevel');
const GHL_ENV = { GHL_TOKEN: 'ghl-x', GHL_LOCATION_ID: 'loc-1' };
const TOKEN8 = '8'.repeat(64);
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';
t.cb_entries.push({ entry_id: 'e8', day_id: 'd1', member_key: 'efc:m1', full_name: 'Sam Lee', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: TOKEN8, booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
r = await call({ action: 'book', token: TOKEN8 }, null, GHL_ENV);
let mail = ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email');
ok(r.body.booked && mail.length === 1 && /Grading booked: Sam/.test(mail[0].body.subject) && /Hi Pat/.test(mail[0].body.html) && /Orange Belt/.test(mail[0].body.html) && /Saturday 14 November 2026/.test(mail[0].body.html) && /10:00am/.test(mail[0].body.html) && /What to bring/.test(mail[0].body.html) && /Full long-sleeve uniform/.test(mail[0].body.html) && /Drink bottle/.test(mail[0].body.message), 'booking emails the family a confirmation (date, time, school, belt, what to bring) through GoHighLevel, as HTML with a plain-text version');
ok(t.cb_messages.some(m => m.kind === 'email_booked' && m.entry_id === 'e8' && m.email === 'pat@example.test' && m.status === 'sent'), '...and it is logged');
t.cb_belts[0].fee = 55;
r = await call({ action: 'record_payment', entry_id: 'e8', how: 'cash' }, 'tok-grader', GHL_ENV);
mail = ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email');
ok(mail.length === 2 && /Payment received/.test(mail[1].body.subject) && /\$55\.00/.test(mail[1].body.html), 'recording a payment emails a payment confirmation with the amount');
const before8 = mail.length;
await call({ action: 'record_payment', entry_id: 'e8', how: 'cash' }, 'tok-grader', GHL_ENV);
ok(ghlCalls.filter(c => c.url.endsWith('/conversations/messages') && c.body.type === 'Email').length === before8, 'each email only goes once');
t.cb_belts[0].fee = null;

console.log('\nVisitors from another school (EFC won\'t book them into this school\'s session)');
t.cb_settings[0].booking_webhook = 'https://script.google.com/macros/s/AKfycbx-Test_123/exec';
t.efc_members.push({ member_key: 'efc:m9', efc_reference: 'AU-258-9', full_name: 'Jo Visitor', location: 'Concord', phone: null });
t.cb_entries.push({ entry_id: 'e9', day_id: 'd1', member_key: 'efc:m9', full_name: 'Jo Visitor', belt_from: 'Yellow Belt', belt_to: 'Orange Belt', token: '9'.repeat(48) + 'a'.repeat(16), booked_at: null, booking_error: null, result: null, paid: false, paid_how: null });
const rowsBefore = sheetRows.length;
r = await call({ action: 'book', token: '9'.repeat(48) + 'a'.repeat(16) });
const e9 = t.cb_entries.find(e => e.entry_id === 'e9');
ok(r.body.booked && e9.booked_at && e9.efc_by_hand === true && sheetRows.length === rowsBefore, 'a Concord member grading at Marrickville is booked here, not sent to the booking sheet, and flagged to book in EFC by hand');
t.cb_settings[0].booking_webhook = 'https://hooks.zapier.com/hooks/catch/1/abc/';

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
