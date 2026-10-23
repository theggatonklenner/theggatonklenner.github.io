# AMA Grading Toolkit

The home page at https://theggatonklenner.github.io, with links to the grading tools and admin tools.

- `index.html` the home page. To add a tool, copy one of the `<li>` blocks, change the link, name and description, and put its icon in `icons/`.
- `tv/` **TV display** for the dojang TV (open on the TV), and `tv/edit/` the editor. Setup below.
- `staff/` **Staff logins**: add logins, set passwords and set roles for AMA ID Cards and Black Belt Prep in one place.
- `supabase/functions/staff/index.ts` the Supabase function behind Staff logins.
- `tests/` checks for the staff function and page.

## Setting up Staff logins (once, about 3 minutes)

1. In Supabase, open **Edge Functions > Deploy a new function > Via Editor**.
2. Name it `staff`, replace the example code with the whole of `supabase/functions/staff/index.ts`, and click **Deploy**.
3. Open the function's **Details** (or settings), turn **off** "Verify JWT with legacy secret" (older screens call it "Enforce JWT verification"), and save. The function checks who is signed in itself.
4. Open https://theggatonklenner.github.io/staff/ and sign in.

Before using it, run `supabase/permissions.sql` from the ama-id-cards repository (tick-box permissions for AMA ID Cards).

Only people who are an admin in **both** AMA ID Cards and Black Belt Prep can use it. Each app always keeps at least one admin, and you can't remove your own admin access or your own login.

Signing in or out here also signs you in or out of the two apps on that device, because they share the same web address.

## Tests

```
node tests/staff-function.test.mjs
node tests/staff-page.test.mjs     # needs Playwright and supabase-js (see the top of the file)
node tests/tv-db.test.mjs
node tests/tv-page.test.mjs        # TEMPLATES_JSON=templates file and FONTS_DIR=@fontsource folder to try real posters; also needs pdfjs-dist@3.11.174 (PDFJS=path to its build folder); TEST_PDF=your.pdf to try a real file
```

## Setting up the TV display (once, about 3 minutes)

1. In Supabase, open **SQL Editor > New query**, paste the whole of `supabase/tv-setup.sql`, and click **Run** (choose "with RLS" if asked).
2. Open https://theggatonklenner.github.io/tv/edit/ on your phone, sign in, and add some slides. Note the **screen code** under Settings.
3. On the TV, open its web browser, go to **theggatonklenner.github.io/tv**, type the screen code once, and press OK on the remote for full screen. Bookmark it, or set it as the browser's home page, so it opens straight away next time.

The TV picks up changes within 20 seconds, keeps playing its last slides if the internet drops, and reloads itself once a night. On the remote, right and left skip between slides.

- **Photos** are resized to TV size before uploading. A **PDF** (e.g. exported from Canva) works too: each page becomes a slide. **Videos** (MP4 works best) play without sound, up to 50 MB each.
- **Info slides**: heading, text, a colour, and an optional background photo.
- **Live slides** fill themselves in: the next grading date (from Black Belt Prep), events this month, and the month theme. A live slide only shows when there's something to show.
- **Party mode** (top of the editor): show only one thing, like a birthday message (typed, with confetti) or an uploaded birthday image or Canva PDF (pick the page, or **Save all** so each design is one tap next time; designs are named after the child automatically), for 1, 2 or 3 hours, the rest of the day, or until a set time. The TV switches straight to it and goes back to the slideshow by itself; **Back to normal now** ends it early. Party slides are saved (kept out of the slideshow) to reuse.
- **Book for later** (Party mode): pick what to show, then the date, start and end time. The TV switches to it by itself at the start and back at the end. Upcoming bookings are listed with **Cancel**; two can't overlap.
- **Countdowns** (Add > Countdown): "Comp · 3 weeks to go" for any event and date, or to the next black belt grading (date from Black Belt Prep). Days under 3 weeks, then weeks; it drops off by itself after the day.
- **TV status** (top of the editor): whether the TV is online, what it's showing and when it last checked in (every 20 seconds). **Refresh the TV** makes it reload within 20 seconds. The editor's Preview doesn't count as a TV.
- **QR code** (Add > QR code): paste any link (e.g. instagram.com/...), add a heading like "Scan to book a free trial", and the code is made for you. The TV shows the heading and a big code (not the link). Test it with your phone before saving.
- **Slideshow hours** (Settings): set when the slideshow plays on each day (e.g. Mon 3:30 to 8:45 pm, Sat 8 am to 1 pm), or mark a day off all day; **Copy Monday** fills in Tuesday to Friday. At other times the TV shows a dimmed AMA logo or a black screen. A party still shows. Many TVs also have their own off timer, which saves power.
- **Black out the screen** (remote, or TV status in the editor): the TV goes black until you tap **Turn the screen back on**, even during a party or slideshow hours.
- **Tablets** (the TV / Tablets switch at the top of the editor, or Tablet Display on the home page): a second display with its own slides, party mode, slideshow hours and settings, laid out for upright screens. Settings shows its link with the code in it (Copy or QR code): open it on each tablet and it plays straight away, no code to type. Add it to the tablet's home screen so it opens with one tap. Use the same link on as many tablets as you like: they all play the same slides and follow the remote. In TV status (Tablets) each one is listed, and **Name** labels it, e.g. Front desk. The events calendar and poster templates are shared with the TV.
- **Scheduled screen-off times** (Settings, under slideshow hours): e.g. Saturday 10:00, 10:30 and 11:00 for 5 minutes each (**Add a time** copies the last one 30 minutes later). Each can be for every screen, one location, or one named device. The screen shows the same logo or black as the slideshow hours; a party still shows.
- **Sign-in page** (Settings, e.g. on the Tablets): **A tap goes to the sign-in page** (the default, for sites that can't be shown inside another page, like ESC at https://kiosk.efcaquila.net/): the slides show with "Tap to sign in", a tap opens the sign-in page, and the **Fully Kiosk Browser** app brings the slides back (Start URL = the tablet link; Web Auto Reload > Auto Reload on Idle = e.g. 60; Skip Auto Reload if Showing the Start URL = on). Or **Shows it inside the slides** (only for sites that allow it; **Test** checks): it starts on the sign-in page and goes back to the slides by itself after the set time. Either way, during a party or a blackout taps do nothing. Or **Handled by FreeKiosk**: in FreeKiosk, Start URL = the sign-in page, Screensaver on with its URL = the tablet link (delay e.g. 60 s, brightness normal), REST API on (port 8080, key optional). During a party or blackout the tablet asks FreeKiosk's REST API to put the party on the main screen within 20 seconds (so taps don't leave it), then goes back to the sign-in page.
- **Low battery** (Settings, 20% to start, 0 = off): a red bar along the top asks for the screen to be plugged in when its battery is below the level and it isn't charging. Each device's battery % shows in TV status. The % comes from the browser, or from FreeKiosk's REST API on tablets that use it.
- **Message at the bottom** (Settings): a gold bar along the bottom with every slide, e.g. "Tap to sign in" (on for the tablets, off for the TV to start with). Hidden during parties, quiet hours and blackouts.
- **Locations** (Settings > Locations; starts with Marrickville, Sydenham, Concord, Auburn, Sylvania): give each TV or tablet a location in TV status (**Edit**), or open it with a location link (Settings: "For a device at"). Slides (**Show at**) and parties (**Where**) can be for one location; a device shows those for its location plus anything for every location. A device with no location shows only what's for every location. Different locations can each have a party at the same time.
- **Light on Supabase:** a screen's check every 20 seconds is a few bytes unless something changed (the whole slideshow is only sent after a change), and each photo and video is kept on the screen after its first download (tv/sw.js), so it comes from Supabase once.
- **Phone remote** (tv/remote/, or Remote in the editor): Back, Pause/Play, Next, and tap any slide to show it now. The TV notices the remote within 20 seconds of opening it, then responds in a second or two; 10 minutes after the remote's last use (or **Done**) the slideshow carries on as normal.
- **Month theme** (Add > Live: Month theme): "This is the Month of ..." for the current month, from the month themes in the events calendar. It changes by itself each month.
- **Events calendar** (Events, in the editor): add events (date, optional end date, what, optional note) and each month's theme, or **Import a calendar file**. The **Live: Events this month** slide shows what's left of this month; in the last 10 days of the month it adds next month beside it. Past events drop off by themselves.
- **Linked parties (TV + tablets):** starting or booking a party has **Also on the tablets** (or **Also on the TV**), ticked. One name makes both posters: the TV gets the wide design, the tablets its upright version (with the waiver QR code). Back to normal, 1 more hour, bookings and cancelling all apply to both. Each template can have a **tablet version** (Manage templates > Add tablet, or import a tablet versions file; it's matched to templates by name). Without one, the tablets show the TV poster.
- **Birthday posters** (Party mode > Poster): pick a design, type the child's name, and it's drawn on in the design's own lettering (font, colour, outline, curve), shrinking to fit long names. **Show on the TV** puts it on in party mode; **Download** saves it as a picture. **Manage templates** adds a design (in Canva, delete the name and download it as PNG or PDF, then drag a box where the name goes and pick the lettering) or **Import**s a templates file.
- Each slide can be turned off, given its own time on screen, or set to show only between two dates.
- **Who can use the TV** is set on the Staff logins page (Dojang TV) with tick boxes: **Editor** (everything), **Party mode** (start, stop and book parties and birthday posters; their editor shows only Party mode) and **Remote** (the phone remote). Someone with only TV access can't open AMA ID Cards or Black Belt Prep. Admins in either app can always use the TV. When this was added, everyone who could already edit the TV kept it. **New code** under Settings stops any TV using the old code until the new one is typed in.
- Photos and videos are public to anyone with their exact link (the TV shows them without signing in), so only add what you'd put on the dojang wall.
