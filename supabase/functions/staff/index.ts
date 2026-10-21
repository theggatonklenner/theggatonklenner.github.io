// @ts-nocheck
// AMA Grading Toolkit: staff logins for AMA ID Cards and Black Belt Prep, in one place.
//
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor, name it "staff",
// paste this whole file, Deploy. Then turn OFF "Verify JWT with legacy secret" (or "Enforce JWT verification") for the function
// (it checks the signed-in person itself).
//
// Only people who are an admin in BOTH apps can use it. It can:
//   list      every login, with its AMA ID Cards role and Black Belt Prep roles
//   create    add a login with a starting password and roles (or give an existing login roles)
//   password  set a new password for a login
//   roles     change a login's roles in either app
//   remove    delete a login and its roles in both apps

export const CARD_ROLES = ['admin', 'approver', 'photos', 'viewer', 'printer', 'pending'];
export const PREP_ROLES = ['admin', 'instructor', 'attendance', 'payments', 'grading', 'certificates', 'idcards', 'viewer'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function allUsers(db) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
const findUser = async (db, email) => (await allUsers(db)).find(u => (u.email || '').toLowerCase() === email) || null;

async function setRoles(db, email, cardRole, prepRoles) {
  if (cardRole !== undefined) {
    if (!CARD_ROLES.includes(cardRole)) throw new Error('Unknown AMA ID Cards role.');
    const { error } = await db.from('staff_roles').upsert({ email, role: cardRole });
    if (error) throw error;
  }
  if (prepRoles !== undefined) {
    const want = [...new Set((prepRoles || []).filter(r => PREP_ROLES.includes(r)))];
    // Add first, then remove, so the "always one admin" rule is never broken half way
    if (want.length) {
      const { error } = await db.from('prep_roles').upsert(want.map(role => ({ email, role })), { onConflict: 'email,role', ignoreDuplicates: true });
      if (error) throw error;
    }
    const { data: have, error: e2 } = await db.from('prep_roles').select('role').eq('email', email);
    if (e2) throw e2;
    const drop = (have || []).map(r => r.role).filter(r => !want.includes(r));
    if (drop.length) {
      const { error } = await db.from('prep_roles').delete().eq('email', email).in('role', drop);
      if (error) throw error;
    }
  }
}

// Last admin checks (each app must keep at least one admin)
async function checkAdmins(db, email, cardRole, prepRoles) {
  if (cardRole !== undefined && cardRole !== 'admin') {
    const { data } = await db.from('staff_roles').select('email').eq('role', 'admin');
    if (!(data || []).some(r => r.email !== email)) return 'AMA ID Cards must keep at least one admin.';
  }
  if (prepRoles !== undefined && !(prepRoles || []).includes('admin')) {
    const { data } = await db.from('prep_roles').select('email').eq('role', 'admin');
    if (!(data || []).some(r => r.email !== email)) return 'Black Belt Prep must keep at least one admin.';
  }
  return null;
}

export async function handle(req, db) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const [{ data: cardMine }, { data: prepMine }] = await Promise.all([
      db.from('staff_roles').select('role').eq('email', me).maybeSingle(),
      db.from('prep_roles').select('role').eq('email', me).eq('role', 'admin').maybeSingle()
    ]);
    if (!(cardMine && cardMine.role === 'admin' && prepMine)) return fail('Only people who are an admin in both AMA ID Cards and Black Belt Prep can manage staff logins.', 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === 'list') {
      const [users, cardRes, prepRes] = await Promise.all([allUsers(db), db.from('staff_roles').select('email, role'), db.from('prep_roles').select('email, role')]);
      if (cardRes.error) throw cardRes.error;
      if (prepRes.error) throw prepRes.error;
      const card = new Map((cardRes.data || []).map(r => [r.email, r.role]));
      const prep = new Map();
      (prepRes.data || []).forEach(r => prep.set(r.email, [...(prep.get(r.email) || []), r.role]));
      const rows = users.filter(u => u.email).map(u => {
        const email = u.email.toLowerCase();
        return { email, has_login: true, created_at: u.created_at, last_sign_in_at: u.last_sign_in_at || null,
                 card_role: card.get(email) || null, prep_roles: (prep.get(email) || []).sort() };
      });
      const seen = new Set(rows.map(r => r.email));
      // Roles given to an email that has no login yet
      new Set([...card.keys(), ...prep.keys()]).forEach(email => {
        if (!seen.has(email)) rows.push({ email, has_login: false, created_at: null, last_sign_in_at: null, card_role: card.get(email) || null, prep_roles: (prep.get(email) || []).sort() });
      });
      rows.sort((a, b) => a.email.localeCompare(b.email));
      return json({ me, users: rows, card_roles: CARD_ROLES, prep_roles: PREP_ROLES });
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return fail('Enter a valid email address.');
    const password = String(body.password || '');
    if (body.card_role !== undefined && body.card_role !== null && !CARD_ROLES.includes(body.card_role)) return fail('Unknown AMA ID Cards role.');

    if (action === 'create') {
      const existing = await findUser(db, email);
      if (!existing) {
        if (password.length < 8) return fail('The password needs at least 8 characters.');
        const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) return fail(error.message);
      } else if (password) {
        if (password.length < 8) return fail('The password needs at least 8 characters.');
        const { error } = await db.auth.admin.updateUserById(existing.id, { password });
        if (error) return fail(error.message);
      }
      await setRoles(db, email, body.card_role || 'pending', body.prep_roles || []);
      return json({ ok: true, existed: !!existing });
    }

    if (action === 'password') {
      if (password.length < 8) return fail('The password needs at least 8 characters.');
      const user = await findUser(db, email);
      if (!user) return fail('There is no login for that email.', 404);
      const { error } = await db.auth.admin.updateUserById(user.id, { password });
      if (error) return fail(error.message);
      return json({ ok: true });
    }

    if (action === 'roles') {
      if (email === me && ((body.card_role !== undefined && body.card_role !== 'admin') || (body.prep_roles !== undefined && !(body.prep_roles || []).includes('admin'))))
        return fail("You can't remove your own admin access.");
      const last = await checkAdmins(db, email, body.card_role, body.prep_roles);
      if (last) return fail(last);
      await setRoles(db, email, body.card_role, body.prep_roles);
      return json({ ok: true });
    }

    if (action === 'remove') {
      if (email === me) return fail("You can't remove yourself.");
      const last = await checkAdmins(db, email, 'pending', []);
      if (last) return fail(last);
      const { error: e1 } = await db.from('prep_roles').delete().eq('email', email);
      if (e1) throw e1;
      const { error: e2 } = await db.from('staff_roles').delete().eq('email', email);
      if (e2) throw e2;
      const user = await findUser(db, email);
      if (user) {
        await db.from('push_subscriptions').delete().eq('user_email', email); // phone notifications, if set up
        const { error } = await db.auth.admin.deleteUser(user.id);
        if (error) return fail(error.message);
      }
      return json({ ok: true });
    }

    return fail('Unknown action.');
  } catch (e) {
    console.error(e);
    return fail(String(e && e.message || e), 500);
  }
}

if (typeof Deno !== 'undefined') {
  const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  Deno.serve(req => handle(req, db));
}
