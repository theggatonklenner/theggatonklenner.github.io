# AMA Grading Toolkit

The home page at https://theggatonklenner.github.io, with links to the grading tools and admin tools.

- `index.html` the home page. To add a tool, copy one of the `<li>` blocks, change the link, name and description, and put its icon in `icons/`.
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
```
