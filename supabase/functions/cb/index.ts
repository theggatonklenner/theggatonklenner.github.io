// @ts-nocheck
// AMA Toolkit: coloured belt grading. Family booking links, and texts to families through GoHighLevel.
//
// Deploy: Edge Functions > name it "cb", paste this file, Deploy, and turn OFF JWT verification for it
// (booking links are opened by families who aren't signed in; staff actions check who is signed in).
// Uses the same GoHighLevel secrets as Black Belt Prep's "ghl" function (Edge Functions > Secrets):
//   GHL_TOKEN, GHL_LOCATION_ID, and optional GHL_TEST = "1" to log texts without sending them.
// Booking: the Zapier "Catch Hook" address saved in the app's Settings (cb_settings.booking_webhook). Pressing Book
// sends it { member_id, efc_ref, date, session_id, location_id, location, student, belt_to, programme } and your Zap books
// that EFC session (EFC charges the grading fee through the session).
//
// Requests (POST, JSON):
//   { action: 'info', token }               a family's booking link: who, what belt, when, where (no sign-in)
//   { action: 'book', token }               book it (no sign-in)
//   { action: 'photo', token }              a family's grading photo link: a short-lived address for the photo (no sign-in)
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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

async function entryByToken(db, token) {
  if (!tokenOk(token)) return null;
  const { data: e } = await db.from('cb_entries').select('entry_id, day_id, member_key, full_name, belt_from, belt_to, booked_at, booking_error, result').eq('token', token).maybeSingle();
  if (!e) return null;
  const { data: d } = await db.from('cb_days').select('day_id, location, grading_date, start_time, efc_session_id, closed, programme').eq('day_id', e.day_id).maybeSingle();
  return d ? { e, d } : null;
}

export async function handle(req, db, env = {}, http = fetch) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  try {
    const body = await req.json().catch(() => ({}));

    // ---- Families (no sign-in): the booking link ----
    if (body.action === 'info' || body.action === 'book') {
      const x = await entryByToken(db, body.token);
      if (!x) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { e, d } = x;
      const { data: belt } = await db.from('cb_belts').select('fee').eq('programme', d.programme || 'Taekwondo').eq('belt', e.belt_from).maybeSingle();
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, date: d.grading_date, time: d.start_time ? String(d.start_time).slice(0, 5) : null,
        school: d.location, fee: belt && belt.fee != null ? Number(belt.fee) : null, booked: !!e.booked_at, closed: d.closed || !!e.result };
      if (body.action === 'info') return json(info);
      if (e.booked_at) return json({ ...info, booked: true });
      if (info.closed) return json({ ...info, ok: false, error: 'This grading has finished.' });
      const { data: st } = await db.from('cb_settings').select('booking_webhook').eq('id', 1).maybeSingle();
      const hook = st && st.booking_webhook;
      if (!hook || !/^https:\/\/hooks\.zapier\.com\//.test(hook)) return json({ ...info, ok: false, error: 'Online booking isn\'t set up for this grading yet. Please contact the front desk.' });
      const { data: m } = await db.from('efc_members').select('efc_reference').eq('member_key', e.member_key).maybeSingle();
      const payload = { member_id: e.member_key.startsWith('efc:') ? e.member_key.slice(4) : null, efc_ref: (m && m.efc_reference) || null, date: d.grading_date, session_id: d.efc_session_id || null,
        location_id: EFC_LOCATIONS[d.location] || null, location: d.location, student: e.full_name, belt_to: e.belt_to, programme: d.programme || 'Taekwondo' };
      let okHook = false, why = '';
      try { const r = await http(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); okHook = r.ok; if (!r.ok) why = 'Zapier said ' + r.status; }
      catch (err) { why = String(err && err.message || err); }
      if (!okHook) {
        await db.from('cb_entries').update({ booking_error: why.slice(0, 300) }).eq('entry_id', e.entry_id);
        return json({ ...info, ok: false, error: 'We couldn\'t book it just now. Please try again in a minute, or contact the front desk.' }, 502);
      }
      await db.from('cb_entries').update({ booked_at: new Date().toISOString(), booking_error: null }).eq('entry_id', e.entry_id);
      return json({ ...info, booked: true });
    }

    // ---- Families (no sign-in): the grading photo link ----
    if (body.action === 'photo') {
      if (!tokenOk(body.token)) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { data: e } = await db.from('cb_entries').select('entry_id, day_id, full_name, belt_to, photo_path').eq('token', body.token).maybeSingle();
      if (!e) return json({ ok: false, error: 'This link isn\'t valid. Ask the front desk for a new one.' }, 404);
      const { data: d } = await db.from('cb_days').select('location, grading_date').eq('day_id', e.day_id).maybeSingle();
      const info = { ok: true, first: first(e.full_name), belt_to: e.belt_to, school: d ? d.location : null, date: d ? d.grading_date : null, photo: false };
      if (!e.photo_path) return json({ ...info, error: 'The photo isn\'t ready yet. Please check again soon.' });
      const name = `${String(e.full_name || 'grading').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-AMA-grading.${(String(e.photo_path).match(/\.(jpe?g|png|webp)$/i) || [, 'jpg'])[1].toLowerCase()}`;
      const bucket = db.storage.from('grading-photos');
      const [{ data: v, error: ve }, { data: dl }] = await Promise.all([bucket.createSignedUrl(e.photo_path, 3600), bucket.createSignedUrl(e.photo_path, 3600, { download: name })]);
      if (ve || !v) return json({ ...info, error: 'The photo couldn\'t be loaded just now. Please try again soon.' }, 502);
      return json({ ...info, photo: true, url: v.signedUrl, download: (dl && dl.signedUrl) || v.signedUrl, filename: name });
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
  const env = { GHL_TOKEN: Deno.env.get('GHL_TOKEN'), GHL_LOCATION_ID: Deno.env.get('GHL_LOCATION_ID'), GHL_TEST: Deno.env.get('GHL_TEST') };
  Deno.serve(req => handle(req, db, env));
}
