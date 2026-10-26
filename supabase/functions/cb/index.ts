// @ts-nocheck
// AMA Toolkit: coloured belt grading. Family booking links, and texts to families through GoHighLevel.
//
// Deploy: Edge Functions > name it "cb", paste this file, Deploy, and turn OFF JWT verification for it
// (booking links are opened by families who aren't signed in; staff actions check who is signed in).
// Uses the same GoHighLevel secrets as Black Belt Prep's "ghl" function (Edge Functions > Secrets):
//   GHL_TOKEN, GHL_LOCATION_ID, and optional GHL_TEST = "1" to log texts without sending them.
// Booking: the Zapier "Catch Hook" address saved in the app's Settings (cb_settings.booking_webhook). Pressing Book
// sends it { member_id, efc_ref, date, session_id, location_id, location, student, belt_to, programme } and your Zap books
// that EFC session with Zapier's "EFC Aquila: Book Session" (member = member_id, session = session_id, location = location_id, date).
// Card payments (optional): STRIPE_SECRET_KEY (the same one the polo shirts use) and a Stripe webhook to
//   https://<project>.supabase.co/functions/v1/cb  for checkout.session.completed (+ async_payment_succeeded), with its
//   signing secret saved as STRIPE_WEBHOOK_SECRET_GRADING. Paying marks them paid and books the session; set the EFC grading
//   session to $0 so EFC doesn't charge again. Without the webhook, a payment is still picked up when they come back to the page.
//
// Requests (POST, JSON):
//   { action: 'info', token }               a family's booking link: who, what belt, when, where (no sign-in)
//   { action: 'book', token }               book it and pay at the front desk (no sign-in)
//   { action: 'pay', token, back? }         pay the fee by card: returns the Stripe payment page (no sign-in); paying books it
//   Stripe's webhook (has a Stripe-Signature header)
//   { action: 'photo', code | token }       a family's grading photo link (short code from /p#<code>): a short-lived address for the photo (no sign-in)
//   { action: 'cleanup' } + x-cb-cron header  the nightly job: delete grading photos older than 30 days (secret in Supabase Vault)
//   { action: 'check' }                     staff: is texting set up?
//   { action: 'send', kind, items: [{ entry_id?, member_key, body }] }   staff: text families
//        kind: invite, not_booked, reminder, unpaid, congrats, retest, photo (grading staff); not_ready (instructors or grading staff)

const API = 'https://services.leadconnectorhq.com';
export const EFC_LOCATIONS = {
  Marrickville: 'f39cf2f5-a3e0-47bc-97cc-bc05c9b2bc58', Sydenham: '5af07764-95bc-4caf-b889-ba846e409dc5', West: 'eafda575-a10e-4656-a045-8e20201aad40',
  Concord: '7ca1c142-be41-4d02-b5eb-13534b23043b', Sylvania: 'a5a5ab24-e85d-4e14-ac16-1d9c189ff0dd'
};
// Who may send each kind (admins always can): invitations and day reminders by grading staff, "not yet" by instructors too
const KINDS = { invite: ['grading'], not_booked: ['grading'], reminder: ['grading'], unpaid: ['grading'], congrats: ['grading'], retest: ['grading'], photo: ['grading'], not_ready: ['instructor', 'grading'] };
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

async function entryByToken(db, token) {
  if (!tokenOk(token)) return null;
  const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how').eq('token', token).maybeSingle();
  if (!e) return null;
  const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, closed, programme').eq('day_id', e.day_id).maybeSingle();
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
  // Send the booking to the Zap, which books the EFC session
  const bookEntry = async (e, d) => {
    const { data: st } = await db.from('cb_settings').select('booking_webhook').eq('id', 1).maybeSingle();
    const hook = st && st.booking_webhook;
    if (!hook || !/^https:\/\/hooks\.zapier\.com\//.test(hook)) return { ok: false, notSetUp: true, why: 'Online booking is not set up (no booking Zap in Settings)' };
    const { data: m } = await db.from('efc_members').select('efc_reference').eq('member_key', e.member_key).maybeSingle();
    const payload = { member_id: e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null, efc_ref: (m && m.efc_reference) || null, date: d.grading_date, session_id: d.efc_session_id || null,
      location_id: EFC_LOCATIONS[d.location] || null, location: d.location, student: e.full_name, belt_to: e.belt_to, programme: d.programme || 'Taekwondo', paid: !!e.paid, paid_how: e.paid_how || null };
    let okHook = false, why = '';
    try { const r = await http(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); okHook = r.ok; if (!r.ok) why = 'Zapier said ' + r.status; }
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
    if (pay) await db.from('cb_payments').update({ status: 'paid', paid_at: now, amount: (s.amount_total || 0) / 100, stripe_payment: payment }).eq('payment_id', pay.payment_id);
    else await db.from('cb_payments').insert({ entry_id: entryId, stripe_session: s.id, status: 'paid', paid_at: now, amount: (s.amount_total || 0) / 100, stripe_payment: payment });
    if (!entryId) return true;
    await db.from('cb_entries').update({ paid: true, paid_at: now, paid_how: 'card' }).eq('entry_id', entryId);
    const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, token, booked_at, booking_error, result, paid, paid_how').eq('entry_id', entryId).maybeSingle();
    if (e && !e.booked_at) {
      const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, closed, programme').eq('day_id', e.day_id).maybeSingle();
      if (d) await bookEntry(e, d);
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
      let x = await entryByToken(db, body.token);
      if (!x) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
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
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, date: d.grading_date, time: d.start_time ? String(d.start_time).slice(0, 5) : null,
        school: d.location, fee, booked: !!e.booked_at, paid: !!e.paid, paid_how: e.paid ? (e.paid_how || 'desk') : null, closed: d.closed || !!e.result,
        card: !!(env.STRIPE_SECRET_KEY && fee > 0), booking_failed: !!(e.paid && !e.booked_at && e.booking_error) };
      if (body.action === 'info') return json(info);
      if (body.action === 'book') {
        if (e.booked_at) return json({ ...info, booked: true });
        if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
        const b = await bookEntry(e, d);
        if (b.notSetUp) return json({ ...info, ok: false, error: 'Online booking isn\'t set up for this grading yet. Please contact the front desk.' });
        if (!b.ok) return json({ ...info, ok: false, error: 'We couldn\'t book it just now. Please try again in a minute, or contact the front desk.' }, 502);
        return json({ ...info, booked: true });
      }
      // Pay by card
      if (e.paid) return json({ ...info, ok: false, error: 'This grading is already paid for.' });
      if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
      if (!info.card) return json({ ...info, ok: false, error: 'Card payments aren\'t set up for this grading. Please pay at the front desk.' }, 409);
      const site = backTo(body.back);
      const sess = await stripe('/checkout/sessions', { method: 'POST', body: form({
        mode: 'payment', client_reference_id: e.entry_id, metadata: { kind: 'grading', entry_id: e.entry_id, day_id: e.day_id },
        payment_intent_data: { metadata: { kind: 'grading', entry_id: e.entry_id }, description: `AMA ${d.location} grading ${d.grading_date}: ${e.full_name} for ${e.belt_to}` },
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
    if (!roles.some(r => ['admin', 'instructor', 'grading'].includes(r))) return fail('Your login cannot use coloured belt grading.', 403);
    const ready = !!(env.GHL_TOKEN && env.GHL_LOCATION_ID), testing = env.GHL_TEST === '1';
    if (body.action === 'check') return json({ ready: ready || testing, testing });
    if (body.action !== 'send') return fail('Unknown action.');
    const kind = String(body.kind || '');
    if (!KINDS[kind]) return fail('Unknown kind of message.');
    if (!may(kind)) return fail('Your login cannot send this kind of message.', 403);
    if (!ready && !testing) return fail('Texting is not set up yet: add GHL_TOKEN and GHL_LOCATION_ID in Supabase (Edge Functions > Secrets).', 409);
    const items = Array.isArray(body.items) ? body.items.slice(0, 300) : [];
    if (!items.length) return fail('No one to text.');

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
        phone, ...(m.email ? { email: m.email } : {}), tags: ['ama coloured belt grading'], source: 'AMA coloured belt grading' }) });
      return (r.contact || {}).id;
    };

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
