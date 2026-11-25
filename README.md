# A-List Planner

Plan which movies you and your entourage spend your AMC Stubs A-List admissions on. Served at `amc.durpeesquid.com`.
Static site (no framework), same Supabase project and shared login as [durpeesquid](https://github.com/bentran38/durpeesquid):
`site/session.js` imports `https://www.durpeesquid.com/auth.js`, so the cookie session and the colour theme carry over.

- **Plan** (`/`): each person's 4 admissions for this A-List week (used, booked, planned, open), how many reservations
  they hold, and every planned showing grouped by A-List week, with who is going. Mark a showing reserved once it is
  booked in the AMC app, cancel it, note a seat, add the other person, or open the seat map on AMC.
- **Movies** (`/movies`): what is showing today at the tracked theatres, and movies seen on earlier days. Star the ones you
  want to see; the plan page shows the group's wishlist.
- **Movie** (`/movie/<id>`): today's showtimes, grouped by format, with sold-out and "Not A-List" flags (AMC marks some
  showings, often 3D, as excluded from A-List). Pick one to add it to the plan for any of you; each person is checked
  against the A-List rules before you save, and the AMC seat map is a link away.
- **Theatres** (`/theatres`, `/theatre/<id>`): the theatres the scraper reads (AMC Columbia 14 on; Tysons Corner 16 set
  up but off), with a switch for each; a theatre page lists everything on today.
- **History**, **Rules**: what everyone has watched, and the rules below.
- **Add by hand**: plan any showing on any day (suggests movies the scraper has seen and fills in their runtime). This is
  how later days get planned, since only today's showtimes are read.

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
  `outings` (a showing), `attendees` (who is going, planned/reserved/cancelled), `wants`, the `admissions`
  view, `members()` and `plan_showing()`. Everyone with `project_access` for slug `amc` is one entourage: they see each
  other's plans and can plan for each other. Rule checks run in triggers, one person at a time (advisory lock), so two
  phones can't both slip a fifth movie in.
- **Showtimes**: AMC has no public API to be had, so `scraper/` reads amctheatres.com. The site is Next.js behind
  Cloudflare and streams its data into the page (`self.__next_f.push` chunks); `scraper/parse.js` pulls the theatre,
  movies (name, rating, runtime, poster) and showtimes (id, UTC start, sold-out status, format group and its tags) out
  of that. Cloudflare refuses headless Chrome and plain HTTP, and lets a visible Chrome window load **one page** before
  refusing the next (seat pages always). So each run reads one page per theatre, today's, and stops; nothing tries to
  get around the block. A blocked run is logged and the site shows the data as stale.
- **Ingest**: `scraper/scrape.js` sends the result to the `amc-ingest` Edge Function with the `x-ingest-token` header
  (`AMC_INGEST_TOKEN`, a secret good for nothing else), which calls `amc.ingest()` as the service role. That upserts
  `movies` and `showtimes`, deletes showtimes AMC dropped from a day it read, clears ones over 2 days old, and logs the run
  in `scrape_runs` (`supabase/migrations/20261125000000_amc_scrape.sql`). Members can only read these tables.
- **Site**: `site/` is plain ES modules. `app.js` (pages and routing), `api.js` (data), `rules.js` (A-List rules),
  `ui.js`. Same colour themes and look as the other sites (tokens from `themes.css`).

## Setup

1. **Migrations**: apply `supabase/migrations/20261110000000_amc.sql` and `20261125000000_amc_scrape.sql`. The `amc`
   schema must be in `pgrst.db_schemas`.
2. **Project row**: `insert into public.projects (slug, title, url) values ('amc', 'A-List Planner', 'https://amc.durpeesquid.com');`
   then give both of you access on the admin dashboard. The homepage icon and cover are in the main site's
   `site/project-icons.js`.
3. **Ingest function**: `supabase functions deploy amc-ingest --no-verify-jwt`, and set its `AMC_INGEST_TOKEN` secret
   (32+ random characters) to the same value as in `scraper/.env`.
4. **Vercel**: set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (same values as the main site);
   `amc.durpeesquid.com` as the domain.

## Scraper

Runs on a Windows PC with Google Chrome, since Cloudflare turns away cloud runners and headless browsers.

- `cd scraper && npm install`, then create `scraper/.env` (git-ignored):
  `SUPABASE_URL=https://<project>.supabase.co` and `AMC_INGEST_TOKEN=<same as the function secret>`.
- `node scrape.js --dry --theatre baltimore/amc-columbia-14` prints what it would store; `node --env-file=.env scrape.js`
  stores it.
- `scripts/scrape.ps1` runs it once and appends to `scraper/scrape.log`. Task Scheduler runs that at 8:00, 12:00, 16:00
  and 20:00 (task "AMC showtimes"); a Chrome window opens for a few seconds each time.
- If AMC changes its page, `parse.js` is where to look; the planner keeps working with Add by hand meanwhile.

## Local dev

- `npm run dev:mock` serves the site on http://localhost:8003 with a fake sign-in, a second member, and made-up scraped
  movies and showtimes (`dev/`). Add `?noruns` to see the "no showtimes yet" state. Nothing in `dev/` is deployed.
- `npm test` runs the real migration in an in-process Postgres (PGlite) and checks the A-List rules, access rules, and
  that `site/rules.js` agrees with the SQL on what an A-List week is.
