// Database tests for the TV display (supabase/tv-setup.sql), in an embedded Postgres holding the real
// AMA ID Cards and Black Belt Prep databases. Run: node tests/tv-db.test.mjs
// Uses the test tools from the black-belt-prep-system repository (set PREP_TESTS / CARD_REPO if elsewhere).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PREP_TESTS = process.env.PREP_TESTS || '/home/claude/black-belt-prep-system/tests';
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || '/home/claude/theggatonklenner/ama-id-cards';
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const read = p => readFileSync(p, 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };
const db = new PGlite();
async function as(email, fn) {
  await db.exec(email ? 'set role authenticated' : 'set role anon');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(email ? { email } : {})]);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}
const tryAs = async (email, sql, p = []) => { try { const r = await as(email, () => db.query(sql, p)); return { ok: true, rows: r.rows, n: /^\s*select/i.test(sql) ? r.rows.length : r.affectedRows }; } catch (e) { return { ok: false, err: e.message }; } };

console.log('Setting up AMA ID Cards and Black Belt Prep');
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`grant usage on schema public to anon; grant execute on all functions in schema public to anon;`);
await db.exec(`insert into auth.users (email) values ('tate@ama.test'), ('jo@ama.test'), ('station@ama.test'), ('nobody@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql', 'permissions.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 8; i++) await db.exec(read(join(PREP, `supabase/prep-update-0${i}.sql`)));
// Everyone who exists when the apps are first set up starts as an admin; set up the test people properly
await db.exec(`delete from staff_permissions where email <> 'tate@ama.test';
  insert into staff_permissions values ('station@ama.test', 'printer');
  delete from prep_roles where email <> 'tate@ama.test';
  insert into prep_roles (email, role) values ('jo@ama.test', 'instructor');`);

console.log('\nTV setup');
const SQL = read(join(here, '../supabase/tv-setup.sql'));
await db.exec(SQL); await db.exec(SQL);
ok(true, 'tv-setup.sql runs twice without errors');
const code = (await db.query(`select screen_code from tv_settings`)).rows[0].screen_code;
ok(/^[A-Z0-9]{6}$/.test(code), 'a 6-character screen code is made automatically');
ok((await db.query(`select public from storage.buckets where id = 'tv'`)).rows[0].public === true, 'photo and video bucket is set up');

console.log('\nWho can edit');
ok((await tryAs('tate@ama.test', `insert into tv_slides (kind, title, body) values ('text', 'Welcome', 'Class times') returning id`)).ok, 'ID Cards staff can add slides');
ok((await tryAs('jo@ama.test', `insert into tv_slides (kind, title) values ('text', 'From Jo')`)).ok, 'Black Belt Prep staff can add slides');
ok(!(await tryAs('station@ama.test', `insert into tv_slides (kind, title) values ('text', 'x')`)).ok, 'the print station login cannot');
ok(!(await tryAs('nobody@ama.test', `insert into tv_slides (kind, title) values ('text', 'x')`)).ok, 'a login with no roles cannot');
ok(!(await tryAs(null, `insert into tv_slides (kind, title) values ('text', 'x')`)).ok && (await tryAs(null, `select * from tv_slides`)).ok === false || (await tryAs(null, `select * from tv_slides`)).n === 0, 'the public cannot read or change slides directly');
ok((await tryAs('nobody@ama.test', `select * from tv_settings`)).n === 0, 'non-staff cannot see the screen code');
ok((await db.query(`select created_by from tv_slides where title = 'Welcome'`)).rows[0].created_by === 'tate@ama.test', 'records who added a slide');
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, title) values ('photo', 'no file')`)).ok, 'a photo slide needs a file');
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, title) values ('live', 'no kind')`)).ok, 'a live slide needs to say which live info');

console.log('\nWhat the TV gets');
let f = (await as(null, () => db.query(`select tv_feed($1) f`, ['WRONG1']))).rows[0].f;
ok(f.error === 'wrong_code' && !f.slides, 'wrong screen code gets nothing');
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code.toLowerCase()]))).rows[0].f;
ok(!f.error && f.slides.map(s => s.title).join() === 'Welcome,From Jo', 'right code (any case) gets the slides in order');
ok(f.settings.seconds === 10 && f.settings.show_clock === true, 'and the settings');
await as('tate@ama.test', () => db.exec(`update tv_slides set enabled = false where title = 'From Jo';
  insert into tv_slides (kind, title, starts_on) values ('text', 'Future', current_date + 30);
  insert into tv_slides (kind, title, ends_on) values ('text', 'Past', current_date - 1);
  insert into tv_slides (kind, title, starts_on, ends_on) values ('text', 'Now', current_date - 1, current_date + 1);`));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(f.slides.map(s => s.title).join() === 'Welcome,Now', 'turned-off slides and slides outside their dates are left out; new slides go at the end');

console.log('\nLive AMA info');
await as('tate@ama.test', () => db.exec(`
  insert into prep_students (student_id, full_name, certificate_name, belt_rank) values ('T1', 'Kara Lee', 'Kara Jane Lee', 'Cho Dan Bo'), ('T2', 'Sam Park', null, '1st Dan Level 1'), ('T3', 'Old Pass', null, '2nd Dan Level 2'), ('T4', 'Test Kid', null, 'Cho Dan Bo');
  update prep_students set is_test = true where student_id = 'T4';`));
const cid = (await as('tate@ama.test', () => db.query(`select prep_start_new_cycle('TV cycle', null, null, array[current_date - 14, current_date + 1, current_date + 15, current_date + 29]::date[], 0, null, array['T1','T2','T3','T4']) id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`update prep_cycles set grading_date = current_date + 43 where cycle_id = $1`, [cid]));
await as('tate@ama.test', () => db.query(`select prep_activate_cycle($1, true)`, [cid]));
await db.query(`insert into prep_grading (student_id, cycle_id, grading_event, grading_date, target_rank, result, eligibility_decision, decision_reason, status) values
  ('T1', $1, 'Recent', current_date - 3, 'Probationary Black Belt', 'passed', 'eligible', 'test', 'completed'),
  ('T2', $1, 'Recent', current_date - 3, '2nd Dan', 'passed', 'eligible', 'test', 'completed'),
  ('T3', $1, 'Long ago', current_date - 120, '3rd Dan', 'passed', 'eligible', 'test', 'completed'),
  ('T4', $1, 'Recent', current_date - 3, 'Probationary Black Belt', 'passed', 'eligible', 'test', 'completed')`, [cid]);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
const today = new Date(f.today + 'T00:00:00Z');
const plus = n => { const d = new Date(today); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
ok(f.live.next_grading && f.live.next_grading.date === plus(43) && f.live.next_grading.cycle === 'TV cycle', 'next grading date of the active cycle');
ok(JSON.stringify(f).indexOf('student_id') === -1 && JSON.stringify(f).indexOf('"T1"') === -1, 'the TV never gets Student IDs or anything else about students');

console.log('\nParty mode');
const pid = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Happy Birthday Kara!', 'party', true) returning id`))).rows[0].id;
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only && !f.slides.some(s => s.title === 'Happy Birthday Kara!'), 'party slides stay out of the normal slideshow');
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '2 hours'`, [pid]));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(f.only === true && f.slides.length === 1 && f.slides[0].title === 'Happy Birthday Kara!' && f.slides[0].theme === 'party', 'party mode: the TV gets only that slide');
ok(f.settings.show_clock === false && f.settings.show_logo === false && Object.keys(f.live).length === 0, 'with no clock, logo or live info over it');
await as('tate@ama.test', () => db.exec(`update tv_settings set only_until = now() - interval '1 minute'`));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only && f.slides.length > 1, 'when the time is up, the normal slideshow comes back by itself');
ok(!(await tryAs('nobody@ama.test', `update tv_settings set only_slide = null`)).n, 'only staff can start or stop party mode');

console.log('\nCountdowns');
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, title, count_to) values ('countdown', 'No date', 'date')`)).ok, 'a countdown to a date needs the date');
await as('tate@ama.test', () => db.exec(`insert into tv_slides (kind, title, count_to, event_on) values ('countdown', 'Comp', 'date', current_date + 21), ('countdown', 'Old comp', 'date', current_date - 1);
  insert into tv_slides (kind, title, count_to) values ('countdown', 'Black belt grading', 'grading');`));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
const cds = f.slides.filter(x => x.kind === 'countdown');
ok(cds.map(x => x.title).join() === 'Comp,Black belt grading' && cds[0].event_on && cds[1].count_to === 'grading', 'countdowns reach the TV (to a date, or to the next grading); past ones are left out');

console.log('\nBooked parties');
const bk = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Happy Birthday Mo!', 'party', true) returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`insert into tv_party_bookings (slide_id, starts_at, ends_at) values ($1, now() + interval '2 hours', now() + interval '4 hours')`, [bk]));
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only, 'a booking later today does not change the TV yet');
await db.exec(`update tv_party_bookings set starts_at = now() - interval '1 minute'`);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(f.only && f.slides[0].title === 'Happy Birthday Mo!' && new Date(f.only_until) > new Date(), 'at the booked time, party mode switches on by itself');
await db.exec(`update tv_party_bookings set ends_at = now() - interval '1 second'`);
f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
ok(!f.only, 'and off again at the end');
ok(!(await tryAs('nobody@ama.test', `insert into tv_party_bookings (slide_id, starts_at, ends_at) values ('${bk}', now(), now() + interval '1 hour')`)).ok, 'only staff can book parties');
ok(!(await tryAs('tate@ama.test', `insert into tv_party_bookings (slide_id, starts_at, ends_at) values ('${bk}', now(), now() - interval '1 hour')`)).ok, 'a booking must end after it starts');

console.log('\nTV status and refresh');
const ck = async (c, scr, started) => (await as(null, () => db.query(`select tv_checkin($1, $2, 'Showing: Comp', $3, '{"w":1920}'::jsonb) r`, [c, scr, started]))).rows[0].r;
ok((await ck('WRONG1', 'screen-abc123', new Date().toISOString())).error === 'wrong_code', 'a TV with the wrong code cannot check in');
const started = new Date(Date.now() - 60000).toISOString();
let r = await ck(code, 'screen-abc123', started);
ok(r.reload === false, 'checking in works, and no reload is asked for');
const scr = (await as('tate@ama.test', () => db.query(`select * from tv_screens`))).rows;
ok(scr.length === 1 && scr[0].showing === 'Showing: Comp' && scr[0].details.w === 1920, 'staff can see the TV is online and what it is showing');
ok((await tryAs(null, `select * from tv_screens`)).ok === false || (await tryAs(null, `select * from tv_screens`)).n === 0, 'the public cannot see TV status');
await as('tate@ama.test', () => db.exec(`update tv_settings set reload_at = now()`));
ok((await ck(code, 'screen-abc123', started)).reload === true, '"Refresh the TV" asks a TV that loaded earlier to reload');
ok((await ck(code, 'screen-abc123', new Date(Date.now() + 1000).toISOString())).reload === false, 'once it has reloaded, it is not asked again');
// A TV whose clock is an hour fast still gets refreshed
const fast = new Date(Date.now() + 3600e3).toISOString();
await ck(code, 'screen-fast01', fast);
await as('tate@ama.test', () => db.exec(`update tv_settings set reload_at = '2001-01-01'`));
ok((await as('tate@ama.test', () => db.query(`select reload_at > now() - interval '1 minute' x from tv_settings`))).rows[0].x, 'the refresh time is the server\'s, whatever time the editor sends');
ok((await ck(code, 'screen-fast01', fast)).reload === true, 'a TV with its clock set wrong still refreshes');
ok((await ck(code, 'bad screen!', started)).error === 'bad_screen', 'odd screen names are refused');

ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, live_kind) values ('live', 'congrats')`)).ok, 'the Congratulations and Prep sessions slides are gone');
console.log('\nEvents calendar');
const feedEvents = async () => { const f = (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f; return f.only ? null : f.live.events; };
const D = (await db.query(`select (now() at time zone 'Australia/Sydney')::date::text t, date_trunc('month', (now() at time zone 'Australia/Sydney'))::date::text m0,
  (date_trunc('month', (now() at time zone 'Australia/Sydney')) + interval '1 month')::date::text m1,
  (now() at time zone 'Australia/Sydney')::date >= (date_trunc('month', (now() at time zone 'Australia/Sydney')) + interval '1 month')::date - 10 two`)).rows[0];
ok(!(await tryAs('nobody@ama.test', `insert into tv_events (starts_on, title) values (current_date, 'X')`)).ok, 'only staff can add events');
ok(!(await tryAs('tate@ama.test', `insert into tv_events (starts_on, ends_on, title) values ('2026-05-05', '2026-05-01', 'X')`)).ok, 'an event cannot end before it starts');
await as('tate@ama.test', () => db.query(`insert into tv_events (starts_on, ends_on, title, note) values
  ($1::date, null, 'Today thing', '1:30 pm'), ($1::date - 1, null, 'Yesterday thing', null),
  ($2::date - 3, $1::date, 'Started last month', null), ($3::date + 2, null, 'Next month thing', null),
  ($3::date + interval '1 month' + interval '3 days', null, 'Far off', null)`, [D.t, D.m0, D.m1]));
await as('tate@ama.test', () => db.query(`insert into tv_months (month, theme) values ($1, 'Month of Testing')`, [D.m0]));
let ev = await feedEvents();
const titles = m => (m ? m.events.map(e => e.title) : []);
ok(ev[0].month === D.m0 && ev[0].theme === 'Month of Testing', 'the TV gets this month with its theme');
ok((await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f.live.month.theme === 'Month of Testing', "the month theme slide gets this month's theme");
ok(titles(ev[0]).includes('Today thing') && ev[0].events.find(e => e.title === 'Today thing').note === '1:30 pm', "this month's events are listed, with notes");
ok(!JSON.stringify(ev).includes('Yesterday thing'), 'events that are over are left off');
ok(titles(ev[0]).includes('Started last month'), 'an event that started last month and is still on shows under this month');
ok(!JSON.stringify(ev).includes('Far off'), 'only this month and next month, never the whole year');
ok(D.two ? (ev.length === 2 && titles(ev[1]).includes('Next month thing')) : ev.length === 1, `next month shows only in the last 10 days of the month (${D.two ? 'it is now' : 'not yet'})`);
await as('tate@ama.test', () => db.query(`delete from tv_events where title in ('Today thing', 'Started last month')`));
ev = await feedEvents();
ok(ev.length === 2 && ev[0].events.length === 0 && titles(ev[1]).includes('Next month thing'), 'once this month has nothing left, next month shows');
await as('tate@ama.test', () => db.exec(`delete from tv_events; delete from tv_months`));

console.log('\nQuiet hours and QR codes');
const syd = `(now() at time zone 'Australia/Sydney')`;
const feedNow = async () => (await as(null, () => db.query(`select tv_feed($1) f`, [code]))).rows[0].f;
await as('tate@ama.test', () => db.exec(`update tv_settings set only_slide = null, only_until = null, quiet_on = true, quiet_style = 'logo',
  quiet_from = (${syd} - interval '1 hour')::time, quiet_to = (${syd} + interval '1 hour')::time`));
f = await feedNow();
ok(f.quiet === 'logo' && f.slides.length === 0 && !f.settings.show_clock, 'in quiet hours the TV gets no slides, just the logo');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_style = 'black'`));
ok((await feedNow()).quiet === 'black', 'or a black screen');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_from = (${syd} + interval '1 hour')::time, quiet_to = (${syd} - interval '1 hour')::time`));
ok(!(await feedNow()).quiet, 'outside quiet hours the slideshow plays (a 9 pm to 7 am style window that crosses midnight)');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_from = (${syd} - interval '1 minute')::time, quiet_to = (${syd} - interval '2 minutes')::time`));
ok((await feedNow()).quiet === 'black', 'a window that wraps past midnight covers now');
const qp = (await as('tate@ama.test', () => db.query(`insert into tv_slides (kind, title, theme, party) values ('text', 'Party in quiet hours', 'party', true) returning id`))).rows[0].id;
await as('tate@ama.test', () => db.query(`update tv_settings set only_slide = $1, only_until = now() + interval '1 hour'`, [qp]));
ok((await feedNow()).only === true, 'a party still shows during quiet hours');
await as('tate@ama.test', () => db.exec(`update tv_settings set only_slide = null, only_until = null, quiet_on = false`));
ok(!(await feedNow()).quiet, 'quiet hours can be turned off');
ok(!(await tryAs('tate@ama.test', `update tv_settings set quiet_style = 'off'`)).ok, 'only black or logo');
const dow = (await db.query(`select extract(dow from ${syd})::int d, to_char(${syd} - interval '1 hour', 'HH24:MI') a, to_char(${syd} + interval '1 hour', 'HH24:MI') b, to_char(${syd} + interval '2 hours', 'HH24:MI') c`)).rows[0];
const setDays = async days => as('tate@ama.test', () => db.query(`update tv_settings set quiet_on = true, quiet_days = $1::jsonb`, [JSON.stringify(days)]));
const other = (dow.d + 3) % 7;
await setDays({ [dow.d]: { on: dow.a, off: dow.b }, [other]: null });
ok(!(await feedNow()).quiet, "each day has its own hours: during today's hours the slideshow plays");
await setDays({ [dow.d]: { on: dow.b, off: dow.c }, [other]: { on: dow.a, off: dow.b } });
ok((await feedNow()).quiet, "before today's hours start the TV is quiet (another day's hours don't count)");
await setDays({ [dow.d]: null });
ok((await feedNow()).quiet, 'a day marked closed is quiet all day');
await as('tate@ama.test', () => db.exec(`update tv_settings set quiet_on = false, quiet_days = null`));
ok(!(await tryAs('tate@ama.test', `insert into tv_slides (kind, link, media_path) values ('qr', 'not a link', 'qr/x.png')`)).ok, 'a QR slide needs a proper link');
await as('tate@ama.test', () => db.exec(`insert into tv_slides (kind, title, link, media_path) values ('qr', 'Follow us', 'https://instagram.com/ama', 'qr/x.png')`));
ok((await feedNow()).slides.some(x => x.kind === 'qr' && x.link === 'https://instagram.com/ama'), 'QR slides reach the TV with their link');
await as('tate@ama.test', () => db.exec(`delete from tv_slides where kind = 'qr' or title = 'Party in quiet hours'`));

console.log('\nFiles');
const pol = (await db.query(`select policyname, roles::text r from pg_policies where tablename = 'objects' and policyname like 'tv files%'`)).rows;
ok(pol.length === 4 && pol.every(p => p.r.includes('authenticated') && !p.r.includes('anon')), 'only signed-in staff can add, change or remove TV files');

ok((await db.query(`select bool_and(relrowsecurity) r from pg_class where relname in ('tv_slides', 'tv_settings')`)).rows[0].r, 'row level security is on');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
