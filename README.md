# A-List Planner

Plan which movies you and your entourage spend your AMC Stubs A-List admissions on. Served at `amc.durpeesquid.com`.
Static site (no framework), same Supabase project and shared login as [durpeesquid](https://github.com/bentran38/durpeesquid):
`site/session.js` imports `https://www.durpeesquid.com/auth.js`, so the cookie session and the colour theme carry over.

- **Plan** (`/`): each person's 4 admissions for this A-List week (used, booked, planned, open), how many reservations
  they hold, and every planned showing grouped by A-List week, with who is going. Mark a showing reserved once it is
  booked in the AMC app, cancel it, note a seat, add the other person, or check how many seats are left.
- **Movies** (`/movies`): now playing, advance tickets and coming soon from AMC, with release dates. Star the ones you want
  to see; the plan page shows the group's wishlist.
- **Movie** (`/movie/<id>`): showtimes at your theatres for the next two weeks, grouped by format, with sold-out and
  almost-full flags. Pick a showtime to see the live seat map and add it to the plan for any of you. Each person is
  checked against the A-List rules before you save.
- **Theatres** (`/theatres`, `/theatre/<id>`): search AMC by state, city or name and save the ones you go to; a theatre
  page lists everything on that day.
- **History**, **Rules**: what everyone has watched, and the rules below.
- **Add by hand**: plan a showing without AMC data (also works before the AMC key is set up).

## A-List rules

From AMC's [A-List terms](https://www.amctheatres.com/amcstubs/alist/terms-and-conditions), checked November 2026:

- Up to **4 showtimes per A-List week**. A week runs **Friday 6:00 AM to the next Friday 5:59 AM**. Unused admissions
  don't carry over, and no-shows still count.
- **No more than 4 pending reservations at any one time**, whatever week they fall in.
- Several on the same day are fine **as long as the showtimes don't overlap**.
- Entourage: A-List members can make reservations for one another in the AMC app.

How the planner applies them (enforced by the database in `amc.check_alist`, mirrored in `site/rules.js` for display):
planned and reserved showings both use one of the week's 4; only reserved ones count toward the 4-at-a-time limit (you
can plan further ahead and reserve once one is used); overlapping showings for one person are refused; cancelling frees
the admission. A week is measured in the theatre's time zone.

## How it fits together

- **Database**: its own `amc` schema (`supabase/migrations/20261110000000_amc.sql`): `theatres` (the group's list),
  `outings` (a showing), `attendees` (who is going, planned/reserved/cancelled), `wants`, `api_cache`, the `admissions`
  view, `members()` and `plan_showing()`. Everyone with `project_access` for slug `amc` is one entourage: they see each
  other's plans and can plan for each other. Rule checks run in triggers, one person at a time (advisory lock), so two
  phones can't both slip a fifth movie in.
- **AMC data**: the `amc-api` Edge Function calls the AMC Theatres API (`api.amctheatres.com`, header
  `X-AMC-Vendor-Key`) so the key never reaches the browser, and caches answers in `amc.api_cache` (movies 6 h,
  theatres 24 h, showtimes 10 min, seats 45 s). Without the key it answers `{ code: 'no_key' }` and the site says so.
- **Site**: `site/` is plain ES modules. `app.js` (pages and routing), `api.js` (data), `rules.js` (A-List rules),
  `ui.js`. Same colour themes and look as the other sites (tokens from `themes.css`).

## Setup

1. **Migration**: apply `supabase/migrations/20261110000000_amc.sql`, then expose the schema
   (`alter role authenticator set pgrst.db_schemas = '<existing list>, amc'; notify pgrst, 'reload config';`).
2. **Project row**: `insert into public.projects (slug, title, url) values ('amc', 'A-List Planner', 'https://amc.durpeesquid.com');`
   then give both of you access on the admin dashboard. The homepage icon and cover are in the main site's
   `site/project-icons.js`.
3. **AMC key**: request a free vendor key at [developers.amctheatres.com](https://developers.amctheatres.com), then save it
   as a function secret: `supabase secrets set AMC_VENDOR_KEY=...`.
4. **Function**: `supabase functions deploy amc-api --no-verify-jwt` (it checks the caller itself).
5. **Vercel**: set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as the main site);
   `amc.durpeesquid.com` as the domain.

## Local dev

- `npm run dev:mock` serves the site on http://localhost:8003 with a fake sign-in, a second member, made-up movies,
  showtimes and seat maps (`dev/`). Add `?nokey` to see the "AMC key not set up" state. Nothing in `dev/` is deployed.
- `npm test` runs the real migration in an in-process Postgres (PGlite) and checks the A-List rules, access rules, and
  that `site/rules.js` agrees with the SQL on what an A-List week is.
