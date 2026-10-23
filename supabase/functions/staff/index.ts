// @ts-nocheck
// AMA Grading Toolkit: staff logins for AMA ID Cards, Black Belt Prep and the dojang TV, in one place.
//
// Deploy in Supabase: Edge Functions > Deploy a new function > Via Editor, name it "staff",
// paste this whole file, Deploy. Then turn OFF "Verify JWT with legacy secret" (or "Enforce JWT verification") for the function
// (it checks the signed-in person itself).
//
// Only people who are an admin in BOTH apps can use it. It can:
//   list      every login, with its AMA ID Cards, Black Belt Prep and TV permissions
//   create    add a login with a starting password and permissions (or update an existing login)
//   password  set a new password for a login
//   roles     change a login's permissions in either app
//   remove    delete a login and its permissions in both apps
// AMA ID Cards needs supabase/permissions.sql (tick-box permissions) from the ama-id-cards repository.
// TV permissions need supabase/tv-setup.sql from this repository (until then they're left out).

export const CARD_PERMS = ['admin', 'edit', 'delete', 'send', 'approve', 'viewer', 'printer'];
export const PREP_ROLES = ['admin', 'instructor', 'attendance', 'payments', 'grading', 'certificates', 'idcards', 'viewer'];
export const TV_PERMS = ['edit', 'remote'];
const APPS = {
  card: { table: 'staff_permissions', col: 'permission', allowed: CARD_PERMS, name: 'AMA ID Cards' },
  prep: { table: 'prep_roles', col: 'role', allowed: PREP_ROLES, name: 'Black Belt Prep' },
  tv: { table: 'tv_permissions', col: 'permission', allowed: TV_PERMS, name: 'Dojang TV' }
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const NEEDS_UPDATE = 'AMA ID Cards needs its tick-box permissions update first: run supabase/permissions.sql (from the ama-id-cards repository) in Supabase > SQL Editor.';

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
const clean = (list, allowed) => [...new Set((list || []).filter(r => allowed.includes(r)))];

// Make one app's permissions for this email exactly "want" (adds first, so an admin is never lost half way)
async function setPerms(db, app, email, want) {
  const A = APPS[app];
  if (want.length) {
    const { error } = await db.from(A.table).upsert(want.map(v => ({ email, [A.col]: v })), { onConflict: `email,${A.col}`, ignoreDuplicates: true });
    if (error) throw error;
  }
  const { data: have, error: e2 } = await db.from(A.table).select(A.col).eq('email', email);
  if (e2) throw e2;
  const drop = (have || []).map(r => r[A.col]).filter(v => !want.includes(v));
  if (drop.length) {
    const { error } = await db.from(A.table).delete().eq('email', email).in(A.col, drop);
    if (error) throw error;
  }
}

// Each app must keep at least one admin
async function lastAdmin(db, app, email, want) {
  if (want.includes('admin')) return null;
  const A = APPS[app];
  const { data } = await db.from(A.table).select('email').eq(A.col, 'admin');
  return (data || []).some(r => r.email !== email) ? null : `${A.name} must keep at least one admin.`;
}

export async function handle(req, db) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Use POST.', 405);
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.auth.getUser(token) : { data: null };
    const me = who && who.user && who.user.email ? who.user.email.toLowerCase() : null;
    if (!me) return fail('Sign in first.', 401);
    const cardReady = !(await db.from('staff_permissions').select('email').limit(1)).error;
    if (!cardReady) return fail(NEEDS_UPDATE, 409);
    const [{ data: cardMine }, { data: prepMine }] = await Promise.all([
      db.from('staff_permissions').select('permission').eq('email', me).eq('permission', 'admin').maybeSingle(),
      db.from('prep_roles').select('role').eq('email', me).eq('role', 'admin').maybeSingle()
    ]);
    if (!(cardMine && prepMine)) return fail('Only people who are an admin in both AMA ID Cards and Black Belt Prep can manage staff logins.', 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const tvReady = !(await db.from('tv_permissions').select('email').limit(1)).error;

    if (action === 'list') {
      const [users, cardRes, prepRes, tvRes] = await Promise.all([allUsers(db), db.from('staff_permissions').select('email, permission'), db.from('prep_roles').select('email, role'),
        tvReady ? db.from('tv_permissions').select('email, permission') : Promise.resolve({ data: [] })]);
      if (cardRes.error) throw cardRes.error;
      if (prepRes.error) throw prepRes.error;
      if (tvRes.error) throw tvRes.error;
      const card = new Map(), prep = new Map(), tv = new Map();
      (cardRes.data || []).forEach(r => card.set(r.email, [...(card.get(r.email) || []), r.permission]));
      (prepRes.data || []).forEach(r => prep.set(r.email, [...(prep.get(r.email) || []), r.role]));
      (tvRes.data || []).forEach(r => tv.set(r.email, [...(tv.get(r.email) || []), r.permission]));
      const order = (list, all) => (list || []).sort((a, b) => all.indexOf(a) - all.indexOf(b));
      const row = (email, u) => ({ email, has_login: !!u, created_at: u ? u.created_at : null, last_sign_in_at: u && u.last_sign_in_at || null,
        card_perms: order(card.get(email), CARD_PERMS), prep_roles: order(prep.get(email), PREP_ROLES), tv_perms: order(tv.get(email), TV_PERMS) });
      const rows = users.filter(u => u.email).map(u => row(u.email.toLowerCase(), u));
      const seen = new Set(rows.map(r => r.email));
      // Permissions given to an email that has no login yet
      new Set([...card.keys(), ...prep.keys(), ...tv.keys()]).forEach(email => { if (!seen.has(email)) rows.push(row(email, null)); });
      rows.sort((a, b) => a.email.localeCompare(b.email));
      return json({ me, users: rows, card_perms: CARD_PERMS, prep_roles: PREP_ROLES, tv_perms: tvReady ? TV_PERMS : null });
    }

    const email = String(body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return fail('Enter a valid email address.');
    const password = String(body.password || '');
    const cardWant = body.card_perms === undefined ? undefined : clean(body.card_perms, CARD_PERMS);
    const prepWant = body.prep_roles === undefined ? undefined : clean(body.prep_roles, PREP_ROLES);
    // "TV editor" includes the remote, so only one of the two is kept
    const tvWant = body.tv_perms === undefined || !tvReady ? undefined : (l => l.includes('edit') ? ['edit'] : l)(clean(body.tv_perms, TV_PERMS));

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
      await setPerms(db, 'card', email, cardWant || []);
      await setPerms(db, 'prep', email, prepWant || []);
      if (tvReady) await setPerms(db, 'tv', email, tvWant || []);
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
      if (email === me && ((cardWant && !cardWant.includes('admin')) || (prepWant && !prepWant.includes('admin'))))
        return fail("You can't remove your own admin access.");
      for (const [app, want] of [['card', cardWant], ['prep', prepWant]]) {
        if (!want) continue;
        const last = await lastAdmin(db, app, email, want);
        if (last) return fail(last);
      }
      if (cardWant) await setPerms(db, 'card', email, cardWant);
      if (prepWant) await setPerms(db, 'prep', email, prepWant);
      if (tvWant) await setPerms(db, 'tv', email, tvWant);
      return json({ ok: true });
    }

    if (action === 'remove') {
      if (email === me) return fail("You can't remove yourself.");
      for (const app of ['card', 'prep']) { const last = await lastAdmin(db, app, email, []); if (last) return fail(last); }
      await setPerms(db, 'prep', email, []);
      await setPerms(db, 'card', email, []);
      if (tvReady) await setPerms(db, 'tv', email, []);
      await db.from('staff_roles').delete().eq('email', email); // old single roles, if still there
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
