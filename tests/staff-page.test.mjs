// Runs the Staff logins page in a headless browser at phone size, with the real staff function
// answering behind it (against the in-memory Supabase). Run: node tests/staff-page.test.mjs
// Needs Playwright and the supabase-js UMD file (set PLAYWRIGHT and SUPABASE_UMD if they live elsewhere).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDb } from './mock-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const UMD = readFileSync(process.env.SUPABASE_UMD || '/home/claude/black-belt-prep-system/tests/node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'utf8');
const tmp = join(mkdtempSync(join(tmpdir(), 'staff-')), 'staff.mjs');
writeFileSync(tmp, readFileSync(join(here, '../supabase/functions/staff/index.ts'), 'utf8'));
const { handle } = await import(pathToFileURL(tmp).href);

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

const db = makeDb();
for (const e of ['tate@ama.test', 'jo@ama.test']) await db.auth.admin.createUser({ email: e, password: 'password1' });
db._t.staff_permissions = [{ email: 'tate@ama.test', permission: 'admin' }, { email: 'jo@ama.test', permission: 'viewer' }];
db._t.prep_roles = [{ email: 'tate@ama.test', role: 'admin' }, { email: 'jo@ama.test', role: 'instructor' }];
let fnDeployed = true, oldFunction = false;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const errors = [];
await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: UMD }));
await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
await ctx.route('https://ptdrcxngaptcgswfbjhg.supabase.co/auth/v1/**', async r => {
  const url = r.request().url();
  if (url.includes('/token')) {
    const { email, password } = JSON.parse(r.request().postData() || '{}');
    const u = db._users.find(x => x.email === email && x.password === password);
    if (!u) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' }) });
    const tok = db._login(email);
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: tok, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: { id: u.id, email, aud: 'authenticated', role: 'authenticated' } }) });
  }
  if (url.includes('/logout')) return r.fulfill({ status: 204, body: '' });
  return r.fulfill({ contentType: 'application/json', body: '{}' });
});
await ctx.route('https://ptdrcxngaptcgswfbjhg.supabase.co/functions/v1/staff', async r => {
  if (oldFunction) return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ me: 'tate@ama.test', users: [{ email: 'tate@ama.test', has_login: true, card_role: 'admin', prep_roles: ['admin'] }], card_roles: ['admin'], prep_roles: ['admin'] }) });
  if (!fnDeployed) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"NOT_FOUND","message":"Requested function was not found"}' });
  const q = r.request();
  const res = await handle(new Request(q.url(), { method: q.method(), headers: q.headers(), body: q.method() === 'POST' ? q.postData() : undefined }), db);
  return r.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
});
const page = await ctx.newPage();
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const toastText = async () => { await page.waitForSelector('#toast:not([hidden])'); return page.textContent('#toast'); };
const toastSays = async t => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 5000 }).catch(() => {}); return page.textContent('#toast'); };
const settle = () => page.waitForTimeout(250);

try {
  await page.goto(pathToFileURL(join(here, '../staff/index.html')).href);
  await page.waitForSelector('#signIn:not([hidden])');
  ok(true, 'sign-in shows when not signed in');
  ok(await page.isVisible('#homeBtn') && (await page.getAttribute('#homeBtn', 'href')) === 'https://theggatonklenner.github.io/', 'home button goes back to the AMA Grading Toolkit');
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'wrong'); await page.click('#siGo');
  ok((await toastText()).includes('Wrong email or password'), 'wrong password is explained');
  await page.fill('#siPass', 'password1'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden]) #list [data-email]');
  const list = await page.textContent('#list');
  ok(list.includes('jo@ama.test') && list.includes('ID Cards: View only') && list.includes('Prep: Instructor'), 'list shows each login with roles in both apps');
  ok(list.includes('You') && (await page.textContent('#list [data-email="tate@ama.test"]')).includes('Admin'), 'you are marked, and admins get the gold Admin chip');

  // Add a login
  await page.click('#addBtn'); await page.fill('#addEmail', 'Coach@AMA.test'); await page.fill('#addPw', 'short'); await page.click('#addGo');
  ok((await toastText()).includes('8 characters'), 'short starting password is refused');
  await page.click('#addGen');
  const pw = await page.inputValue('#addPw');
  ok(pw.length === 12, '"Make one" fills in a 12-character password');
  await page.check('#cardChecks input[value="edit"]'); await page.check('#cardChecks input[value="send"]');
  await page.check('#prepChecks input[value="attendance"]'); await page.check('#prepChecks input[value="payments"]');
  await page.click('#addGo');
  await page.waitForSelector('#list [data-email="coach@ama.test"]');
  ok(db._users.some(u => u.email === 'coach@ama.test' && u.password === pw), 'login created with the starting password');
  ok((await page.textContent('#list [data-email="coach@ama.test"]')).includes('ID Cards: Edit people, Send to print') && (await page.textContent('#list [data-email="coach@ama.test"]')).includes('Attendance, Payments'), 'new login shows its roles');
  ok((await page.textContent('#list [data-email="coach@ama.test"]')).includes('Never signed in'), 'new login shows it has never signed in');
  await page.screenshot({ path: process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'staff-list.png') : join(tmpdir(), 'staff-list.png') });

  // Change roles
  await page.click('#list [data-email="jo@ama.test"]'); await page.waitForSelector('#rolesForm');
  ok((await page.$$('#cardChecks input')).length === 7 && (await page.$$('#prepChecks input')).length === 8, 'both apps show tick boxes, laid out the same way');
  await page.uncheck('#cardChecks input[value="viewer"]'); await page.check('#cardChecks input[value="approve"]'); await page.check('#cardChecks input[value="edit"]');
  await page.check('#prepChecks input[value="grading"]'); await page.uncheck('#prepChecks input[value="instructor"]');
  await page.screenshot({ path: process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'staff-person.png') : join(tmpdir(), 'staff-person.png') });
  await page.click('#saveRoles'); await settle();
  await page.waitForFunction(() => document.querySelector('#list [data-email="jo@ama.test"]').textContent.includes('Approve prints'));
  ok(db._t.staff_permissions.filter(x => x.email === 'jo@ama.test').map(x => x.permission).sort().join() === 'approve,edit' && db._t.prep_roles.filter(x => x.email === 'jo@ama.test').map(x => x.role).join() === 'grading', 'roles saved in both apps');

  // Dojang TV
  ok((await page.textContent('#list [data-email="tate@ama.test"]')).includes('TV: Admin'), 'the list shows TV access (admins always have it)');
  await page.click('#addBtn'); await page.fill('#addEmail', 'tvonly@ama.test'); await page.click('#addGen');
  ok((await page.$$('#tvChecks input[type=radio]')).length === 3 && await page.isChecked('#tvChecks input[value=""]'), 'adding a login has a Dojang TV choice, No access to start with');
  await page.check('#tvChecks input[value="remote"]'); await page.click('#addGo');
  await page.waitForSelector('#list [data-email="tvonly@ama.test"]');
  const tvRow = await page.textContent('#list [data-email="tvonly@ama.test"]');
  ok(tvRow.includes('TV: Remote only') && tvRow.includes('ID Cards: No access') && tvRow.includes('Prep: No access'), 'a login can have just the TV remote and nothing else');
  await page.click('#list [data-email="tvonly@ama.test"]'); await page.waitForSelector('#tvChecks');
  ok(await page.isChecked('#tvChecks input[value="remote"]'), 'their TV choice shows when opened');
  await page.check('#tvChecks input[value="edit"]');
  await page.screenshot({ path: process.env.SHOT_DIR ? join(process.env.SHOT_DIR, 'staff-tv.png') : join(tmpdir(), 'staff-tv.png') });
  await page.click('#saveRoles');
  await page.waitForFunction(() => document.querySelector('#list [data-email="tvonly@ama.test"]').textContent.includes('TV: Editor'));
  ok(db._t.tv_permissions.filter(x => x.email === 'tvonly@ama.test').map(x => x.permission).join() === 'edit', 'changed to the TV editor');
  db._opts.tvMissing = true;
  await page.reload(); await page.waitForSelector('#list [data-email]');
  await page.click('#list [data-email="tvonly@ama.test"]'); await page.waitForSelector('#rolesForm');
  ok((await page.textContent('#rolesForm')).includes('first run supabase/tv-setup.sql') && !(await page.$('#tvChecks')), 'before the TV is set up, it says what to run');
  await page.evaluate(() => document.querySelector('#dlg').close());
  db._opts.tvMissing = false;
  await page.reload(); await page.waitForSelector('#list [data-email]');

  // Password
  await page.click('#list [data-email="jo@ama.test"]'); await page.waitForSelector('#pwForm');
  await page.fill('#newPw', 'brandnewpass'); await page.click('#savePw');
  ok((await toastSays('Password set')).includes('Password set') && db._users.find(u => u.email === 'jo@ama.test').password === 'brandnewpass', 'new password set');

  // Own admin
  await page.click('#rolesForm ~ * .x, #dlg [data-close]').catch(() => {});
  await page.evaluate(() => document.querySelector('#dlg').close());
  await page.click('#list [data-email="tate@ama.test"]'); await page.waitForSelector('#rolesForm');
  ok(!(await page.$('#removeBtn')), "you can't remove yourself (no Remove button)");
  await page.uncheck('#cardChecks input[value="admin"]'); await page.click('#saveRoles');
  ok((await toastSays('own admin')).includes('own admin'), "removing your own admin access is refused, with the reason shown above the window");
  ok(await page.evaluate(() => document.querySelector('#toast').matches(':popover-open')), 'messages show on top of the open window');
  await page.evaluate(() => document.querySelector('#dlg').close());

  // Remove
  await page.click('#list [data-email="coach@ama.test"]'); await page.waitForSelector('#removeBtn');
  await page.click('#removeBtn'); await page.waitForSelector('#cfYes');
  ok((await page.textContent('#dlg')).includes('no longer be able to sign in'), 'remove asks first');
  await page.click('#cfYes');
  await page.waitForFunction(() => !document.querySelector('#list [data-email="coach@ama.test"]'));
  ok(!db._users.some(u => u.email === 'coach@ama.test') && !db._t.prep_roles.some(x => x.email === 'coach@ama.test'), 'login and roles removed');

  // Search
  await page.fill('#search', 'jo');
  ok((await page.$$('#list [data-email]')).length === 1, 'search filters the list');
  await page.fill('#search', '');

  // Function not deployed
  fnDeployed = false;
  await page.reload(); await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('Deploy a new function'), 'explains how to set up the function if it is missing');
  fnDeployed = true;
  await page.click('#retry'); await page.waitForSelector('#app:not([hidden])');
  ok(true, 'Try again works once it is set up');

  // Older copy of the function deployed (single ID Cards role)
  oldFunction = true;
  await page.reload(); await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('older copy') && !(await page.textContent('#problem')).includes('undefined'), 'an older staff function is explained (update it), not a crash');
  oldFunction = false;
  await page.click('#retry'); await page.waitForSelector('#app:not([hidden])');

  // Not an admin in both
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.fill('#siEmail', 'jo@ama.test'); await page.fill('#siPass', 'brandnewpass'); await page.click('#siGo');
  await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('admin in both'), 'someone who is not an admin in both apps is told why they cannot use it');

  ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scrolling at phone size');
  ok(errors.length === 0, 'no errors in the browser console' + (errors.length ? ': ' + errors.join(' / ') : ''));
} catch (e) {
  ok(false, 'stopped: ' + e.message.split('\n').slice(0, 3).join(' / '));
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
