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
node tests/tv-page.test.mjs
```

## Setting up the TV display (once, about 3 minutes)

1. In Supabase, open **SQL Editor > New query**, paste the whole of `supabase/tv-setup.sql`, and click **Run** (choose "with RLS" if asked).
2. Open https://theggatonklenner.github.io/tv/edit/ on your phone, sign in, and add some slides. Note the **screen code** under Settings.
3. On the TV, open its web browser, go to **theggatonklenner.github.io/tv**, type the screen code once, and press OK on the remote for full screen. Bookmark it, or set it as the browser's home page, so it opens straight away next time.

The TV picks up changes within 20 seconds, keeps playing its last slides if the internet drops, and reloads itself once a night. On the remote, right and left skip between slides.

- **Photos** are resized to TV size before uploading. **Videos** (MP4 works best) play without sound, up to 50 MB each.
- **Info slides**: heading, text, a colour, and an optional background photo.
- **Live slides** fill themselves in from Black Belt Prep: the next grading date, the next prep sessions, and congratulations to students who passed in the last 45 days (certificate names and new rank; nothing else about students). A live slide only shows when there's something to show.
- **Party mode** (top of the editor): show only one thing, like a birthday message (typed, with confetti) or an uploaded birthday image, for 1, 2 or 3 hours, the rest of the day, or until a set time. The TV switches straight to it and goes back to the slideshow by itself; **Back to normal now** ends it early. Party slides are saved (kept out of the slideshow) to reuse.
- Each slide can be turned off, given its own time on screen, or set to show only between two dates.
- Anyone with an AMA staff login can edit. **New code** under Settings stops any TV using the old code until the new one is typed in.
- Photos and videos are public to anyone with their exact link (the TV shows them without signing in), so only add what you'd put on the dojang wall.
