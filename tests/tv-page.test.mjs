// Browser test for the TV display: the editor at phone size and the TV page at TV size, against a local
// stand-in for Supabase holding the real AMA ID Cards, Black Belt Prep and TV databases.
// Run: node tests/tv-page.test.mjs  (uses the black-belt-prep-system test tools; set PREP_TESTS / CARD_REPO if elsewhere)
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PREP_TESTS = process.env.PREP_TESTS || '/home/claude/black-belt-prep-system/tests';
const PREP = join(PREP_TESTS, '..');
const CARD = process.env.CARD_REPO || '/home/claude/theggatonklenner/ama-id-cards';
const { PGlite } = await import(join(PREP_TESTS, 'node_modules/@electric-sql/pglite/dist/index.js'));
const { startServer } = await import(pathToFileURL(join(PREP_TESTS, 'fake-supabase.mjs')).href);
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const read = p => readFileSync(p, 'utf8');
const SHOTS = process.env.SHOT_DIR || join(tmpdir(), 'tv-shots'); mkdirSync(SHOTS, { recursive: true });
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  pass  ' + m); } else { failed++; console.log('  FAIL  ' + m); } };

// ---- Database ----
const db = new PGlite();
await db.exec(read(join(PREP_TESTS, 'supabase-stub.sql')));
await db.exec(`grant usage on schema public to anon;`);
await db.exec(`insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'tate@ama.test'), ('00000000-0000-0000-0000-000000000002', 'jo@ama.test')`);
for (const f of ['setup.sql', 'roles.sql', 'printed.sql', 'permissions.sql']) await db.exec(read(join(CARD, 'supabase', f)));
await db.exec(read(join(PREP, 'supabase/prep-setup.sql')));
for (let i = 1; i <= 8; i++) await db.exec(read(join(PREP, `supabase/prep-update-0${i}.sql`)));
await db.exec(`delete from staff_permissions where email <> 'tate@ama.test'; delete from prep_roles where email <> 'tate@ama.test';`);
await db.exec(read(join(ROOT, 'supabase/tv-setup.sql')));
// Black Belt Prep data for the live slides
await db.exec(`set role authenticated; select set_config('request.jwt.claims', '{"email":"tate@ama.test"}', false);
  insert into prep_students (student_id, full_name, certificate_name, belt_rank) values ('T1', 'Kara Lee', 'Kara Jane Lee', 'Cho Dan Bo'), ('T2', 'Sam Park', null, '1st Dan Level 1');`);
const cid = (await db.query(`select prep_start_new_cycle('Term 4 2026', null, null, array[current_date - 14, current_date + 1, current_date + 15, current_date + 29]::date[], 0, null, array['T1','T2']) id`)).rows[0].id;
await db.query(`update prep_cycles set grading_date = current_date + 43 where cycle_id = $1`, [cid]);
await db.query(`select prep_activate_cycle($1, true)`, [cid]);
await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`);
await db.query(`insert into prep_grading (student_id, cycle_id, grading_event, grading_date, target_rank, result, eligibility_decision, decision_reason, status) values
  ('T1', $1, 'Recent', current_date - 3, 'Probationary Black Belt', 'passed', 'eligible', 'test', 'completed'),
  ('T2', $1, 'Recent', current_date - 3, '2nd Dan', 'passed', 'eligible', 'test', 'completed')`, [cid]);
const CODE = (await db.query(`select screen_code from tv_settings`)).rows[0].screen_code;

const users = { 'tate@ama.test': { id: '00000000-0000-0000-0000-000000000001', password: 'pw' }, 'jo@ama.test': { id: '00000000-0000-0000-0000-000000000002', password: 'pw' } };
let BASE;
const server = await startServer({ db, appDir: ROOT, users, config: '' });
BASE = `http://localhost:${server.address().port}`;
const configJs = `window.TOOLKIT_CONFIG = { SUPABASE_URL: '${BASE}', SUPABASE_KEY: 'test' };`;
const files = new Map();   // the "tv" storage bucket
const browser = await chromium.launch();
const errors = [];
async function context(size, offline = false) {
  const ctx = await browser.newContext({ viewport: size, serviceWorkers: 'block', ...(size.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PREP_TESTS, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js')) }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await ctx.route('**/storage/v1/**', async r => {
    const q = r.request(), url = new URL(q.url()), m = url.pathname.match(/\/storage\/v1\/object\/(public\/)?tv\/(.+)$/);
    if (q.method() === 'GET' && m) { const f = files.get(decodeURIComponent(m[2])); return f ? r.fulfill({ status: 200, contentType: f.type, body: f.body }) : r.fulfill({ status: 404, body: '' }); }
    if ((q.method() === 'POST' || q.method() === 'PUT') && m) {
      let type = q.headers()['content-type'] || 'application/octet-stream', body = q.postDataBuffer();
      const bm = type.match(/boundary=(.+)$/);
      if (bm) {   // supabase-js sends files as a form upload: pull out the file part
        const sep = Buffer.from('--' + bm[1]);
        for (let i = body.indexOf(sep); i >= 0;) {
          const j = body.indexOf(sep, i + sep.length); if (j < 0) break;
          const part = body.subarray(i + sep.length, j), h = part.indexOf('\r\n\r\n'), head = part.subarray(0, h).toString();
          const ct = head.match(/Content-Type:\s*([^\r\n]+)/i);
          if (/filename=/.test(head) || (ct && !/text\/plain/.test(ct[1]))) { type = ct ? ct[1].trim() : 'application/octet-stream'; body = part.subarray(h + 4, part.length - 2); break; }
          i = j;
        }
      }
      files.set(decodeURIComponent(m[2]), { type, body });
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ Key: 'tv/' + m[2] }) });
    }
    if (q.method() === 'DELETE') { const b = JSON.parse(q.postData() || '{}'); (b.prefixes || []).forEach(p => files.delete(p)); return r.fulfill({ contentType: 'application/json', body: '[]' }); }
    return r.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/i.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}
const toastSays = async (page, t) => { await page.waitForFunction(x => { const el = document.querySelector('#toast'); return !el.hidden && el.textContent.includes(x); }, t, { timeout: 6000 }).catch(() => {}); return page.textContent('#toast'); };
const slides = async () => (await db.query(`select kind, title, live_kind, enabled, position, media_path, ends_on from tv_slides order by position`)).rows;

try {
  console.log('Editor (phone)');
  let { ctx, page } = await context({ width: 390, height: 844 });
  await page.goto(BASE + '/tv/edit/index.html');
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#app:not([hidden])');
  ok((await page.textContent('#code')) === CODE && (await page.textContent('#list')).includes('No slides yet'), 'opens with the screen code and an empty list');
  ok(await page.isVisible('#homeBtn'), 'has the home button back to the toolkit');

  // Info slide
  await page.click('#addBtn'); await page.click('[data-add="text"]'); await page.waitForSelector('#slForm');
  await page.fill('#slTitle', 'No classes on Monday'); await page.fill('#slBody', 'The dojang is closed for the public holiday.\nBack on Tuesday.');
  await page.check('#slForm input[name=theme][value=gold]');
  await page.click('#slSave'); await page.waitForSelector('#list [data-open]');
  ok((await slides())[0].title === 'No classes on Monday', 'info slide added');

  // Photos (two at once)
  await page.setInputFiles('#pickPhotos', [join(ROOT, 'icons/ama-id-cards.png'), join(ROOT, 'icons/clipboard.png')]);
  await page.waitForFunction(() => document.querySelectorAll('#list .slide').length === 3, null, { timeout: 15000 });
  const ph = (await slides()).filter(s => s.kind === 'photo');
  ok(ph.length === 2 && ph.every(p => files.has(p.media_path) && files.get(p.media_path).type === 'image/jpeg'), 'two photos added at once, resized to JPEG and uploaded');

  // Live slides
  for (const k of ['next_grading', 'congrats', 'sessions']) { await page.click('#addBtn'); await page.click(`[data-add="live:${k}"]`); await toastSays(page, 'Added'); await page.waitForFunction(n => document.querySelectorAll('#list .slide').length === n, 3 + ['next_grading', 'congrats', 'sessions'].indexOf(k) + 1); }
  ok((await slides()).filter(s => s.kind === 'live').map(s => s.live_kind).join() === 'next_grading,congrats,sessions', 'live slides added (next grading, congratulations, sessions)');
  await page.screenshot({ path: join(SHOTS, 'tv-editor.png'), fullPage: true });

  // Reorder: move the congratulations up one
  const congratsId = (await db.query(`select id from tv_slides where live_kind = 'congrats'`)).rows[0].id;
  await page.click(`[data-up="${congratsId}"]`); await page.waitForTimeout(600);
  ok((await slides()).map(s => s.live_kind || s.kind).join() === 'text,photo,photo,congrats,next_grading,sessions', 'slides can be moved up and down');

  // Turn one off, schedule one
  const sessionsId = (await db.query(`select id from tv_slides where live_kind = 'sessions'`)).rows[0].id;
  await page.uncheck(`[data-on="${sessionsId}"]`); await toastSays(page, 'Hidden');
  ok((await slides()).find(s => s.live_kind === 'sessions').enabled === false, 'a slide can be hidden from the TV with one tap');
  await page.click('#list [data-open]:has-text("No classes on Monday")'); await page.waitForSelector('#slForm');
  const nextWeek = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  await page.fill('#slUntil', nextWeek); await page.click('#slSave'); await toastSays(page, 'Saved');
  await page.waitForFunction(() => document.querySelector('#list').textContent.includes('Until'), null, { timeout: 5000 }).catch(() => {});
  ok(String((await slides())[0].ends_on).length > 0 && (await page.textContent('#list')).includes('Until'), 'a slide can be set to stop showing after a date');

  // Settings
  await page.fill('#setSecs', '4'); await page.click('#setSave'); await toastSays(page, 'Settings saved');
  ok((await db.query(`select seconds from tv_settings`)).rows[0].seconds === 4, 'seconds per slide saved');
  ok((await page.getAttribute('#previewBtn', 'href')) === `../?code=${CODE}`, 'Preview opens the TV page with the code');
  await ctx.close();

  console.log('\nTV page (1280 x 720)');
  ({ ctx, page } = await context({ width: 1280, height: 720 }));
  await page.goto(BASE + '/tv/index.html');
  await page.waitForSelector('#codeScreen:not([style*="none"])');
  ok(true, 'asks for the screen code the first time');
  await page.fill('#codeInput', 'WRONG1'); await page.press('#codeInput', 'Enter');
  await page.waitForFunction(() => document.querySelector('#codeErr').textContent.includes('not right'));
  ok(true, 'a wrong code is explained');
  await page.fill('#codeInput', CODE.toLowerCase()); await page.press('#codeInput', 'Enter');
  await page.waitForSelector('.layer.on');
  const st = await page.evaluate(() => window.__tv.state());
  ok(st.count === 5, 'plays the 5 slides that are on (the hidden one is left out)');
  ok(await page.isVisible('#clock') && await page.isVisible('#logo'), 'clock and AMA logo in the corners');
  const seen = {};
  for (let i = 0; i < st.count; i++) {
    await page.waitForTimeout(1200);
    const txt = await page.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l.length ? l[l.length - 1].textContent : ''; });
    seen[i] = txt;
    await page.screenshot({ path: join(SHOTS, `tv-slide-${i + 1}.png`) });
    await page.evaluate(() => window.__tv.next());
  }
  const all = Object.values(seen).join(' | ');
  ok(all.includes('No classes on Monday') && all.includes('Back on Tuesday'), 'info slide shows the heading and text');
  ok(all.includes('Kara Jane Lee') && all.includes('Sam Park') && all.includes('Probationary Black Belt'), 'congratulations slide lists the new black belts and ranks');
  ok(/weeks to go|days to go/.test(all) && /Next black belt grading/i.test(all), 'next grading slide shows the date and how long to go');
  ok(!all.includes('Sign-off'), 'the hidden sessions slide is not shown');
  ok((await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.documentElement.scrollHeight <= innerHeight + 1)), 'fits the screen with no scrolling');

  // Changes reach the TV
  await db.query(`update tv_slides set enabled = true where live_kind = 'sessions'`);
  await page.evaluate(() => window.__tv.reload());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__tv.next());
  await page.waitForFunction(() => window.__tv.state().count === 6, null, { timeout: 5000 }).catch(() => {});
  ok((await page.evaluate(() => window.__tv.state())).count === 6, 'a change in the editor reaches the TV (picked up at the next slide)');

  // Remembered code and no connection
  await ctx.route(`${BASE}/rest/**`, r => r.abort());
  await page.reload(); await page.waitForSelector('.layer.on', { timeout: 8000 });
  ok(await page.isHidden('#codeScreen') && (await page.evaluate(() => window.__tv.state())).count === 6, 'remembers the code, and keeps playing its saved slides with no connection');
  ok(await page.evaluate(() => document.body.className.includes('offline')), 'shows a small dot when offline');
  await ctx.unroute(`${BASE}/rest/**`);

  // New code stops the TV
  await db.query(`update tv_settings set screen_code = 'NEWCODE'`);
  await page.evaluate(() => window.__tv.reload());
  await page.waitForSelector('#codeScreen:not([style*="none"])', { timeout: 5000 });
  ok((await page.textContent('#codeErr')).includes('changed'), 'after a new code, the TV asks for it');
  await ctx.close();

  // Delete removes the file
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#list [data-open]');
  const photo = (await slides()).find(s => s.kind === 'photo');
  const pid = (await db.query(`select id from tv_slides where media_path = $1`, [photo.media_path])).rows[0].id;
  await page.click(`[data-open="${pid}"]`); await page.waitForSelector('#slDel'); await page.click('#slDel'); await page.click('#cfYes');
  await toastSays(page, 'Deleted'); await page.waitForTimeout(400);
  ok(!(await slides()).some(s => s.media_path === photo.media_path) && !files.has(photo.media_path), 'deleting a photo slide removes the photo too');
  await page.click('#signOut'); await page.waitForSelector('#signIn:not([hidden])');
  await page.fill('#siEmail', 'jo@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#problem:not([hidden])');
  ok((await page.textContent('#problem')).includes('for AMA staff'), 'someone who is not staff cannot edit the TV');
  await ctx.close();

  ok(errors.length === 0, 'no errors in the browser console' + (errors.length ? ': ' + errors.slice(0, 3).join(' / ') : ''));
} catch (e) {
  ok(false, 'stopped: ' + e.message.split('\n').slice(0, 3).join(' / '));
}
await browser.close(); server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
