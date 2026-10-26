// Browser test for coloured belt grading (/grading/coloured-belts/), the booking page and the /grading/ hub.
// Uses Black Belt Prep's test stand-in for Supabase (a real Postgres in memory) with supabase/coloured-belts.sql.
// Run: node tests/coloured-belts-page.test.mjs   (needs ../black-belt-prep-system/tests with its node_modules, and Playwright)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PREP_TESTS = process.env.PREP_TESTS || '/home/claude/black-belt-prep-system/tests';
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || '/home/claude/theggatonklenner/ama-id-cards';
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const { startServer } = await import(pathToFileURL(join(PREP_TESTS, 'fake-supabase.mjs')).href);
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const read = p => readFileSync(p, 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- Database ----
const db = new PGlite();
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'tate@ama.test'), ('00000000-0000-0000-0000-000000000002', 'coach@ama.test'), ('00000000-0000-0000-0000-000000000003', 'desk@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 14; i++) await db.exec(read(join(PREP, `supabase/prep-update-${String(i).padStart(2, '0')}.sql`)));
await db.exec(read(join(ROOT, 'supabase/coloured-belts.sql')));
await db.exec(read(join(ROOT, 'supabase/coloured-belts-2.sql')));
await db.exec(`insert into prep_roles (email, role) values ('tate@ama.test', 'admin') on conflict do nothing; delete from prep_roles where email <> 'tate@ama.test'; insert into prep_roles (email, role) values ('coach@ama.test', 'instructor'), ('desk@ama.test', 'attendance');`);
// EFC students (made up): Sam and Kim have enough classes; Alex is overdue; Jo is at another school
await db.exec(`insert into efc_members (member_key, kind, full_name, guardian_name, phone, location, programme, belt, promoted_on, attended_since_promoted, efc_reference) values
  ('efc:m1', 'member', 'Sam Lee', 'Pat Lee', '0412 345 678', 'Marrickville', 'Taekwondo', 'Yellow Belt', current_date - 100, 30, 'AU-023-1'),
  ('efc:m2', 'member', 'Kim Ng', 'Jo Ng', '0412 000 111', 'Marrickville', 'Taekwondo', 'White Belt', current_date - 90, 26, 'AU-023-2'),
  ('efc:m3', 'member', 'Alex Kim', null, null, 'Marrickville', 'Taekwondo', 'Green Belt', current_date - 300, 5, 'AU-023-3'),
  ('efc:m4', 'member', 'Jo Bloggs', 'Mo Bloggs', '0412 000 222', 'Concord', 'Taekwondo', 'Red Three Belt', current_date - 95, 40, 'AU-258-4'),
  ('efc:m5', 'member', 'Black Belt', null, null, 'Marrickville', 'Taekwondo', 'Black Belt: First Dan', current_date - 95, 40, 'AU-023-5'),
  ('efc:m6', 'member', 'Little One', null, null, 'Marrickville', 'Taekwondo - Little Dragon', 'Yellow Belt', current_date - 95, 40, 'AU-023-6')`);
// Ages: Kim is the youngest, then Sam, then Jo
await db.exec(`update efc_members set date_of_birth = to_char(current_date - interval '11 years 2 months', 'YYYY-MM-DD') where member_key = 'efc:m1';
  update efc_members set date_of_birth = to_char(current_date - interval '8 years 1 month', 'YYYY-MM-DD') where member_key = 'efc:m2';
  update efc_members set date_of_birth = to_char(current_date - interval '14 years 3 months', 'YYYY-MM-DD') where member_key = 'efc:m4';`);

const users = { 'tate@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw' }, 'coach@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw' }, 'desk@ama.test': { id: '00000000-0000-0000-0000-000000000003', password: 'pw' } };
const server = await startServer({ db, appDir: ROOT, users, config: '' });
const BASE = `http://localhost:${server.address().port}`;
const q = server.q;
const configJs = `window.TOOLKIT_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_KEY: 'test' };`;
const fnCalls = [];
const browser = await chromium.launch();
async function open(email, path = '/grading/coloured-belts/index.html') {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  // The "cb" function (tested on its own in cb-function.test.mjs): texts are recorded here
  await ctx.route('**/functions/v1/cb', async r => {
    const b = JSON.parse(r.request().postData() || '{}'); fnCalls.push(b);
    if (b.action === 'check') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ready: true, testing: true }) });
    if (b.action === 'send') {
      for (const it of b.items) if (b.kind === 'invite' && it.entry_id) await q(`update cb_entries set invited_at = now() where entry_id = '${it.entry_id}'`);
      for (const it of b.items) await q(`insert into cb_messages (entry_id, member_key, kind, body, status) values (${it.entry_id ? `'${it.entry_id}'` : 'null'}, '${it.member_key}', '${b.kind}', $1, 'test')`, [it.body]);
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ sent: b.items.length, results: b.items.map(() => ({ ok: true })), testing: true }) });
    }
    if (b.action === 'info' || b.action === 'book') return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, first: 'Sam', belt_to: 'Orange Belt', date: '2026-11-14', time: '10:00', school: 'Marrickville', fee: 55, booked: b.action === 'book', closed: false }) });
    r.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"?"}' });
  });
  // Like GitHub Pages: an address that isn't a file gets the site's 404.html
  await ctx.route(/\/grading\/coloured-belts\/(ready|grading-days|update-efc|dashboard|settings)(\/|$)/, r => r.fulfill({ status: 404, contentType: 'text/html', body: read(join(ROOT, '404.html')) }));
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('  page error: ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE + path);
  if (email) {
    await page.waitForSelector('#siForm');
    await page.fill('#siEmail', email); await page.fill('#siPass', 'pw'); await page.click('#siGo');
    await page.waitForFunction(() => !document.querySelector('#tabs').hidden || !document.querySelector('#noAccess').hidden);
  }
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 5000 }).catch(() => {}); return page.textContent('#toast'); };
const settle = page => page.waitForTimeout(400);
const SHOTS = process.env.SHOT_DIR; const shot = (page, n) => SHOTS ? page.screenshot({ path: join(SHOTS, n + '.png'), fullPage: true }) : null;
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

try {
  console.log('Who\'s ready');
  let { ctx, page } = await open('tate@ama.test');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/ready', 'the first screen has its own address (/grading/coloured-belts/ready)');
  await shot(page, 'cb-ready');
  let list = await page.textContent('#readyList');
  ok(list.includes('Sam Lee') && list.includes('Kim Ng') && list.includes('Jo Bloggs') && !list.includes('Alex Kim'), 'students with enough classes are listed (24 by default); Alex (5 classes) is not');
  ok(!list.includes('Black Belt') && !list.includes('Little One'), 'black belts and Little Dragons are left out');
  ok((await page.textContent('#readyList [data-key="efc:m1"]')).includes('30/24 classes') && (await page.textContent('#readyList [data-key="efc:m1"]')).includes('Yellow to Orange'), 'each row shows classes against what the belt needs, and the belt they grade to');
  const order = async () => page.$$eval('#readyList [data-key]', bs => bs.map(b => b.dataset.key).join());
  ok(await order() === 'efc:m2,efc:m1,efc:m4', 'the list is in age order, youngest first (Kim 8, Sam 11, Jo 14)');
  ok((await page.textContent('#readyList [data-key="efc:m2"]')).includes('8 yrs'), 'each row shows the student\'s age');
  await page.selectOption('#fSort', 'age_desc');
  ok(await order() === 'efc:m4,efc:m1,efc:m2', 'or oldest first');
  await page.selectOption('#fSort', 'name');
  ok(await order() === 'efc:m4,efc:m2,efc:m1', 'or by name');
  await page.selectOption('#fSort', 'age');
  await page.selectOption('#fBelt', 'White Belt');
  ok(await order() === 'efc:m2', 'filter by belt');
  await page.selectOption('#fBelt', '');
  await page.selectOption('#fShow', 'overdue');
  ok((await page.textContent('#readyList')).includes('Alex Kim') && (await page.textContent('#readyList')).includes('Overdue'), 'Overdue shows students on their belt for twice the usual time');
  await page.selectOption('#fShow', 'eligible'); await page.selectOption('#fSchool', 'Marrickville');
  ok(!(await page.textContent('#readyList')).includes('Jo Bloggs'), 'filter by school');
  await page.click('#readyList [data-key="efc:m1"]'); await page.waitForSelector('#apReady');
  await page.click('#apReady'); await toastSays(page, 'Marked ready');
  ok((await q(`select status, belt from cb_approvals where member_key = 'efc:m1'`))[0]?.status === 'ready', 'an instructor marks a student ready (for their current belt)');
  await page.click('#dlg [data-close]');
  await page.click('#readyList [data-key="efc:m2"]'); await page.waitForSelector('#apNot');
  await page.fill('#apNote', 'Practise your first pattern at home.'); await page.click('#apNot'); await toastSays(page, 'not yet');
  await page.waitForSelector('#apText'); await page.click('#apText'); await page.waitForSelector('#txPrev');
  const prev = await page.textContent('#txPrev');
  ok(prev.includes('Hi Jo') && prev.includes('Kim') && prev.includes('Practise your first pattern at home.'), '"Not yet" texts use the parent\'s name and the instructor\'s note');
  await page.click('#txGo'); await toastSays(page, 'sent');
  ok(fnCalls.some(c => c.action === 'send' && c.kind === 'not_ready' && c.items[0].member_key === 'efc:m2'), 'and are sent through the cb function');
  await q(`update efc_members set belt = 'Orange Belt' where member_key = 'efc:m2'`);
  ok(!(await q(`select approval from cb_students where member_key = 'efc:m2'`))[0].approval, 'a new belt in EFC starts the ready / not yet decision fresh');
  await q(`update efc_members set belt = 'White Belt' where member_key = 'efc:m2'`);

  console.log('\nGrading days');
  await page.click('.tab[data-view="days"]');
  await page.click('#newDay'); await page.waitForSelector('#dayForm');
  await page.selectOption('#dSchool', 'Marrickville'); await page.fill('#dDate', '2030-11-14'); await page.fill('#dTime', '10:00'); await page.fill('#dSess', 'Coloured Belt Grading');
  ok((await page.$$('#dBelts input:checked')).length === 10, 'a new grading day starts with every belt ticked');
  await page.click('#dNone'); await page.check('#dBelts input[value="White Belt"]'); await page.check('#dBelts input[value="Yellow Belt"]');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/grading-days', 'Grading days is at /grading/coloured-belts/grading-days');
  await page.click('#dGo'); await page.waitForSelector('#addReady');
  const dayId = (await q(`select day_id from cb_days`))[0].day_id;
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/grading-days/' + dayId, 'each grading day has its own address');
  ok((await page.textContent('#view-day')).includes('Marrickville') && (await page.textContent('#view-day')).includes('10:00am'), 'a grading day is added for a school, date and time');
  ok((await q(`select belts from cb_days`))[0].belts.join() === 'White Belt,Yellow Belt' && (await page.textContent('#view-day')).includes('White, Yellow'), 'and for the belts chosen (White and Yellow)');
  await q(`insert into cb_approvals (member_key, belt, status) values ('efc:m3', 'Green Belt', 'ready')`);   // Alex: Green, ready, but not a belt for this day
  await page.evaluate(() => loadAll().then(render)); await page.waitForSelector('#addReady');
  await page.click('#addReady'); await toastSays(page, 'Added');
  let entries = await q(`select full_name, belt_from, belt_to from cb_entries order by full_name`);
  ok(entries.length === 1 && entries[0].full_name === 'Sam Lee' && entries[0].belt_to === 'Orange Belt', '"Add everyone marked ready" adds only ready students at that school on the day\'s belts (Sam; Kim is "not yet", Alex is Green)');
  await page.click('#addOne'); await page.fill('#psQ', 'Alex'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('No one matches'), 'adding by hand only offers students on the day\'s belts');
  await page.fill('#psQ', 'Kim'); await page.click('#psList [data-key="efc:m2"]');
  ok(await until(async () => (await q(`select count(*)::int n from cb_entries`))[0].n === 2), 'a student can also be added by hand');
  await page.waitForSelector('#entryList [data-entry]:has-text("Kim Ng")');
  ok((await page.$$eval('#entryList [data-entry] .name', ns => ns.map(n => n.textContent).join())) === 'Kim Ng,Sam Lee', 'the grading day list is in age order too (Kim before Sam)');
  ok((await page.textContent('#entryList')).includes('11 yrs'), '...with ages');
  await page.selectOption('#dfBelt', 'White Belt');
  ok((await page.textContent('#entryList')).includes('Kim Ng') && !(await page.textContent('#entryList')).includes('Sam Lee'), 'a grading day can be filtered by belt');
  await page.selectOption('#dfBelt', '');
  await page.click('#sendInv'); await page.waitForSelector('#txPrev');
  const inv = await page.textContent('#txPrev');
  const sam = (await q(`select token from cb_entries where member_key = 'efc:m1'`))[0], kim = (await q(`select token from cb_entries where member_key = 'efc:m2'`))[0];
  ok(inv.includes('Hi Jo') && inv.includes('Yellow Belt') && inv.includes('Thursday 14 November') && inv.includes('at 10:00am') && inv.includes('/grading/coloured-belts/book/#t=' + kim.token), 'the invitation preview has the date, time, belt and the family\'s own booking link');
  await page.click('#txGo');
  ok(await until(async () => (await q(`select count(*)::int n from cb_entries where invited_at is not null`))[0].n === 2), 'invited students are marked invited');
  ok(fnCalls.some(c => c.kind === 'invite' && c.items.length === 2 && c.items.some(i => i.body.includes('Hi Pat') && i.body.includes(sam.token))), 'each family gets their own text with their own link');
  await q(`update cb_entries set booked_at = now() where member_key = 'efc:m1'`);
  await page.evaluate(() => loadAll().then(render)); await settle(page);
  ok((await page.textContent('#entryList [data-entry]:has-text("Sam Lee")')).includes('Booked'), 'booked students show Booked (from the family\'s booking link)');
  ok((await page.textContent('#sendNotBooked')).includes('(1)') && (await page.textContent('#sendReminder')).includes('(1)') && (await page.textContent('#sendUnpaid')).includes('(1)'), 'reminders: to book (Kim, invited), grading day (Sam, booked), fee (Sam, unpaid)');
  await page.click('#sendReminder'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('15 minutes early') && (await page.textContent('#txPrev')).includes('Thursday 14 November'), 'the grading day reminder has its own wording');
  await page.click('#txGo');
  ok(await until(() => fnCalls.some(c => c.kind === 'reminder' && c.items.length === 1 && c.items[0].member_key === 'efc:m1')), 'and goes to booked families');
  await page.waitForSelector('#sendNotBooked'); await page.click('#sendNotBooked'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('/grading/coloured-belts/book/#t=' + kim.token), 'the reminder to book includes their booking link');
  await page.click('#dlg [data-close]');
  await shot(page, 'cb-day');
  const gr = await page.textContent('#view-day');
  ok(gr.includes('Getting ready') && /Orange Belt\s*1\s*1/.test(await page.textContent('#view-day table')), 'Getting ready counts the belts and certificates needed');

  console.log('\nPaid, results, certificates');
  await page.click('#entryList [data-entry]:has-text("Sam Lee")'); await page.waitForSelector('#paidBtn');
  await page.click('#paidBtn'); await toastSays(page, 'Marked paid');
  ok((await q(`select paid from cb_entries where member_key = 'efc:m1'`))[0].paid === true, 'paid can be ticked');
  await page.click('#dlg [data-close]');
  await page.click('#resultsBtn'); await page.waitForSelector('.res');
  ok(new URL(page.url()).pathname.endsWith(dayId + '/results'), 'results have their own address too (.../results)');
  await page.click('.rescard:has-text("Sam Lee") button[data-r="distinction"]'); await settle(page);
  await page.click('.rescard:has-text("Kim Ng") button[data-r="retest"]'); await settle(page);
  ok((await q(`select result from cb_entries where member_key = 'efc:m1'`))[0].result === 'distinction' && (await q(`select result from cb_entries where member_key = 'efc:m2'`))[0].result === 'retest', 'results are entered on a tablet with big buttons and saved straight away');
  ok((await page.textContent('#resCount')).includes('2 of 2'), 'it counts how many are done');
  if (SHOTS) { await page.setViewportSize({ width: 390, height: 844 }); await shot(page, 'cb-results-phone'); await page.setViewportSize({ width: 1100, height: 900 }); }
  await page.click('#backDay'); await page.waitForSelector('#csvPassed');
  const dl = page.waitForEvent('download'); await page.click('#csvPassed'); const file = await dl;
  const csv = readFileSync(await file.path(), 'utf8');
  ok(csv.includes('Full name,Belt going for,Date') && csv.includes('Sam Lee,Orange Belt,14 November 2030') && !csv.includes('Kim Ng'), 'the certificates CSV has full name, belt going for and date, for those who passed');
  await page.click('#sendCongrats'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('with distinction') && (await page.textContent('#txPrev')).includes('Orange Belt'), 'congratulations texts mention a distinction');
  await page.click('#txGo');
  ok(await until(() => page.isDisabled('#sendCongrats').catch(() => false)), 'once sent, congratulations are not offered again');
  await page.click('#sendRetest'); await page.waitForSelector('#txPrev');
  ok((await page.textContent('#txPrev')).includes('re-test') && (await page.textContent('#txPrev')).includes('Hi Jo'), 'a kind re-test message goes to re-test families');
  await page.click('#txGo');
  ok(await until(() => page.isDisabled('#sendRetest').catch(() => false)), 'and is not offered again once sent');

  console.log('\nStudents from other schools');
  await page.click('.tab[data-view="days"]'); await page.click('#newDay'); await page.waitForSelector('#dayForm');
  await page.selectOption('#dSchool', 'Concord'); await page.fill('#dDate', '2030-12-05');
  ok(await page.isChecked('#dFrom input[value="Concord"]') && !(await page.isChecked('#dFrom input[value="Marrickville"]')), 'a new day takes its own school\'s students to start with');
  await page.check('#dFrom input[value="Marrickville"]');
  await page.click('#dGo'); await page.waitForSelector('#addReady');
  const cDay = (await q(`select day_id, schools from cb_days where location = 'Concord'`))[0];
  ok(cDay.schools.join() === 'Marrickville,Concord' && (await page.textContent('#view-day')).includes('students from Marrickville, Concord'), 'a Concord grading day can take Marrickville students too');
  await page.click('#addReady'); await toastSays(page, 'Added');
  ok((await q(`select member_key from cb_entries where day_id = '${cDay.day_id}'`)).map(r => r.member_key).join() === 'efc:m3', '"Add everyone marked ready" adds ready Marrickville students (Alex) to the Concord day');
  ok((await page.textContent('#entryList')).includes('from Marrickville'), 'the list shows they come from Marrickville');
  ok(!(await q(`select 1 from cb_entries where day_id = '${cDay.day_id}' and member_key = 'efc:m1'`)).length, 'Sam (passed, not yet promoted in EFC) is not added again');
  await page.click('#addOne'); await page.fill('#psQ', 'Jo Bloggs'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('Jo Bloggs'), 'Concord\'s own students can be added too');
  await page.check('#psAny'); await page.fill('#psQ', 'Black'); await page.waitForTimeout(200);
  ok((await page.textContent('#psList')).includes('No one matches'), '"Any school" still only offers coloured belts on the day\'s belts');
  await page.click('#dlg [data-close]');
  await q(`delete from cb_entries where day_id = '${cDay.day_id}'`); await q(`delete from cb_days where day_id = '${cDay.day_id}'`);
  await page.evaluate(() => loadAll().then(render));

  console.log('\nUpdate EFC, dashboard, settings');
  await page.click('.tab[data-view="efc"]');
  ok((await page.textContent('#view-efc')).includes('Sam Lee') && !(await page.textContent('#view-efc')).includes('Kim Ng'), 'the Update EFC checklist lists passes to promote in EFC (not re-tests)');
  await page.check('[data-efc]');
  ok(await until(async () => (await q(`select efc_done from cb_entries where member_key = 'efc:m1'`))[0].efc_done === true && (await page.textContent('#view-efc')).includes('Nothing to update in EFC')), 'ticking it off clears it from the list');
  ok((await q(`select belt from efc_members where member_key = 'efc:m1'`))[0].belt === 'Yellow Belt', 'results never change EFC\'s belt here (EFC is the master)');
  // Importing an EFC export: matches by EFC ref, adds new students, leaves other programmes alone
  const efcCsv = 'Member Ref,First Name,Surname,Date of Birth,Grade,Venue,Programme,Attended Since Grading,Medical\r\n' +
    'AU-023-3,Alex,Kim,01/02/2016,Green,AMA Marrickville,Taekwondo,30,asthma\r\n' +
    'AU-023-9,New,Kid,"5/6/2017",yellow belt,AMA Marrickville,Taekwondo,25,\r\n' +
    'AU-023-7,Tiny,Tot,1/1/2022,White,AMA Marrickville,Little Dragon,10,\r\n';
  await page.setInputFiles('#impFile', { name: 'efc.csv', mimeType: 'text/csv', buffer: Buffer.from(efcCsv) });
  await page.waitForSelector('#impGo');
  const ip = await page.textContent('#impPrev');
  ok(ip.includes('2 students to import') && ip.includes('1 in other programmes left out') && ip.includes('EFC ref ← Member Ref') && ip.includes('Not used: Medical'), 'an EFC file is read and its columns matched (medical notes are not used)');
  await page.click('#impGo'); await toastSays(page, 'imported');
  ok((await page.textContent('#toast')).includes('1 updated, 1 added'), 'importing reports how many were updated and added');
  const alex = (await q(`select attended_since_promoted, date_of_birth, belt from efc_members where member_key = 'efc:m3'`))[0];
  ok(alex.attended_since_promoted === 30 && alex.date_of_birth === '2016-02-01' && alex.belt === 'Green Belt', 'a student already here is updated (classes, date of birth read day first, belt name matched)');
  const kid = (await q(`select full_name, belt, location, programme from efc_members where efc_reference = 'AU-023-9'`))[0];
  ok(kid && kid.full_name === 'New Kid' && kid.belt === 'Yellow Belt' && kid.location === 'Marrickville', 'a new student is added with their belt and school');
  ok(!(await q(`select 1 from efc_members where efc_reference = 'AU-023-7'`)).length && !JSON.stringify(await q(`select * from efc_members`)).includes('asthma'), 'Little Dragons are left out and medical notes are never stored');
  await page.click('.tab[data-view="settings"]'); await page.waitForSelector('#beltForm');
  await page.fill('tr[data-belt="Yellow Belt"] [name=fee]', '55'); await page.fill('tr[data-belt="White Belt"] [name=classes]', '30');
  await page.click('#saveBelts');
  await until(async () => (await q(`select classes_needed from cb_belts where belt = 'White Belt'`))[0].classes_needed === 30); await page.waitForSelector('#saveBelts:not([disabled])'); await settle(page);
  ok((await q(`select fee, classes_needed from cb_belts where belt = 'Yellow Belt'`))[0].fee == 55 && (await q(`select classes_needed from cb_belts where belt = 'White Belt'`))[0].classes_needed === 30, 'each belt has its own classes needed, weeks between and fee');
  ok((await q(`select enough_classes from cb_students where member_key = 'efc:m2'`))[0].enough_classes === false, 'changing classes needed changes who is eligible (Kim has 26 of 30)');
  ok((await page.$$('#msgForm textarea[data-col]')).length === 7, 'Settings has all seven texts: invitation, reminder to book, day reminder, fee reminder, congratulations, re-test, not yet');
  await page.fill('#tpl_reminder', 'See you at {school} on {date}!');
  await page.fill('#sHook', 'https://example.com/x'); await page.click('#saveMsgs');
  ok((await toastSays(page, 'hooks.zapier.com')).includes('hooks.zapier.com'), 'the booking Zap must be a Zapier hook address');
  await page.fill('#sHook', 'https://hooks.zapier.com/hooks/catch/1/abc/'); await page.click('#saveMsgs'); await toastSays(page, 'Saved');
  ok((await q(`select booking_webhook from cb_settings`))[0].booking_webhook.startsWith('https://hooks.zapier.com/') && (await q(`select reminder_text from cb_settings`))[0].reminder_text === 'See you at {school} on {date}!', 'the booking Zap and wording are saved');
  await page.click('.tab[data-view="dash"]');
  const dash = await page.textContent('#view-dash');
  ok(dash.includes('50%') && dash.includes('1 of 2') && dash.includes('$55') && dash.includes('Alex Kim'), 'the dashboard shows the pass rate (a re-test is not a pass), grading fees paid and overdue students');

  console.log('\nAddresses');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/dashboard', 'the dashboard is at /grading/coloured-belts/dashboard');
  await page.goBack(); await page.waitForSelector('#view-settings:not([hidden])');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/settings', 'the back button goes back a screen (to Settings)');
  await page.goto(BASE + '/grading/coloured-belts/grading-days/' + dayId + '/results'); await page.waitForSelector('.res');
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/grading-days/' + dayId + '/results' && (await page.textContent('#view-day')).includes('Results'), 'opening a saved address (via 404.html) goes straight to that screen');
  await page.goto(BASE + '/grading/coloured-belts/update-efc'); await page.waitForSelector('#view-efc:not([hidden])');
  ok((await page.textContent('#view-efc')).includes('Update EFC') && (await page.title()).startsWith('Update EFC'), '...for every screen, with a matching page title');
  await ctx.close();

  console.log('\nOther logins');
  ({ ctx, page } = await open('coach@ama.test', '/grading/coloured-belts/settings'));
  ok(new URL(page.url()).pathname === '/grading/coloured-belts/ready', 'an instructor opening the Settings address gets Who\'s ready instead');
  ok(await page.isHidden('.tab[data-view="settings"]') && (await page.textContent('#readyList')).includes('Sam Lee'), 'an instructor sees who is ready but not Settings');
  await page.click('.tab[data-view="days"]');
  ok(!(await page.$('#newDay')), '...and cannot add grading days');
  await ctx.close();
  ({ ctx, page } = await open('desk@ama.test'));
  ok(await page.isVisible('#noAccess') && (await page.textContent('#noAccess')).includes("can't use coloured belt grading"), 'attendance-only staff are told they need a role');
  await ctx.close();

  console.log('\nBooking page and grading hub');
  ({ ctx, page } = await open(null, '/grading/coloured-belts/book/index.html#t=' + sam.token));
  await page.waitForSelector('#info:not([hidden])');
  const bt = await page.textContent('body');
  ok(bt.includes("Sam's grading for Orange Belt") && bt.includes('AMA Marrickville') && bt.includes('$55'), 'the family sees the grading, school and fee');
  await page.click('#book'); await page.waitForSelector('#booked:not([hidden])');
  ok((await page.textContent('#booked')).includes('Booked') && fnCalls.some(c => c.action === 'book' && c.token === sam.token), 'pressing Book books it through the cb function');
  await page.goto(BASE + '/grading/coloured-belts/book/index.html');
  await page.waitForSelector('#error:not([hidden])');
  ok((await page.textContent('#error')).includes('missing its code'), 'a link without its code explains what to do');
  await page.goto(BASE + '/grading/index.html');
  const hub = await page.$$eval('a.pick', as => as.map(a => a.getAttribute('href')));
  ok(hub[0] === 'coloured-belts/' && hub[1].includes('Black-belt-prep-system') && hub[2].includes('ama-id-cards'), '/grading/ is a hub: coloured belts, black belts (Black Belt Prep) and ID cards');
  await ctx.close();
} catch (e) { failed++; console.log('  FAIL  stopped: ' + String(e.message || e).split('\n').slice(0, 3).join(' / ')); }

await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
