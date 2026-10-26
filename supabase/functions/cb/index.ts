// @ts-nocheck
// AMA Toolkit: coloured belt grading. Family booking links, and texts to families through GoHighLevel.
//
// Deploy: Edge Functions > name it "cb", paste this file, Deploy, and turn OFF JWT verification for it
// (booking links are opened by families who aren't signed in; staff actions check who is signed in).
// Uses the same GoHighLevel secrets as Black Belt Prep's "ghl" function (Edge Functions > Secrets):
//   GHL_TOKEN, GHL_LOCATION_ID, and optional GHL_TEST = "1" to log texts without sending them.
// Booking: the address saved in the app's Settings (cb_settings.booking_webhook): a Google Apps Script web app that adds
// the booking to a Google Sheet (tools/booking-sheet.gs; a Zap books from each new row), or a Zapier "Catch Hook". Pressing Book
// sends it { member_id, efc_ref, date, session_id, location_id, location, student, belt_to, programme } and your Zap books
// that EFC session with Zapier's "EFC Aquila: Book Session" (member = member_id, session = session_id, location = location_id, date).
// Emails (automatic, through GoHighLevel with the same secrets): "booked" when a family books, and "paid and booked" when
// they pay by card or staff record a payment (with Stripe's receipt link). Each goes once per student, to their EFC email.
// Card payments (optional): STRIPE_SECRET_KEY (the same one the polo shirts use) and a Stripe webhook to
//   https://<project>.supabase.co/functions/v1/cb  for checkout.session.completed (+ async_payment_succeeded), with its
//   signing secret saved as STRIPE_WEBHOOK_SECRET_GRADING. Paying marks them paid and books the session; set the EFC grading
//   session to $0 so EFC doesn't charge again. Without the webhook, a payment is still picked up when they come back to the page.
//
// Requests (POST, JSON):
//   { action: 'info', token }               a family's booking link: who, what belt, when, where (no sign-in)
//   { action: 'book', token }               book it, only when there is no fee (no sign-in): with a fee, families pay by card
//   { action: 'record_payment', entry_id, how }  staff: a cash/EFTPOS/bank payment taken by staff; marks paid and books it
//   { action: 'pay', token, back? }         pay the fee by card: returns the Stripe payment page (no sign-in); paying books it
//   Stripe's webhook (has a Stripe-Signature header)
//   { action: 'photo', code | token }       a family's grading photo link (short code from /p#<code>): a short-lived address for the photo (no sign-in)
//   { action: 'cleanup' } + x-cb-cron header  the nightly job: delete grading photos older than 30 days (secret in Supabase Vault)
//   { action: 'check' }                     staff: is texting set up?
//   { action: 'send', kind, items: [{ entry_id?, member_key, body }] }   staff: text families
//        kind: invite, not_booked, reminder, unpaid, congrats, retest, photo (grading staff); not_ready, bbc_followup (instructors or grading staff)

const API = 'https://services.leadconnectorhq.com';
export const EFC_LOCATIONS = {
  Marrickville: 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58', Sydenham: '5af07764-95bc-4caf-b889-ba846e409dc5', West: 'eafda575-a10e-4656-a045-8e20201aad40',
  Concord: '7ca1c142-be41-4d02-b5eb-13534b23043b', Sylvania: 'a5a5ab24-e85d-4e14-ac16-1d9c189ff0dd'
};
// Who may send each kind (admins always can): invitations and day reminders by grading staff, "not yet" by instructors too
const KINDS = { invite: ['grading'], not_booked: ['grading'], reminder: ['grading'], unpaid: ['grading'], congrats: ['grading'], retest: ['grading'], photo: ['grading'], not_ready: ['instructor', 'grading'], bbc_followup: ['instructor', 'grading'] };
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cb-cron, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);

// Australian numbers to international form: 0412 345 678 -> +61412345678
export function phoneE164(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return null;
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (s.startsWith('61') && s.length >= 11) return '+' + s;
  if (s.startsWith('0') && s.length === 10) return '+61' + s.slice(1);
  if (s.length === 9 && s.startsWith('4')) return '+61' + s;
  return null;
}
const first = n => String(n || '').trim().split(/\s+/)[0] || '';
const tokenOk = t => /^[a-f0-9]{48,72}$/.test(String(t || ''));
const STRIPE = 'https://api.stripe.com/v1';
const BOOK_PAGE = 'https://theggatonklenner.github.io/grading/coloured-belts/book/';
// Where Stripe sends families back: the booking page they came from, on AMA's own sites only
export function backTo(u) {
  try { const x = new URL(String(u || '')); if (x.protocol === 'https:' && /(^|\.)(theggatonklenner\.github\.io|australianmartialarts\.com\.au)$/.test(x.hostname)) return x.origin + x.pathname; } catch (e) { /* not a URL */ }
  return BOOK_PAGE;
}
// Stripe's form encoding, with nested keys: { a: { b: 1 } } -> a[b]=1
function form(obj, pre = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
// Stripe-Signature: t=<time>,v1=<HMAC-SHA256 of "<time>.<body>"> (within 5 minutes)
export async function signatureOk(body, header, secret, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map(p => p.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').map(p => p.trim()).filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
  return sigs.some(s => s.length === want.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ want.charCodeAt(i)), 0) === 0);
}

// The booking and payment emails: a branded layout that works in email apps (tables and inline styles only)
const LOGO = 'https://theggatonklenner.github.io/icons/ama-id-cards.png';
const BRING = 'Full long-sleeve uniform\nBelt\nDrink bottle';
export function buildEmail(kind, v) {
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paid = kind === 'email_paid';
  const green = '#04794b', ink = '#16211b', muted = '#5a6b61', line = '#dfe7e2', soft = '#f3f6f4';
  const subject = paid ? `Payment received: ${v.kid}'s grading on ${v.when}` : `Grading booked: ${v.kid}, ${v.when}`;
  const heading = paid ? 'Payment received. You\'re booked in!' : 'You\'re booked in!';
  const intro = paid ? `Thank you, we've received your payment for ${v.kid}'s grading. Here are the details for the day.` : `${v.kid} is booked in to grade. Here are the details for the day.`;
  const rows = [['Student', v.student], ['Grading for', v.belt], ['Date', v.when], ...(v.time ? [['Time', v.time]] : []), ['Where', `AMA ${v.school}`],
    ...(paid ? [['Paid', `${v.amount != null && v.amount !== '' ? '$' + Number(v.amount).toFixed(2) : 'Yes'}${v.how ? ' (' + v.how + ')' : ''}`]] : [])];
  const bring = String(v.bring || BRING).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const tel = String(v.phone || '').replace(/[^\d+]/g, '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${soft};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(intro)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${soft};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${line};font-family:Arial,Helvetica,sans-serif;color:${ink};">
  <tr><td style="background:${green};padding:20px 24px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="padding-right:14px;"><img src="${LOGO}" width="56" height="56" alt="AMA" style="display:block;border-radius:50%;background:#ffffff;"></td>
      <td style="color:#ffffff;font-size:13px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;">Australian Martial Arts Academy<br><span style="font-size:12px;font-weight:normal;letter-spacing:0;text-transform:none;opacity:.9;">${esc(v.school)}</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:28px 24px 8px;">
    <h1 style="margin:0 0 10px;font-size:24px;line-height:1.25;color:${ink};">${esc(heading)}</h1>
    <p style="margin:0;font-size:16px;line-height:1.5;color:${muted};">Hi ${esc(v.parent)},<br>${esc(intro)}</p>
  </td></tr>
  <tr><td style="padding:16px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${soft};border-radius:12px;">
      ${rows.map(([k, x], i) => `<tr><td style="padding:12px 16px;font-size:14px;color:${muted};width:38%;${i ? `border-top:1px solid ${line};` : ''}">${esc(k)}</td><td style="padding:12px 16px;font-size:15px;font-weight:bold;color:${ink};${i ? `border-top:1px solid ${line};` : ''}">${esc(x)}</td></tr>`).join('')}
    </table>
  </td></tr>
  ${v.receipt ? `<tr><td align="center" style="padding:4px 24px 12px;"><a href="${esc(v.receipt)}" style="display:inline-block;background:${green};color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px;">View your receipt</a></td></tr>` : ''}
  <tr><td style="padding:12px 24px 4px;">
    <h2 style="margin:0 0 10px;font-size:17px;color:${ink};">What to bring</h2>
    <table role="presentation" cellpadding="0" cellspacing="0">
      ${bring.map(b => `<tr><td valign="top" style="padding:4px 10px 4px 0;color:${green};font-size:16px;font-weight:bold;">&#10003;</td><td style="padding:4px 0;font-size:15px;line-height:1.45;color:${ink};">${esc(b)}</td></tr>`).join('')}
    </table>
  </td></tr>
  <tr><td style="padding:20px 24px 26px;">
    <p style="margin:0;font-size:15px;line-height:1.5;color:${muted};">Please arrive 15 minutes early. Good luck, ${esc(v.kid)}! Family and friends are welcome to come and watch.</p>
  </td></tr>
  <tr><td style="background:${soft};border-top:1px solid ${line};padding:16px 24px;font-size:13px;line-height:1.5;color:${muted};">
    Questions? Call us on ${tel ? `<a href="tel:${esc(tel)}" style="color:${green};font-weight:bold;text-decoration:none;">${esc(v.phone)}</a>` : esc(v.phone || 'the front desk')}.<br>AMA ${esc(v.school)}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
  const text = [`Hi ${v.parent},`, intro, ...rows.map(([k, x]) => `${k}: ${x}`), ...(v.receipt ? [`Your receipt: ${v.receipt}`] : []),
    'What to bring:', ...bring.map(b => '- ' + b), 'Please arrive 15 minutes early.', `Questions? Call us on ${v.phone || 'the front desk'}.`, `AMA ${v.school}`].join('\n');
  return { subject, html, text };
}

async function entryByToken(db, token) {
  if (!tokenOk(token)) return null;
  const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how, late_ok_until').eq('token', token).maybeSingle();
  if (!e) return null;
  const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, closed, programme, book_by').eq('day_id', e.day_id).maybeSingle();
  return d ? { e, d } : null;
}

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  const stripe = async (path, opts = {}) => {
    const r = await http(STRIPE + path, { ...opts, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe said ${r.status}`);
    return j;
  };
  // GoHighLevel: find or add the family's contact, then send them a text or an email
  const ghl = async (path, opts = {}, version = '2021-07-28') => {
    const r = await http(API + path, { ...opts, headers: { Authorization: 'Bearer ' + env.GHL_TOKEN, Version: version, Accept: 'application/json', 'Content-Type': 'application/json' } });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) { /* not JSON */ }
    if (!r.ok) throw new Error(j.message ? [].concat(j.message).join(', ') : `GoHighLevel said ${r.status}`);
    return j;
  };
  const contactFor = async (m, phone) => {
    for (const [k, v] of [['number', phone], ['email', m.email]]) {
      if (!v) continue;
      const r = await ghl(`/contacts/search/duplicate?locationId=${encodeURIComponent(env.GHL_LOCATION_ID)}&${k}=${encodeURIComponent(v)}`, { method: 'GET' });
      if (r.contact && r.contact.id) return r.contact.id;
    }
    const parts = String(m.guardian_name || m.full_name || '').trim().split(/\s+/);
    const r = await ghl('/contacts/', { method: 'POST', body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: parts[0] || '', lastName: parts.slice(1).join(' '),
      ...(phone ? { phone } : {}), ...(m.email ? { email: m.email } : {}), tags: ['ama coloured belt grading'], source: 'AMA coloured belt grading' }) });
    return (r.contact || {}).id;
  };
  // Automatic confirmation emails (once each): 'email_booked' or 'email_paid'. Never stops a booking or payment if it fails.
  const confirmEmail = async (e, d, kind, extra = {}) => {
    try {
      if (!(env.GHL_TOKEN && env.GHL_LOCATION_ID)) return;
      const { data: sent } = await db.from('cb_messages').select('status').eq('entry_id', e.entry_id).eq('kind', kind).eq('status', 'sent').maybeSingle();
      if (sent) return;
      const { data: m } = await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email').eq('member_key', e.member_key).maybeSingle();
      const email = m && [m.email, m.guardian_email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
      if (!email) return;
      const { data: cs } = await db.from('cb_settings').select('contact_phone, email_bring').eq('id', 1).maybeSingle();
      const when = new Date(d.grading_date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const t = d.start_time ? String(d.start_time).slice(0, 5).split(':').map(Number) : null;
      const HOW = { card: 'card', cash: 'cash', eftpos: 'EFTPOS', transfer: 'bank transfer', other: '' };
      const { subject, html, text } = buildEmail(kind, { parent: first(m.guardian_name) || 'there', kid: first(e.full_name), student: e.full_name, belt: e.belt_to, school: d.location,
        when, time: t ? `${((t[0] + 11) % 12) + 1}:${String(t[1]).padStart(2, '0')}${t[0] < 12 ? 'am' : 'pm'}` : '', amount: extra.amount, how: HOW[e.paid_how] || '',
        receipt: extra.receipt || null, phone: (cs && cs.contact_phone) || '(02) 9569 1943', bring: cs && cs.email_bring });
      const log = (status, more = {}) => db.from('cb_messages').insert({ entry_id: e.entry_id, member_key: e.member_key, kind, email, body: subject + '\n\n' + text, status, sent_by: 'automatic', ...more });
      try {
        const cid = await contactFor({ ...m, email }, phoneE164(m.phone || m.guardian_phone));
        if (!cid) throw new Error('Could not find or add the contact');
        await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'Email', contactId: cid, subject, html, message: text }) }, '2021-04-15');
        await log('sent');
      } catch (er) { await log('failed', { error: String(er.message || er).slice(0, 500) }); }
    } catch (er) { console.error(er); }
  };
  // Send the booking to the booking sheet (or a Zapier hook); a Zap then books the EFC session
  const bookEntry = async (e, d) => {
    const { data: st } = await db.from('cb_settings').select('booking_webhook, booking_key').eq('id', 1).maybeSingle();
    const hook = st && st.booking_webhook;
    const sheet = !!hook && /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(hook);
    if (!hook || !(sheet || /^https:\/\/hooks\.zapier\.com\//.test(hook))) return { ok: false, notSetUp: true, why: 'Online booking is not set up (no booking sheet in Settings)' };
    const { data: m } = await db.from('efc_members').select('efc_reference, location').eq('member_key', e.member_key).maybeSingle();
    // A visitor from another school: EFC won't book them into this school's session, so staff do it by hand
    if (m && m.location && m.location !== d.location) {
      e.booked_at = new Date().toISOString();
      await db.from('cb_entries').update({ booked_at: e.booked_at, booking_error: null, efc_by_hand: true }).eq('entry_id', e.entry_id);
      return { ok: true, byHand: true };
    }
    const payload = { member_id: e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null, efc_ref: (m && m.efc_reference) || null, date: d.grading_date, session_id: d.efc_session_id || null,
      location_id: EFC_LOCATIONS[d.location] || null, location: d.location, student: e.full_name, belt_to: e.belt_to, programme: d.programme || 'Taekwondo', paid: !!e.paid, paid_how: e.paid_how || null,
      ...(sheet ? { key: (st && st.booking_key) || '' } : {}) };
    let okHook = false, why = '';
    try {
      // Google answers a script with a redirect to its reply ({ ok: true } when the row was added)
      const r = await http(hook, { method: 'POST', headers: { 'Content-Type': sheet ? 'text/plain' : 'application/json' }, body: JSON.stringify(payload), redirect: 'follow' });
      if (!sheet) { okHook = r.ok; if (!r.ok) why = 'Zapier said ' + r.status; }
      else { const j = await r.json().catch(() => ({})); okHook = r.ok && j.ok === true; if (!okHook) why = 'The booking sheet said ' + (j.error || r.status); }
    }
    catch (err) { why = String(err && err.message || err); }
    if (!okHook) { await db.from('cb_entries').update({ booking_error: why.slice(0, 300) }).eq('entry_id', e.entry_id); return { ok: false, why }; }
    e.booked_at = new Date().toISOString();
    await db.from('cb_entries').update({ booked_at: e.booked_at, booking_error: null }).eq('entry_id', e.entry_id);
    return { ok: true };
  };
  // A paid Stripe Checkout session for a grading: mark the student paid (once), then book them if they aren't yet
  const markPaid = async s => {
    if (!s || s.payment_status !== 'paid' || !s.metadata || s.metadata.kind !== 'grading') return false;
    const { data: pay } = await db.from('cb_payments').select('payment_id, entry_id, status').eq('stripe_session', s.id).maybeSingle();
    const entryId = (pay && pay.entry_id) || s.metadata.entry_id || s.client_reference_id;
    if (pay && pay.status === 'paid') return true;   // already done
    const now = new Date().toISOString(), payment = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || s.id;
    // Stripe's receipt (from the payment's charge)
    let receipt = null;
    if (payment && String(payment).startsWith('pi_')) { try { const pi = await stripe('/payment_intents/' + encodeURIComponent(payment) + '?expand[]=latest_charge', { method: 'GET' }); receipt = (pi.latest_charge && pi.latest_charge.receipt_url) || null; } catch (er) { console.error(er); } }
    if (pay) await db.from('cb_payments').update({ status: 'paid', paid_at: now, amount: (s.amount_total || 0) / 100, stripe_payment: payment, receipt_url: receipt }).eq('payment_id', pay.payment_id);
    else await db.from('cb_payments').insert({ entry_id: entryId, stripe_session: s.id, status: 'paid', paid_at: now, amount: (s.amount_total || 0) / 100, stripe_payment: payment, receipt_url: receipt });
    if (!entryId) return true;
    await db.from('cb_entries').update({ paid: true, paid_at: now, paid_how: 'card' }).eq('entry_id', entryId);
    const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how, late_ok_until').eq('entry_id', entryId).maybeSingle();
    if (e) {
      const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, closed, programme, book_by').eq('day_id', e.day_id).maybeSingle();
      if (d && !e.booked_at) await bookEntry(e, d);
      if (d) await confirmEmail(e, d, 'email_paid', { amount: (s.amount_total || 0) / 100, receipt });
    }
    return true;
  };

  try {
    const raw = await req.text();
    // ---- Stripe's webhook: a grading fee was paid ----
    const sig = req.headers.get('stripe-signature');
    if (sig) {
      const secrets = [env.STRIPE_WEBHOOK_SECRET_GRADING, env.STRIPE_WEBHOOK_SECRET].filter(Boolean);
      let good = false; for (const sec of secrets) if (await signatureOk(raw, sig, sec)) { good = true; break; }
      if (!good) return fail('Bad signature.', 400);
      const ev = JSON.parse(raw);
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) await markPaid(ev.data && ev.data.object);
      return json({ received: true });
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch (e) { /* not JSON */ }

    // ---- Families (no sign-in): the booking link ----
    if (body.action === 'info' || body.action === 'book' || body.action === 'pay') {
      const { data: cs } = await db.from('cb_settings').select('contact_phone, email_bring').eq('id', 1).maybeSingle();
      const phone = (cs && cs.contact_phone) || '(02) 9569 1943';
      const bring = String((cs && cs.email_bring) || BRING).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      let x = await entryByToken(db, body.token);
      if (!x) return json({ ok: false, phone, error: `This link isn't valid any more. Please call us on ${phone}.` }, 404);
      let { e, d } = x;
      // Back from Stripe (or the webhook hasn't come yet): ask Stripe whether it was paid
      if (!e.paid && env.STRIPE_SECRET_KEY) {
        const { data: pend } = await db.from('cb_payments').select('stripe_session').eq('entry_id', e.entry_id).eq('status', 'pending').maybeSingle();
        if (pend && pend.stripe_session) {
          try { if (await markPaid(await stripe('/checkout/sessions/' + encodeURIComponent(pend.stripe_session), { method: 'GET' }))) { x = await entryByToken(db, body.token); e = x.e; d = x.d; } } catch (er) { console.error(er); }
        }
      }
      const { data: belt } = await db.from('cb_belts').select('fee').eq('programme', d.programme || 'Taekwondo').eq('belt', e.belt_from).maybeSingle();
      const fee = belt && belt.fee != null ? Number(belt.fee) : null;
      // Bookings close at the day's set time, unless staff issued a new (late) link
      const nowMs = Date.now(), late = e.late_ok_until && Date.parse(e.late_ok_until) > nowMs;
      const shut = !!(d.book_by && Date.parse(d.book_by) <= nowMs && !late);
      let receipt = null;
      if (e.paid && e.paid_how === 'card') { const { data: rp } = await db.from('cb_payments').select('receipt_url').eq('entry_id', e.entry_id).eq('status', 'paid').maybeSingle(); receipt = (rp && rp.receipt_url) || null; }
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, date: d.grading_date, time: d.start_time ? String(d.start_time).slice(0, 5) : null,
        school: d.location, fee, booked: !!e.booked_at, paid: !!e.paid, paid_how: e.paid ? (e.paid_how || 'desk') : null, closed: d.closed || !!e.result,
        card: !!(env.STRIPE_SECRET_KEY && fee > 0), booking_failed: !!(e.paid && !e.booked_at && e.booking_error),
        book_by: late ? e.late_ok_until : (d.book_by || null), booking_closed: shut, phone, receipt, bring };
      const shutMsg = `Bookings for this grading have closed. Please call us on ${phone}.`;
      if (body.action === 'info') return json(info);
      if (body.action === 'book') {
        if (e.booked_at) return json({ ...info, booked: true });
        if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
        if (shut) return json({ ...info, ok: false, error: shutMsg });
        // With a fee, the link only takes card payments (staff record any other payment)
        if (fee > 0) return json({ ...info, ok: false, error: info.card ? 'Please pay the grading fee by card to book.' : `Online payment isn't available for this grading. Please call us on ${phone} to book.` });
        const b = await bookEntry(e, d);
        if (b.notSetUp) return json({ ...info, ok: false, error: 'Online booking isn\'t set up for this grading yet. Please contact the front desk.' });
        if (!b.ok) return json({ ...info, ok: false, error: 'We couldn\'t book it just now. Please try again in a minute, or contact the front desk.' }, 502);
        await confirmEmail(e, d, 'email_booked');
        return json({ ...info, booked: true });
      }
      // Pay by card
      if (e.paid) return json({ ...info, ok: false, error: 'This grading is already paid for.' });
      if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
      if (shut) return json({ ...info, ok: false, error: shutMsg });
      if (!info.card) return json({ ...info, ok: false, error: 'Card payments aren\'t set up for this grading. Please pay at the front desk.' }, 409);
      const site = backTo(body.back);
      // Stripe emails the receipt to the family (their email from EFC)
      const { data: who } = await db.from('efc_members').select('email, guardian_email').eq('member_key', e.member_key).maybeSingle();
      const email = [who && who.email, who && who.guardian_email].find(v => v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) || null;
      const sess = await stripe('/checkout/sessions', { method: 'POST', body: form({
        mode: 'payment', client_reference_id: e.entry_id, metadata: { kind: 'grading', entry_id: e.entry_id, day_id: e.day_id },
        payment_intent_data: { metadata: { kind: 'grading', entry_id: e.entry_id }, description: `AMA ${d.location} grading ${d.grading_date}: ${e.full_name} for ${e.belt_to}`, ...(email ? { receipt_email: email } : {}) },
        ...(email ? { customer_email: email } : {}),
        line_items: { 0: { quantity: 1, price_data: { currency: 'aud', unit_amount: Math.round(fee * 100), product_data: { name: `AMA grading: ${e.belt_to}`, description: `${first(e.full_name)}, ${d.location}, ${d.grading_date}` } } } },
        success_url: `${site}?paid=1#t=${e.token}`, cancel_url: `${site}#t=${e.token}` }) });
      const { data: had } = await db.from('cb_payments').select('payment_id').eq('entry_id', e.entry_id).eq('status', 'pending').maybeSingle();
      if (had) await db.from('cb_payments').update({ stripe_session: sess.id, amount: fee, created_at: new Date().toISOString() }).eq('payment_id', had.payment_id);
      else await db.from('cb_payments').insert({ entry_id: e.entry_id, member_key: e.member_key, full_name: e.full_name, day_id: e.day_id, amount: fee, status: 'pending', stripe_session: sess.id });
      return json({ ok: true, url: sess.url });
    }

    // ---- Families (no sign-in): the grading photo link ----
    if (body.action === 'photo') {
      const byCode = /^[A-Za-z0-9]{8,16}$/.test(String(body.code || ''));
      if (!byCode && !tokenOk(body.token)) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, full_name, belt_to, photo_path, photo_removed_at').eq(byCode ? 'photo_code' : 'token', byCode ? body.code : body.token).maybeSingle();
      if (!e) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { data: d } = await db.from('cb_days').select('location, grading_date').eq('day_id', e.day_id).maybeSingle();
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, school: d ? d.location : null, date: d ? d.grading_date : null, photo: false };
      if (!e.photo_path) return json({ ...info, removed: !!e.photo_removed_at, error: e.photo_removed_at ? 'Grading photos are kept for 30 days, and this one has been removed. Please ask the front desk if you need it.' : 'The photo isn\'t ready yet. Please check again soon.' });
      const name = `${String(e.full_name || 'grading').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-AMA-grading.${(String(e.photo_path).match(/\.(jpe?g|png|webp)$/i) || [, 'jpg'])[1].toLowerCase()}`;
      const bucket = db.storage.from('grading-photos');
      const [{ data: v, error: ve }, { data: dl }] = await Promise.all([bucket.createSignedUrl(e.photo_path, 3600), bucket.createSignedUrl(e.photo_path, 3600, { download: name })]);
      if (ve || !v) return json({ ...info, error: 'The photo couldn\'t be loaded just now. Please try again soon.' }, 502);
      return json({ ...info, photo: true, url: v.signedUrl, download: (dl && dl.signedUrl) || v.signedUrl, filename: name });
    }

    // ---- The nightly job: delete grading photos 30 days after they're taken ----
    if (body.action === 'cleanup') {
      const { data: okCron } = await db.rpc('cb_cron_ok', { p_secret: req.headers.get('x-cb-cron') || '' });
      if (okCron !== true) return fail('Not allowed.', 403);
      const { data: names, error: le } = await db.rpc('cb_old_photos', { p_days: 30 });
      if (le) throw le;
      const list = (names || []).map(x => typeof x === 'string' ? x : x.cb_old_photos).filter(Boolean);
      let removed = 0, cleared = 0;
      for (let i = 0; i < list.length; i += 100) {
        const batch = list.slice(i, i + 100);
        const { error: re } = await db.storage.from('grading-photos').remove(batch);
        if (re) throw re;
        removed += batch.length;
        const { data: n } = await db.rpc('cb_photos_removed', { p_names: batch });
        cleared += Number(n) || 0;
      }
      return json({ ok: true, removed, cleared });
    }

    // ---- Staff ----
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const { data: roleRows } = await db.from('prep_roles').select('role').eq('email', me);
    const roles = (roleRows || []).map(r => r.role);
    const may = kind => roles.includes('admin') || (KINDS[kind] || []).some(r => roles.includes(r));
    if (!roles.some(r => ['admin', 'instructor', 'grading', 'payments'].includes(r))) return fail('Your login cannot use coloured belt grading.', 403);
    // A payment taken by staff (cash, EFTPOS, bank transfer): mark paid, then book the EFC session like a card payment would
    if (body.action === 'record_payment') {
      if (!roles.some(r => ['admin', 'grading', 'payments'].includes(r))) return fail('Your login cannot record payments.', 403);
      const how = String(body.how || '');
      if (!['cash', 'eftpos', 'transfer', 'other'].includes(how)) return fail('Choose how they paid.');
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how, late_ok_until').eq('entry_id', String(body.entry_id || '')).maybeSingle();
      if (!e) return fail('Student not found on this grading day.', 404);
      if (e.paid) return json({ ok: true, already: true, booked: !!e.booked_at });
      e.paid = true; e.paid_how = how;
      await db.from('cb_entries').update({ paid: true, paid_at: new Date().toISOString(), paid_how: how }).eq('entry_id', e.entry_id);
      let b = { ok: !!e.booked_at };
      const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, closed, programme, book_by').eq('day_id', e.day_id).maybeSingle();
      if (d && !e.booked_at) b = await bookEntry(e, d);
      if (d) { const { data: bf } = await db.from('cb_belts').select('fee').eq('programme', d.programme || 'Taekwondo').eq('belt', e.belt_from).maybeSingle(); await confirmEmail(e, d, 'email_paid', { amount: bf && bf.fee }); }
      return json({ ok: true, booked: !!b.ok, byHand: !!b.byHand, booking_error: b.ok ? null : (b.why || null) });
    }
    const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';
    if (body.action === 'check') return json({ ready: ready || testing, testing });
    if (body.action !== 'send') return fail('Unknown action.');
    const kind = String(body.kind || '');
    if (!KINDS[kind]) return fail('Unknown kind of message.');
    if (!may(kind)) return fail('Your login cannot send this kind of message.', 403);
    if (!ready && !testing) return fail('Texting is not set up yet: add GHL_TOKEN and GHL_LOCATION_ID in Supabase (Edge Functions > Secrets).', 409);
    const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
    if (!items.length) return fail('No one to text.');

    const results = [];
    for (const it of items) {
      const text = String(it.body || '').trim(), out = { member_key: it.member_key, entry_id: it.entry_id || null, ok: false };
      results.push(out);
      if (!text || text.length > 1000) { out.error = 'The message is empty or too long'; continue; }
      const { data: m } = await db.from('efc_members').select('member_key, full_name, guardian_name, phone, guardian_phone, email, guardian_email').eq('member_key', String(it.member_key || '')).maybeSingle();
      if (!m) { out.error = 'Student not found'; continue; }
      const phone = phoneE164(m.phone || m.guardian_phone);
      const log = (status, extra = {}) => db.from('cb_messages').insert({ entry_id: it.entry_id || null, member_key: m.member_key, kind, phone: phone || m.phone || null, body: text, status, sent_by: me, ...extra });
      if (!phone) { out.error = 'No mobile number'; await log('failed', { error: out.error }); continue; }
      if (testing && !ready) { out.ok = true; out.test = true; await log('test'); }
      else {
        try {
          const cid = await contactFor({ ...m, email: m.email || m.guardian_email }, phone);
          if (!cid) throw new Error('Could not find or add the contact');
          await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId: cid, message: text }) }, '2021-04-15');
          out.ok = true; await log('sent');
        } catch (e) { out.error = String(e.message || e); await log('failed', { error: out.error.slice(0, 500) }); continue; }
      }
      if (kind === 'invite' && it.entry_id) await db.from('cb_entries').update({ invited_at: new Date().toISOString() }).eq('entry_id', it.entry_id);
    }
    return json({ sent: results.filter(r => r.ok).length, results, testing: testing && !ready });
  } catch (e) {
    console.error(e);
    return fail(String(e && e.message || e), 500);
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const env = { GHL_TOKEN: Deno.env.get('GHL_TOKEN'), GHL_LOCATION_ID: Deno.env.get('GHL_LOCATION_ID'), GHL_TEST: Deno.env.get('GHL_TEST'),
    STRIPE_SECRET_KEY: Deno.env.get('STRIPE_SECRET_KEY'), STRIPE_WEBHOOK_SECRET_GRADING: Deno.env.get('STRIPE_WEBHOOK_SECRET_GRADING') };
  Deno.serve(req => handle(req, db, env));
}
