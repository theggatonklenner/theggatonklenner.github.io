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
// Starting state: Tate admin in both, Sam admin only in cards, Jo a viewer / instructor
for (const e of ['tate@ama.test', 'sam@ama.test', 'jo@ama.test']) await db.auth.admin.createUser({ email: e, password: 'password1' });
db._t.staff_permissions = [{ email: 'tate@ama.test', permission: 'admin' }, { email: 'sam@ama.test', permission: 'admin' }, { email: 'jo@ama.test', permission: 'viewer' }];
db._t.prep_roles = [{ email: 'tate@ama.test', role: 'admin' }, { email: 'jo@ama.test', role: 'instructor' }];
const TATE = db._login('tate@ama.test'), SAM = db._login('sam@ama.test'), JO = db._login('jo@ama.test');
const cardOf = e => db._t.staff_permissions.filter(x => x.email === e).map(x => x.permission).sort().join();
const prepOf = e => db._t.prep_roles.filter(x => x.email === e).map(x => x.role).sort().join();

const call = async (token, body, method = 'POST') => {
  const res = await handle(new Request('https://x.test/functions/v1/staff', { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), db);
  return { status: res.status, body: method === 'OPTIONS' ? null : await res.json().catch(() => null), headers: res.headers };
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
db._opts.permissionsMissing = true;
r = await call(TATE, { action: 'list' });
ok(r.status === 409 && /permissions\.sql/.test(r.body.error), 'explains that the ID Cards permissions update is needed first');
db._opts.permissionsMissing = false;

console.log('\nList');
r = await call(TATE, { action: 'list' });
const jo = r.body.users.find(u => u.email === 'jo@ama.test');
ok(r.status === 200 && r.body.users.length === 3 && r.body.me === 'tate@ama.test', 'lists every login');
ok(jo.card_perms.join() === 'viewer' && jo.prep_roles.join() === 'instructor' && jo.has_login, "shows each login's permissions in both apps");
ok(r.body.card_perms.length === 7, 'returns the 7 ID Cards permissions');

console.log('\nAdd a login');
r = await call(TATE, { action: 'create', email: 'New@AMA.test', password: 'short', card_perms: ['edit'], prep_roles: ['attendance'] });
ok(r.status === 400 && /8 characters/.test(r.body.error), 'password needs at least 8 characters');
r = await call(TATE, { action: 'create', email: 'not-an-email', password: 'longenough' });
ok(r.status === 400 && /valid email/.test(r.body.error), 'email must be valid');
r = await call(TATE, { action: 'create', email: 'New@AMA.test', password: 'longenough', card_perms: ['edit', 'send', 'made-up'], prep_roles: ['attendance', 'payments', 'made-up'] });
ok(r.status === 200 && !r.body.existed, 'login created');
ok(db._users.some(u => u.email === 'new@ama.test' && u.password === 'longenough'), 'email is saved in lower case with the starting password');
ok(cardOf('new@ama.test') === 'edit,send', 'ID Cards permissions ticked; unknown ones ignored');
ok(prepOf('new@ama.test') === 'attendance,payments', 'Black Belt Prep roles ticked; unknown ones ignored');
r = await call(TATE, { action: 'create', email: 'jo@ama.test', password: '', card_perms: ['edit', 'approve'], prep_roles: ['instructor', 'grading'] });
ok(r.status === 200 && r.body.existed && db._users.find(u => u.email === 'jo@ama.test').password === 'password1' && cardOf('jo@ama.test') === 'approve,edit', 'adding an existing login sets its ticks and keeps the password');

console.log('\nPassword');
r = await call(TATE, { action: 'password', email: 'jo@ama.test', password: 'newpassword' });
ok(r.status === 200 && db._users.find(u => u.email === 'jo@ama.test').password === 'newpassword', 'password reset');
r = await call(TATE, { action: 'password', email: 'nobody@ama.test', password: 'newpassword' });
ok(r.status === 404, 'reset for an unknown email is refused');

console.log('\nPermissions');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', card_perms: ['viewer', 'send'], prep_roles: ['viewer'] });
ok(r.status === 200 && cardOf('jo@ama.test') === 'send,viewer' && prepOf('jo@ama.test') === 'viewer', 'ticks changed in both apps');
r = await call(TATE, { action: 'roles', email: 'jo@ama.test', card_perms: [] });
ok(r.status === 200 && cardOf('jo@ama.test') === '' && prepOf('jo@ama.test') === 'viewer', 'all ID Cards access can be removed without touching Prep');
r = await call(TATE, { action: 'roles', email: 'tate@ama.test', card_perms: ['viewer'] });
ok(r.status === 400 && /your own admin/.test(r.body.error), "you can't remove your own admin access");

console.log('\nRemove');
r = await call(TATE, { action: 'remove', email: 'tate@ama.test' });
ok(r.status === 400 && /yourself/.test(r.body.error), "you can't remove yourself");
r = await call(TATE, { action: 'remove', email: 'new@ama.test' });
ok(r.status === 200 && !db._users.some(u => u.email === 'new@ama.test') && cardOf('new@ama.test') === '' && prepOf('new@ama.test') === '', 'login and permissions in both apps removed');
db._t.prep_roles.push({ email: 'sam@ama.test', role: 'admin' });
r = await call(SAM, { action: 'roles', email: 'tate@ama.test', prep_roles: ['viewer'] });
ok(r.status === 200, 'another admin can change your roles when an admin remains');
r = await call(SAM, { action: 'roles', email: 'sam@ama.test', prep_roles: ['viewer'] });
ok(r.status === 400, 'the last admin cannot be removed');

console.log('\nDojang TV');
const tvOf = e => db._t.tv_permissions.filter(x => x.email === e).map(x => x.permission).sort().join();
r = await call(SAM, { action: 'list' });
ok(r.body.tv_perms.join() === 'edit,party,remote' && Array.isArray(r.body.users[0].tv_perms), 'lists the TV permissions too');
r = await call(SAM, { action: 'create', email: 'tvonly@ama.test', password: 'longenough', card_perms: [], prep_roles: [], tv_perms: ['remote', 'bogus'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'remote' && cardOf('tvonly@ama.test') === '' && prepOf('tvonly@ama.test') === '', 'a login can have just the TV remote, and nothing in the other apps');
r = await call(SAM, { action: 'roles', email: 'tvonly@ama.test', tv_perms: ['party', 'remote'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'party,remote', 'party mode and the remote can be given together');
r = await call(SAM, { action: 'roles', email: 'tvonly@ama.test', tv_perms: ['edit', 'remote'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'edit', 'TV editor includes party mode and the remote, so it is kept on its own');
r = await call(SAM, { action: 'list' });
ok(r.body.users.find(u => u.email === 'tvonly@ama.test').tv_perms.join() === 'edit', 'and the list shows it');
r = await call(SAM, { action: 'roles', email: 'tvonly@ama.test', card_perms: ['viewer'] });
ok(r.status === 200 && tvOf('tvonly@ama.test') === 'edit' && cardOf('tvonly@ama.test') === 'viewer', "changing other apps leaves the TV ticks alone");
r = await call(SAM, { action: 'remove', email: 'tvonly@ama.test' });
ok(r.status === 200 && tvOf('tvonly@ama.test') === '', 'removing a login removes its TV access too');
db._opts.tvMissing = true;
r = await call(SAM, { action: 'list' });
ok(r.status === 200 && r.body.tv_perms === null, 'before the TV is set up, the TV section is left out');
r = await call(SAM, { action: 'create', email: 'later@ama.test', password: 'longenough', card_perms: ['viewer'], tv_perms: ['edit'] });
ok(r.status === 200 && cardOf('later@ama.test') === 'viewer', '...and logins can still be added');
db._opts.tvMissing = false;

console.log('\nHub mobile links');
r = await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '0412 345 678' });
ok(r.status === 200 && db._t.hub_logins.some(x => x.email === 'later@ama.test' && x.mobile9 === '412345678'), 'a login can be linked to a hub mobile (stored as its last 9 digits)');
r = await call(SAM, { action: 'list' });
ok(r.body.hub === true && r.body.users.find(u => u.email === 'later@ama.test').hub_mobile === '0412 345 678', 'the list shows the linked hub mobile');
r = await call(SAM, { action: 'hub', email: 'sam@ama.test', mobile: '+61412345678' });
ok(r.status === 400 && /already linked to later@ama\.test/.test(r.body.error), 'one mobile can only be linked to one login');
r = await call(SAM, { action: 'hub', email: 'nobody@ama.test', mobile: '0400000000' });
ok(r.status === 400 && /no login/.test(r.body.error), 'only existing logins can be linked');
r = await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '123' });
ok(r.status === 400, 'a short mobile is refused');
r = await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '' });
ok(r.status === 200 && !db._t.hub_logins.some(x => x.email === 'later@ama.test'), 'clearing the mobile removes the link');
await call(SAM, { action: 'hub', email: 'later@ama.test', mobile: '0412345678' });
r = await call(SAM, { action: 'remove', email: 'later@ama.test' });
ok(r.status === 200 && !db._t.hub_logins.some(x => x.email === 'later@ama.test'), 'removing a login removes its hub link');
db._opts.hubMissing = true;
r = await call(SAM, { action: 'list' });
ok(r.status === 200 && r.body.hub === false, 'before hub-login.sql is run, the list still works');
r = await call(SAM, { action: 'hub', email: 'sam@ama.test', mobile: '0400000000' });
ok(r.status === 409 && /hub-login\.sql/.test(r.body.error), '...and linking explains what to run');
db._opts.hubMissing = false;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
