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
const PDFJS = process.env.PDFJS || '/tmp/claude-0/-home-claude/eaa02a79-d300-5a00-9b7a-e09b12f5efb0/scratchpad/pdfjs/node_modules/pdfjs-dist/build';   // pdfjs-dist@3.11.174
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
  if (process.env.FONTS_DIR) {   // real poster fonts (from @fontsource) instead of none
    await ctx.route('https://fonts.googleapis.com/**', r => {
      const fam = decodeURIComponent((r.request().url().split('family=')[1] || '').split('&')[0]).split(':')[0].replace(/\+/g, ' ');
      const file = { 'Luckiest Guy': 'luckiest-guy/files/luckiest-guy-latin-400-normal.woff2', 'Knewave': 'knewave/files/knewave-latin-400-normal.woff2', 'Montserrat': 'montserrat/files/montserrat-latin-800-normal.woff2' }[fam];
      r.fulfill({ contentType: 'text/css', body: file ? `@font-face{font-family:"${fam}";font-weight:${fam === 'Montserrat' ? 800 : 400};src:url(https://fonts.gstatic.com/${file})}` : '' });
    });
    await ctx.route('https://fonts.gstatic.com/**', r => r.fulfill({ contentType: 'font/woff2', body: readFileSync(join(process.env.FONTS_DIR, r.request().url().split('gstatic.com/')[1])) }));
  } else await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/**', r => r.fulfill({ contentType: 'text/javascript', body: read(join(PDFJS, r.request().url().endsWith('pdf.worker.min.js') ? 'pdf.worker.min.js' : 'pdf.min.js')) }));
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
  ok((await page.getAttribute('#previewBtn', 'href')) === `../?code=${CODE}&preview=1`, 'Preview opens the TV page with the code');
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

  // Party mode
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await db.query(`update tv_settings set screen_code = $1`, [CODE]);
  await page.goto(BASE + '/tv/edit/index.html');
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#partyStart');
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.fill('#pName', 'Kara'); await page.fill('#pLine', 'Turning 7 today!');
  ok((await page.textContent('#pPrev')).includes('Happy Birthday Kara!') && (await page.textContent('#pPrev')).includes('Turning 7 today!'), 'party message preview shows "Happy Birthday Kara!"');
  await page.selectOption('#pFor', '60');
  await page.screenshot({ path: join(SHOTS, 'tv-party-editor.png') });
  await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const tvset = (await db.query(`select only_slide, only_until > now() + interval '55 minutes' and only_until < now() + interval '65 minutes' ok from tv_settings`)).rows[0];
  ok(tvset.only_slide && tvset.ok, 'party mode is on for 1 hour');
  ok((await page.textContent('#party')).includes('Party mode is on') && !(await page.textContent('#list')).includes('Happy Birthday'), 'editor shows party mode is on; the party slide is kept out of the slide list');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const cols = await page.$$eval('#party .btn', bs => bs.map(b => { const c = getComputedStyle(b); return [c.color, c.backgroundColor]; }));
    ok(cols.length === 2 && cols.every(([fg, bg]) => fg !== bg) && cols[1][0] === 'rgb(22, 33, 27)' && cols[1][1] === 'rgb(255, 255, 255)', `party mode buttons are readable in ${scheme} mode`);
  }
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: join(SHOTS, 'tv-party-on-dark.png') }); await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: join(SHOTS, 'tv-party-on.png') });
  const tv = await context({ width: 1280, height: 720 });
  await tv.page.goto(BASE + `/tv/index.html?code=${CODE}`); await tv.page.waitForSelector('.layer.on');
  await tv.page.waitForTimeout(1200);
  ok((await tv.page.evaluate(() => window.__tv.state())).count === 1 && (await tv.page.textContent('.layer.on')).includes('Happy Birthday Kara!'), 'the TV shows only the birthday message');
  ok(await tv.page.isHidden('#clock') && (await tv.page.$$('.confetti i')).length > 10, 'full screen with confetti, no clock or logo');
  await tv.page.screenshot({ path: join(SHOTS, 'tv-party.png') });
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await tv.page.evaluate(() => window.__tv.reload()); await tv.page.waitForTimeout(800);
  ok((await tv.page.evaluate(() => window.__tv.state())).count > 1, '"Back to normal" brings the slideshow straight back');
  // Image, and reusing a saved one
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.click('#pForm [data-m="image"]');
  await page.click('#pPick'); await page.setInputFiles('#pickParty', join(ROOT, 'icons/ama-id-cards.png'));
  await page.waitForSelector('#pForm .preview-img');
  await page.fill('#pCap', 'Happy Birthday Sam!'); await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const img = (await db.query(`select s.kind, s.media_path from tv_settings t join tv_slides s on s.id = t.only_slide`)).rows[0];
  ok(img.kind === 'photo' && files.has(img.media_path), 'an uploaded image can be shown on its own');
  await tv.page.evaluate(() => window.__tv.reload()); await tv.page.waitForTimeout(800);
  ok((await tv.page.evaluate(() => window.__tv.state())).count === 1, 'and the TV switches to it');
  ok(!(await tv.page.$('.layer.on .caption')) && !(await tv.page.textContent('#stage')).includes('Happy Birthday Sam!'), 'in party mode the picture shows on its own, with no caption over it');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  ok((await page.$$('#pForm [data-m="saved"]')).length === 1, 'earlier party slides are saved to reuse');
  await page.click('#pForm [data-m="saved"]'); await page.waitForSelector('#pForm [data-pick]');
  ok((await page.$$('#pForm [data-pick]')).length === 2, 'both earlier party slides are listed');
  await page.selectOption('#pFor', 'day'); await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const endOfDay = await page.evaluate(() => { const d = new Date(); d.setHours(23, 59, 0, 0); return d.toISOString(); });
  ok(Math.abs(new Date((await db.query(`select only_until from tv_settings`)).rows[0].only_until) - new Date(endOfDay)) < 60e3, '"the rest of today" runs until 11:59 pm');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');

  // A PDF of birthday designs (as exported from Canva): pick a page, or save them all
  let pdfPath = process.env.TEST_PDF;
  if (!pdfPath) {
    const mk = await browser.newPage();
    await mk.setContent(`<style>@page{size:1440px 810px;margin:0}body{margin:0}div{width:1440px;height:810px;display:flex;flex-direction:column;align-items:center;justify-content:center;font:bold 90px Arial;color:#fff;page-break-after:always}</style>
      <div style="background:#4f8ff7">HAPPY BIRTHDAY<span style="font-size:160px">KIAN</span><span style="font-size:30px">From Australian Martial Arts Academy</span></div>
      <div style="background:#2a2a8f">HAPPY BIRTHDAY<span style="font-size:160px">ASTRO</span></div>`);
    pdfPath = join(tmpdir(), 'tv-test-birthdays.pdf');
    await mk.pdf({ path: pdfPath, width: '1440px', height: '810px', printBackground: true }); await mk.close();
  }
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.click('#pForm [data-m="image"]');
  await page.click('#pPick'); await page.setInputFiles('#pickParty', pdfPath);
  await page.waitForSelector('#pForm [data-page]', { timeout: 60000 });
  const pageNames = await page.$$eval('#pForm [data-page] span', ss => ss.map(x => x.textContent));
  console.log('        PDF pages:', pageNames.join(', '));
  ok(pageNames.length >= 2 && (process.env.TEST_PDF || pageNames.join() === 'Kian,Astro'), 'a PDF shows each page to pick from, named after the birthday child');
  await page.screenshot({ path: join(SHOTS, 'tv-party-pdf.png') });
  await page.click('#pForm [data-page="1"]'); await page.waitForSelector('#pForm .preview-img');
  ok((await page.inputValue('#pCap')) === pageNames[1], 'picking a page gets it ready, named');
  await page.click('#pGo'); await page.waitForSelector('#partyStop');
  const pdfSlide = (await db.query(`select s.kind, s.media_path, s.title from tv_settings t join tv_slides s on s.id = t.only_slide`)).rows[0];
  ok(pdfSlide.kind === 'photo' && pdfSlide.title === pageNames[1] && files.get(pdfSlide.media_path).type === 'image/jpeg', 'the chosen page goes on the TV as a full-screen image');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  const before = (await db.query(`select count(*)::int n from tv_slides where party`)).rows[0].n;
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  await page.click('#pForm [data-m="image"]'); await page.click('#pPick'); await page.setInputFiles('#pickParty', pdfPath);
  await page.waitForSelector('#pSaveAll', { timeout: 60000 }); await page.click('#pSaveAll');
  await page.waitForSelector('#pForm [data-m="saved"][aria-pressed="true"]', { timeout: 60000 });
  ok((await db.query(`select count(*)::int n from tv_slides where party`)).rows[0].n === before + pageNames.length, '"Save all" keeps every design for next time, under Saved');
  await page.screenshot({ path: join(SHOTS, 'tv-party-saved.png') });
  await page.evaluate(() => document.querySelector('#dlg').close());

  // PDFs in the normal slideshow: one slide per page
  const normalBefore = (await db.query(`select count(*)::int n from tv_slides where not party and kind = 'photo'`)).rows[0].n;
  await page.setInputFiles('#pickPhotos', pdfPath);
  await toastSays(page, 'Added').catch(() => {});
  await page.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && /^Added/.test(t.textContent); }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(500);
  ok((await db.query(`select count(*)::int n from tv_slides where not party and kind = 'photo'`)).rows[0].n === normalBefore + pageNames.length, 'a PDF added under Photos becomes one slide per page');
  await tv.ctx.close(); await ctx.close();

  // Birthday posters: import templates, type a name, show it
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#partyStart');
  let tplFile = process.env.TEMPLATES_JSON;
  if (!tplFile) {
    const img = 'data:image/png;base64,' + readFileSync(join(ROOT, 'icons/ama-id-cards.png')).toString('base64');
    tplFile = join(tmpdir(), 'tv-test-templates.json');
    (await import('node:fs')).writeFileSync(tplFile, JSON.stringify({ app: 'ama-tv-templates', templates: [
      { title: 'Classic', image: img, settings: { size: 200, box: { cx: 960, base: 560, maxW: 1240 }, font: 'Montserrat', weight: 800, fill: '#ffffff', stroke: '', strokeWidth: 0, spacing: 0.04, uppercase: true } },
      { title: 'Turtles', image: img, settings: { size: 285, box: { cx: 960, base: 550, maxW: 1340 }, font: 'Luckiest Guy', fill: '#ffffff', stroke: '#000000', strokeWidth: 0.1, uppercase: true } }] }));
  }
  await page.click('#partyStart'); await page.waitForSelector('#pForm');
  ok(await page.isVisible('#pForm [data-m="poster"]'), 'party mode has a Poster option');
  await page.click('#pForm [data-m="poster"]'); await page.waitForSelector('#pImport');
  await page.click('#pImport'); await page.setInputFiles('#pickImport', tplFile);
  await page.waitForSelector('#pForm [data-tpl]', { timeout: 60000 });
  const nT = (await db.query(`select count(*)::int n from tv_poster_templates`)).rows[0].n;
  ok(nT >= 2 && (await page.$$('#pForm [data-tpl]')).length === nT, `templates imported (${nT}) and shown to pick from`);
  await page.click('#pForm [data-tpl]:nth-child(2)');
  await page.fill('#pPoster', 'Maximilian'); await page.waitForTimeout(800);
  const painted = await page.evaluate(() => { const c = document.querySelector('#pCanvas'), d = c.getContext('2d').getImageData(0, 0, 1920, 1080).data; let n = 0; for (let i = 0; i < d.length; i += 4000) if (d[i] || d[i + 1] || d[i + 2]) n++; return n; });
  ok(painted > 50, 'typing a name draws the poster preview');
  await page.screenshot({ path: join(SHOTS, 'tv-poster-editor.png') });
  const dl = page.waitForEvent('download'); await page.click('#pDownload'); const dlf = await dl;
  ok(dlf.suggestedFilename() === 'birthday-maximilian.png', 'Download saves the poster as a picture');
  await page.selectOption('#pFor', '120'); await page.click('#pGo'); await page.waitForSelector('#partyStop', { timeout: 30000 });
  const ps = (await db.query(`select s.kind, s.title, s.media_path from tv_settings t join tv_slides s on s.id = t.only_slide`)).rows[0];
  ok(ps.kind === 'photo' && /^Maximilian \(/.test(ps.title) && files.get(ps.media_path).type === 'image/jpeg' && files.get(ps.media_path).body.length > 10000, 'Show on the TV makes the poster and puts it on in party mode');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');

  // Add a template: choose a design, drag where the name goes, pick the lettering
  await page.click('#partyStart'); await page.waitForSelector('#pManage'); await page.click('#pManage');
  await page.waitForSelector('#tAdd'); await page.click('#tAdd');
  await page.click('#tPick'); await page.setInputFiles('#pickTpl', join(ROOT, 'icons/clipboard.png'));
  await page.waitForSelector('#tCanvas');
  const box = await page.$eval('#tCanvas', c => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await page.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.4); await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5, { steps: 4 }); await page.mouse.move(box.x + box.w * 0.8, box.y + box.h * 0.6, { steps: 4 }); await page.mouse.up();
  await page.fill('#tTitle', 'Ninja'); await page.selectOption('#tFont', 'Knewave'); await page.fill('#tSample', 'Ayda');
  await page.screenshot({ path: join(SHOTS, 'tv-template-editor.png') });
  await page.click('#tSave'); await page.waitForSelector('#tAdd');
  const nt = (await db.query(`select settings from tv_poster_templates where title = 'Ninja'`)).rows[0];
  ok(nt && nt.settings.font === 'Knewave' && Math.abs(nt.settings.box.cx - 960) < 40 && Math.abs(nt.settings.box.cy - 540) < 40 && nt.settings.box.maxW > 1000, 'a new template saves the dragged name area and lettering');
  await ctx.close();

  // Countdowns, TV status, remote refresh and booked parties
  console.log('\nCountdowns, TV status, refresh and bookings');
  await db.query(`delete from tv_screens`);
  ({ ctx, page } = await context({ width: 390, height: 844 }));
  await page.goto(BASE + '/tv/edit/index.html');
  await page.fill('#siEmail', 'tate@ama.test'); await page.fill('#siPass', 'pw'); await page.click('#siGo');
  await page.waitForSelector('#status:not([hidden])');
  ok((await page.textContent('#status')).includes('No TV has checked in yet'), 'TV status says when no TV has checked in');
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const in21 = ymd(new Date(Date.now() + 21 * 864e5));
  await page.click('#addBtn'); await page.click('[data-add="countdown"]'); await page.waitForSelector('#slEvent');
  await page.fill('#slTitle', 'Comp'); await page.fill('#slEvent', in21);
  ok((await page.textContent('#cdPrev')).includes('Comp · 3 weeks to go'), 'countdown editor shows what the TV will say');
  await page.click('#slSave'); await toastSays(page, 'Added');
  await page.click('#addBtn'); await page.click('[data-add="countdown"]'); await page.waitForSelector('#slEvent');
  await page.check('#slForm input[name=cdTo][value=grading]'); await page.click('#slSave'); await toastSays(page, 'Added');
  await page.waitForTimeout(500);
  const cds = (await db.query(`select title, count_to, event_on::text e from tv_slides where kind = 'countdown' order by position`)).rows;
  ok(cds.length === 2 && cds[0].title === 'Comp' && cds[0].e === in21 && cds[1].count_to === 'grading', 'countdowns saved: one to a date, one to the next grading');
  ok((await page.textContent('#list')).includes('Countdown to the next grading'), 'the list says what each countdown counts to');

  const tvc = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await tvc.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: configJs }));
  await tvc.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
  const tvp = await tvc.newPage();
  tvp.on('pageerror', e => errors.push('tv: ' + e.message));
  await tvp.goto(BASE + `/tv/index.html?code=${CODE}`); await tvp.waitForSelector('.layer.on');
  const words = [];
  for (let i = 0; i < (await tvp.evaluate(() => window.__tv.state().count)); i++) {
    await tvp.waitForTimeout(500);
    words.push(await tvp.evaluate(() => { const l = document.querySelectorAll('.layer.on'); return l[l.length - 1].textContent; }));
    if (/Comp/.test(words[words.length - 1])) await tvp.screenshot({ path: join(SHOTS, 'tv-countdown.png') });
    await tvp.evaluate(() => window.__tv.next());
  }
  const wall = words.join(' | ');
  ok(/Comp\s*3\s*weeks to go/.test(wall), 'the TV shows "Comp 3 weeks to go"');
  ok(/Black belt grading\s*6\s*weeks to go/.test(wall), 'the grading countdown uses the date from Black Belt Prep');

  await tvp.waitForFunction(() => true); await page.waitForTimeout(2500);
  await page.evaluate(() => pollStatus()); await page.waitForTimeout(400);
  const stText = await page.textContent('#status');
  ok(stText.includes('The TV is online') && /Checked in \d+ s ago/.test(stText) && stText.includes(' of '), 'TV status shows it online, what it is showing and when it last checked in');
  await page.screenshot({ path: join(SHOTS, 'tv-status.png') });

  const started1 = await tvp.evaluate(() => window.__tv.started);
  await page.click('#tvReload'); await toastSays(page, 'Sent');
  await Promise.all([tvp.waitForEvent('load', { timeout: 8000 }), tvp.evaluate(() => window.__tv.checkIn())]).catch(() => {});
  await tvp.waitForSelector('.layer.on');
  ok((await tvp.evaluate(() => window.__tv.started)) !== started1, 'Refresh the TV makes the TV reload');
  await tvp.evaluate(() => window.__tv.checkIn()); await tvp.waitForTimeout(800);
  ok((await tvp.evaluate(() => window.__tv.started)) !== started1 && (await db.query(`select count(*)::int n from tv_screens`)).rows[0].n === 1, 'and it only reloads once');

  // Book a party for tomorrow afternoon
  const tmr = ymd(new Date(Date.now() + 864e5));
  await page.click('#partyBook'); await page.waitForSelector('#bDate');
  await page.click('#pForm [data-m="message"]'); await page.waitForSelector('#pName');
  ok(await page.inputValue('#bDate') !== '' && await page.isVisible('#bFrom'), 'Book for later asks for the date and times');
  await page.fill('#bDate', tmr); await page.fill('#bFrom', '14:00'); await page.fill('#bTo', '17:00'); await page.fill('#pName', 'Kian');
  await page.click('#pGo'); await toastSays(page, 'Booked');
  const bk = (await db.query(`select b.*, s.title from tv_party_bookings b join tv_slides s on s.id = b.slide_id`)).rows;
  ok(bk.length === 1 && bk[0].title === 'Happy Birthday Kian!' && new Date(bk[0].starts_at).getHours() === 14 && new Date(bk[0].ends_at).getHours() === 17, 'the party is booked with its name and times');
  await page.waitForSelector('#party .booked', { timeout: 5000 }).catch(() => {});
  ok((await page.textContent('#party')).includes('Happy Birthday Kian!') && (await page.textContent('#party')).includes('2:00'), 'the booking shows under Party mode');
  await page.click('#partyBook'); await page.waitForSelector('#bDate'); await page.click('#pForm [data-m="message"]'); await page.waitForSelector('#pName');
  await page.fill('#bDate', tmr); await page.fill('#bFrom', '16:00'); await page.fill('#bTo', '18:00'); await page.fill('#pName', 'Ava');
  await page.click('#pGo');
  ok((await toastSays(page, 'Another party')).includes('Another party is booked'), 'two parties cannot be booked at the same time');
  await page.click('#pForm [data-close]');

  // The time comes: the TV switches by itself, then back at the end
  await db.query(`update tv_party_bookings set starts_at = now() - interval '1 minute', ends_at = now() + interval '2 hours'`);
  await tvp.evaluate(() => window.__tv.reload());
  await tvp.waitForFunction(() => window.__tv.state().count === 1, null, { timeout: 6000 }).catch(() => {});
  ok((await tvp.evaluate(() => window.__tv.state().count)) === 1 && (await tvp.textContent('body')).includes('Kian'), 'at the start time the TV shows only the party');
  await page.evaluate(() => pollStatus()); await page.waitForSelector('#partyStop');
  ok((await page.textContent('#party')).includes('Booked party is on'), 'the editor shows the booked party is on');
  await page.click('#partyStop'); await toastSays(page, 'Back to normal');
  await tvp.evaluate(() => window.__tv.reload());
  await tvp.waitForFunction(() => window.__tv.state().count > 1, null, { timeout: 6000 }).catch(() => {});
  ok((await tvp.evaluate(() => window.__tv.state().count)) > 1, '"Back to normal now" ends the booked party early');
  await tvc.close(); await ctx.close();

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
