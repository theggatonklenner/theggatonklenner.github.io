// Tests the "staff" Edge Function against an in-memory stand-in for Supabase.
// Run: node tests/staff-function.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../supabase/functions/staff/index.ts'), 'utf8');
const tmp = join(mkdtempSync(join(tmpdir(), 'staff-')), 'staff.mjs');
writeFileSync(tmp, src);
const { handle } = await import(pathToFileURL(tmp).href);
const { makeDb } = await import('./mock-db.mjs');

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const db = makeDb();
// Starting state: Tate admin in both, Sam admin only in cards, Jo an instructor
for (const e of ['tate@ama.test', 'sam@ama.test', 'jo@ama.test']) await db.auth.admin.createUser({ email: e, password: 'password1' });
db._t.staff_roles = [{ email: 'tate@ama.test', role: 'admin' }, { email: 'sam@ama.test', role: 'admin' }, { email: 'jo@ama.test', role: 'viewer' }];
db._t.prep_roles = [{ email: 'tate@ama.test', role: 'admin' }, { email: 'jo@ama.test', role: 'instructor' }];
const TATE = db._login('tate@ama.test'), SAM = db._login('sam@ama.test'), JO = db._login('jo@ama.test');

const call = async (token, body, method = 'POST') => {
  const res = await handle(new Request('https://x.test/functions/v1/staff', { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), db);
  return { status: res.status, body: res.status === 200 && method === 'OPTIONS' ? null : await res.json().catch(() => null), headers: res.headers };
};

console.log('\nWho can use it');
let r = await call(null, { action: 'list' });
ok(r.status === 401, 'not signed in is refused');
r = await call(JO, { action: 'list' });
ok(r.status === 403, 'a non-admin is refused');
r = await call(SAM, { action: 'list' });
ok(r.status === 403 && /both/.test(r.body.error), 'an admin in only one app is refused');
r = await call(TATE, {}, 'OPTIONS');
ok(r.status === 200 && r.headers.get('access-control-allow-origin') === '*', 'browser pre-check (CORS) is answered');

console.log('\nList');
r = await call(TATE, { action: 'list' });
const jo = r.body.users.find(u => u.email === 'jo@ama.test');
ok(r.status === 200 && r.body.users.length === 3 && r.body.me === 'tate@ama.test', 'lists every login');
ok(jo.card_role === 'viewer' && jo.prep_roles.join() === 'instructor' && jo.has_login, 'shows each login\'s role in both apps');

console.log('\nAdd a login');
r = await call(TATE, { action: 'create', email: 'New@AMA.test', password: 'short', card_role: 'photos', prep_roles: ['attendance'] });
ok(r.status === 400 && /8 characters/.test(r.body.error), 'password needs at least 8 characters');
r = await call(TATE, { action: 'create', email: 'not-an-email', password: 'longenough' });
ok(r.status === 400 && /valid email/.test(r.body.error), 'email must be valid');
r = await call(TATE, { action: 'create', email: 'New@AMA.test', password: 'longenough', card_role: 'photos', prep_roles: ['attendance', 'payments', 'made-up'] });
ok(r.status === 200 && !r.body.existed, 'login created');
ok(db._users.some(u => u.email === 'new@ama.test' && u.password === 'longenough'), 'email is saved in lower case with the starting password');
ok(db._t.staff_roles.find(x => x.email === 'new@ama.test').role === 'photos', 'AMA ID Cards role set (replaces "no access")');
ok(db._t.prep_roles.filter(x => x.email === 'new@ama.test').map(x => x.role).sort().join() === 'attendance,payments', 'Black Belt Prep roles set; unknown roles ignored');
r = await call(TATE, { action: 'create', email: 'jo@ama.test', password: '', card_role: 'approver', prep_roles: ['instructor', 'grading'] });
ok(r.status === 200 && r.body.existed && db._users.find(u => u.email === 'jo@ama.test').password === 'password1', 'adding an existing login just updates roles and keeps the password');

console.log('\nPassword');
r = await call(TATE, { action: 'password', email: 'jo@ama.test', password: 'newpassword' });
ok(r.status === 200 && db._users.find(u => u.email === 'jo@ama.test').password === 'newpassword', 'password reset');
r = await call(TATE, { action: 'password', email: 'nobody@ama.test', password: 'newpassword' });
ok(r.status === 404, 'reset for an unknown email is refused');

console.log('\nRoles');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', card_role: 'pending', prep_roles: ['viewer'] });
ok(r.status === 200 && db._t.staff_roles.find(x => x.email === 'jo@ama.test').role === 'pending' && db._t.prep_roles.filter(x => x.email === 'jo@ama.test').map(x => x.role).join() === 'viewer', 'roles changed in both apps (instructor and grading removed)');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', prep_roles: [] });
ok(r.status === 200 && !db._t.prep_roles.some(x => x.email === 'jo@ama.test'), 'all Black Belt Prep access can be removed');
r = await call(TATE, { action: 'roles', email: 'tate@ama.test', card_role: 'viewer' });
ok(r.status === 400 && /your own admin/.test(r.body.error), "you can't remove your own admin access");
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', card_role: 'superuser' });
ok(r.status === 400 && /Unknown/.test(r.body.error), 'unknown card role is refused');

console.log('\nRemove');
r = await call(TATE, { action: 'remove', email: 'tate@ama.test' });
ok(r.status === 400 && /yourself/.test(r.body.error), "you can't remove yourself");
r = await call(TATE, { action: 'remove', email: 'new@ama.test' });
ok(r.status === 200 && !db._users.some(u => u.email === 'new@ama.test') && !db._t.staff_roles.some(x => x.email === 'new@ama.test') && !db._t.prep_roles.some(x => x.email === 'new@ama.test'), 'login and roles in both apps removed');
// Make Sam an admin in both, then the only prep admin left is Tate: removing Tate's prep admin via Sam is blocked
db._t.prep_roles.push({ email: 'sam@ama.test', role: 'admin' });
r = await call(SAM, { action: 'roles', email: 'tate@ama.test', prep_roles: ['viewer'] });
ok(r.status === 200, 'another admin can change your roles when an admin remains');
r = await call(SAM, { action: 'roles', email: 'sam@ama.test', prep_roles: ['viewer'] });
ok(r.status === 400, 'the last admin cannot be removed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
