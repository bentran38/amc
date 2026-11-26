// Runs the real migration in an in-process Postgres (PGlite) with a stand-in for Supabase's auth
// plumbing, then checks the A-List rules and access rules the planner depends on, and that the
// JS copy of the rules (site/rules.js) agrees with the SQL on what an A-List week is.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { alistWeek, canAttend, standing, wallToUtc } from '../site/rules.js';

const MIGRATIONS = new URL('../supabase/migrations/', import.meta.url);
const ANN = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';
const EVE = '00000000-0000-0000-0000-00000000000e'; // signed in, no access to the planner
const TZ = 'America/New_York';

let db;

const BOOTSTRAP = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to authenticated, service_role, anon;
  grant select on auth.users to authenticated;
  create table public.project_access (user_id uuid, project_slug text, primary key (user_id, project_slug));
  create table public.profiles (user_id uuid primary key, handle text, display_name text not null default '');
  grant select on public.project_access, public.profiles to authenticated, service_role;
`;

async function as(user, sql, params) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false)`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`);
  }
}

// a showing `days` from now at `hour` (theatre time is close enough for these checks)
let n = 0;
const showing = (startIso, minutes = 120, extra = {}) => ({
  showtime_id: 9000 + ++n, movie_name: `Movie ${n}`, theatre_name: 'AMC Test 12', tz: TZ,
  starts_at: startIso, ends_at: new Date(Date.parse(startIso) + minutes * 60e3).toISOString(), ...extra,
});
const plan = (user, outing, people, status = 'planned') =>
  as(user, 'select amc.plan_showing($1::jsonb, $2::uuid[], $3) as id', [JSON.stringify(outing), people, status]).then((r) => r.rows[0].id);

// next Friday 12:00 (New York) at least 14 days out, so tests never touch the real "now"
const base = (() => {
  const d = new Date(Date.now() + 14 * 864e5);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const at = (dayOffset, time) => {
  const d = new Date(Date.parse(`${base}T00:00:00Z`) + dayOffset * 864e5).toISOString().slice(0, 10);
  return wallToUtc(d, time, TZ).toISOString();
};

before(async () => {
  db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  await db.exec(`
    insert into auth.users values ('${ANN}'), ('${BOB}'), ('${EVE}');
    insert into public.project_access values ('${ANN}', 'amc'), ('${BOB}', 'amc'), ('${EVE}', 'picks');
    insert into public.profiles values ('${ANN}', 'ann', 'Ann'), ('${BOB}', 'bob', '');
  `);
});

test('the A-List week starts Friday 6:00 AM, in SQL and in JS', async () => {
  const cases = [
    ['2026-11-13', '05:59', '2026-11-06'], // Friday before 6am: still last week
    ['2026-11-13', '06:00', '2026-11-13'],
    ['2026-11-19', '23:30', '2026-11-13'], // Thursday night
    ['2026-11-20', '05:30', '2026-11-13'], // early Friday
    ['2026-11-15', '14:00', '2026-11-13'],
  ];
  for (const [day, time, want] of cases) {
    for (const tz of [TZ, 'America/Los_Angeles']) {
      const ts = wallToUtc(day, time, tz).toISOString();
      const { rows } = await db.query('select amc.alist_week($1::timestamptz, $2)::text as w', [ts, tz]);
      assert.equal(rows[0].w, want, `SQL ${day} ${time} ${tz}`);
      assert.equal(alistWeek(ts, tz), want, `JS ${day} ${time} ${tz}`);
    }
  }
});

test('members see the entourage; others see nothing', async () => {
  const { rows } = await as(ANN, 'select * from amc.members()');
  assert.deepEqual(rows.map((r) => r.display_name).sort(), ['Ann', 'bob']);
  assert.equal((await as(EVE, 'select * from amc.members()')).rows.length, 0);
  await assert.rejects(plan(EVE, showing(at(0, '19:00')), [EVE]), /No access/);
});

test('4 movies per A-List week, then the fifth is refused', async () => {
  for (const [d, t] of [[0, '10:00'], [1, '10:00'], [2, '10:00'], [6, '10:00']]) await plan(ANN, showing(at(d, t)), [ANN]);
  // Friday 5:30am next week is still this A-List week
  await assert.rejects(plan(ANN, showing(at(7, '05:30'), 20), [ANN]), /already has 4 movies/);
  await assert.rejects(plan(ANN, showing(at(3, '18:00')), [ANN]), /already has 4 movies/);
  // 6:00am Friday is a new week
  await plan(ANN, showing(at(7, '06:00'), 60), [ANN]);
  // cancelling frees the admission
  const { rows } = await db.query(`select o.id from amc.outings o join amc.attendees a on a.outing_id = o.id
    where a.user_id = $1 and o.starts_at = $2`, [ANN, at(0, '10:00')]);
  await as(ANN, `update amc.attendees set status = 'cancelled' where outing_id = $1 and user_id = $2`, [rows[0].id, ANN]);
  await plan(ANN, showing(at(3, '18:00')), [ANN]);
});

test('no more than 4 reservations held at once, across weeks', async () => {
  for (let w = 0; w < 4; w++) await plan(BOB, showing(at(14 + w * 7, '20:00')), [BOB], 'reserved');
  await assert.rejects(plan(BOB, showing(at(14 + 4 * 7, '20:00')), [BOB], 'reserved'), /4 upcoming reservations/);
  // planning beyond it is allowed, but marking it reserved is not
  const id = await plan(BOB, showing(at(14 + 5 * 7, '20:00')), [BOB], 'planned');
  await assert.rejects(as(BOB, `update amc.attendees set status = 'reserved' where outing_id = $1`, [id]), /4 upcoming reservations/);
});

test('overlapping showtimes are refused; back to back is fine', async () => {
  await plan(BOB, showing(at(15, '13:00'), 120), [BOB]);
  await assert.rejects(plan(BOB, showing(at(15, '14:30'), 90), [BOB]), /two showings at once/);
  await plan(BOB, showing(at(15, '15:00'), 90), [BOB]);
});

test('one call plans for both, or for neither', async () => {
  // Ann already has 4 in week 0 (+3 after the cancel); fill her week 1 so a joint plan fails for her
  const week1 = [[7, '12:00'], [8, '12:00'], [9, '12:00']];
  for (const [d, t] of week1) await plan(ANN, showing(at(d, t)), [ANN]);
  const before = (await db.query('select count(*)::int as c from amc.attendees')).rows[0].c;
  await assert.rejects(plan(BOB, showing(at(10, '19:00')), [ANN, BOB]), /Ann already has 4/);
  assert.equal((await db.query('select count(*)::int as c from amc.attendees')).rows[0].c, before);
  // the same showtime planned twice joins the existing outing
  const s = showing(at(11, '19:00'));
  const id1 = await plan(BOB, s, [BOB]);
  const id2 = await plan(BOB, s, [BOB]);
  assert.equal(id1, id2);
});

test('members can plan for each other but only for members, and wants are your own', async () => {
  const id = await plan(BOB, showing(at(16, '10:00')), [BOB]);
  await assert.rejects(as(BOB, 'insert into amc.attendees (outing_id, user_id) values ($1, $2)', [id, EVE]), /Only members/);
  await as(ANN, 'insert into amc.wants (movie_id, movie_name) values (1, $1)', ['Dune']);
  await assert.rejects(as(BOB, 'insert into amc.wants (user_id, movie_id, movie_name) values ($1, 2, $2)', [ANN, 'X']), /row-level security/);
  assert.equal((await as(BOB, 'select * from amc.wants')).rows.length, 1);
  assert.equal((await as(EVE, 'select * from amc.outings')).rows.length, 0);
});

test('JS rule check agrees with the database', () => {
  const adm = [0, 1, 2].map((i) => ({ outing_id: `o${i}`, status: 'planned', starts_at: at(i, '10:00'), ends_at: at(i, '12:00'), tz: TZ }));
  assert.equal(canAttend(adm, { starts_at: at(3, '10:00'), ends_at: at(3, '12:00'), tz: TZ }).ok, true);
  adm.push({ outing_id: 'o3', status: 'reserved', starts_at: at(3, '10:00'), ends_at: at(3, '12:00'), tz: TZ });
  const r = canAttend(adm, { starts_at: at(4, '10:00'), ends_at: at(4, '12:00'), tz: TZ });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /4 movies/);
  assert.match(canAttend(adm, { starts_at: at(3, '11:00'), ends_at: at(3, '13:00'), tz: TZ }).problems.join(), /Overlaps/);
  assert.equal(standing(adm, Date.parse(at(0, '09:00')), TZ).usedThisWeek, 4);
});

// ---- scraped showtimes ------------------------------------------------------------------------

const ingest = async (payload) => {
  await db.exec('set role service_role');
  try { return (await db.query('select amc.ingest($1::jsonb) as r', [JSON.stringify(payload)])).rows[0].r; }
  finally { await db.exec('reset role'); }
};
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const st = (id, d, extra = {}) => ({ id, movie_id: 72478, show_date: d, starts_at: `${d}T23:00:00Z`, format: 'Dolby Cinema at AMC', format_code: 'dolbycinemaatamcprime', tags: ['Reserved Seating'], status: 'Sellable', alist_excluded: false, ...extra });
const movie = { id: 72478, slug: 'disney-s-hexed-72478', name: "Disney's Hexed", rating: 'PG', run_time: 109, poster_url: 'https://example.com/p.jpg' };

test('ingest stores showtimes and drops ones AMC no longer lists, only for the days it looked at', async () => {
  const d1 = day(2), d2 = day(3);
  const r1 = await ingest({ started_at: new Date().toISOString(), ok: true, pages: 2, theatres: [
    { slug: 'amc-columbia-14', days: [d1, d2], movies: [movie], showtimes: [st(1, d1), st(2, d1), st(3, d2, { alist_excluded: true, tags: ['Excluded from A-List'] })] },
    { slug: 'not-a-theatre-we-track', days: [d1], movies: [movie], showtimes: [st(99, d1)] },
  ] });
  assert.equal(r1.showtimes, 3);
  // next run only looks at d1, where showtime 2 is gone; d2 is left alone
  const r2 = await ingest({ started_at: new Date().toISOString(), ok: true, pages: 1, theatres: [
    { slug: 'amc-columbia-14', days: [d1], movies: [movie], showtimes: [st(1, d1, { status: 'Soldout' })] },
  ] });
  assert.equal(r2.pruned, 1);
  const rows = (await as(ANN, 'select id, status, alist_excluded, theatre_id from amc.showtimes order by id')).rows;
  assert.deepEqual(rows.map((r) => [Number(r.id), r.status, r.alist_excluded, r.theatre_id]), [[1, 'Soldout', false, 349], [3, 'Sellable', true, 349]]);
  const runs = (await as(ANN, 'select ok, showtimes from amc.scrape_runs order by id')).rows;
  assert.deepEqual(runs.map((r) => [r.ok, r.showtimes]), [[true, 3], [true, 1]]);
  const t = (await as(ANN, "select last_scraped_at from amc.theatres where id = 349")).rows[0];
  assert.ok(t.last_scraped_at);
});

test('members read scraped data but cannot write it; others see nothing; ingest is service-only', async () => {
  assert.ok((await as(ANN, 'select * from amc.movies')).rows.length >= 1);
  assert.equal((await as(EVE, 'select * from amc.showtimes')).rows.length, 0);
  assert.equal((await as(EVE, 'select * from amc.scrape_runs')).rows.length, 0);
  await assert.rejects(as(ANN, "insert into amc.movies (id, slug, name) values (1, 'x-1', 'X')"), /permission denied/);
  await assert.rejects(as(ANN, 'delete from amc.showtimes'), /permission denied/);
  await assert.rejects(as(ANN, `select amc.ingest('{}'::jsonb)`), /permission denied/);
  // members can switch a theatre on or off for the scraper
  await as(ANN, 'update amc.theatres set scrape = true where id = 366');
  assert.equal((await as(BOB, 'select scrape from amc.theatres where id = 366')).rows[0].scrape, true);
});


// ---- planning by day ---------------------------------------------------------------------------

const dayOf = (offsetDays) => new Date(Date.parse(`${base}T12:00:00Z`) + offsetDays * 864e5).toISOString().slice(0, 10);

test('a showing can be just a movie on a day: it counts toward that A-List week but never overlaps', async () => {
  const fri = dayOf(70); // a quiet week far from the other tests
  const dayOnly = (name, d = fri) => ({ movie_name: name, theatre_name: 'AMC Test 12', theatre_id: 349, show_date: d, tz: TZ });
  const a = await plan(BOB, dayOnly('Day One'), [BOB]);
  const again = await plan(ANN, dayOnly('Day One'), [ANN]); // same movie, same day, no time: one shared showing
  assert.equal(again, a);
  const row = (await as(BOB, 'select show_date::text d, starts_at, ends_at from amc.outings where id = $1', [a])).rows[0];
  assert.deepEqual([row.d, row.starts_at, row.ends_at], [fri, null, null]);
  // two more the same day (no times, so no overlap) and one on Thursday make 4 for Bob that week
  await plan(BOB, dayOnly('Day Two'), [BOB]);
  await plan(BOB, dayOnly('Day Three'), [BOB]);
  await plan(BOB, dayOnly('Day Four', dayOf(76)), [BOB]);
  await assert.rejects(plan(BOB, dayOnly('Day Five', dayOf(75)), [BOB]), /4 movies in the A-List week/);
  // the next Friday is a new week
  await plan(BOB, dayOnly('Day Five', dayOf(77)), [BOB]);
  // giving it a time later keeps its day and fills in a length
  await as(BOB, 'update amc.outings set starts_at = $2 where id = $1', [a, wallToUtc(fri, '19:00', TZ).toISOString()]);
  const timed = (await as(BOB, 'select show_date::text d, ends_at - starts_at as len from amc.outings where id = $1', [a])).rows[0];
  assert.equal(timed.d, fri);
  assert.ok(String(JSON.stringify(timed.len)).includes('150') || String(JSON.stringify(timed.len)).includes('2'));
  // a timed showing gets its day from its time (a 1 AM show belongs to the day before)
  const late = await plan(ANN, { movie_name: 'Late Show', theatre_name: 'AMC Test 12', tz: TZ, starts_at: wallToUtc(dayOf(71), '01:00', TZ).toISOString() }, [ANN]);
  assert.equal((await as(ANN, 'select show_date::text d from amc.outings where id = $1', [late])).rows[0].d, fri);
});

test('JS rules count a showing without a time by its day', () => {
  const fri = dayOf(84);
  const adm = [0, 1, 2].map((i) => ({ outing_id: `d${i}`, status: 'planned', show_date: fri, starts_at: null, ends_at: null, tz: TZ }));
  assert.equal(canAttend(adm, { show_date: fri, tz: TZ }).ok, true); // same day, no times: no overlap
  adm.push({ outing_id: 'd3', status: 'planned', show_date: dayOf(90), starts_at: null, ends_at: null, tz: TZ });
  assert.match(canAttend(adm, { show_date: dayOf(85), tz: TZ }).problems.join(), /Already has 4/);
  assert.equal(canAttend(adm, { show_date: dayOf(91), tz: TZ }).ok, true);
});

test('the scraper is told which planned days to read, and ingest records the days it read', async () => {
  const want = day(5), other = day(6);
  const planned = await plan(ANN, { movie_name: 'Wanted Movie', theatre_name: 'AMC Columbia 14', theatre_id: 349, show_date: want, tz: TZ }, [ANN]);
  await db.exec('set role service_role');
  const wants = async () => (await db.query('select theatre_id, day::text d from amc.scrape_wants()')).rows;
  try {
    assert.ok((await wants()).some((r) => r.theatre_id === 349 && r.d === want));
  } finally { await db.exec('reset role'); }
  await ingest({ started_at: new Date().toISOString(), ok: true, pages: 1, theatres: [{ slug: 'amc-columbia-14', days: [want, other], movies: [movie], showtimes: [st(501, want)] }] });
  const read = (await as(ANN, 'select show_date::text d, showtimes from amc.days_read where theatre_id = 349 and show_date in ($1, $2) order by 1', [want, other])).rows;
  assert.deepEqual(read.map((r) => [r.d, r.showtimes]), [[want, 1], [other, 0]]);
  await db.exec('set role service_role');
  try {
    assert.ok(!(await wants()).some((r) => r.theatre_id === 349 && r.d === want), 'a day just read is not asked for again');
  } finally { await db.exec('reset role'); }
  await assert.rejects(as(ANN, 'select * from amc.scrape_wants()'), /permission denied/);
  assert.equal((await as(EVE, 'select * from amc.days_read')).rows.length, 0);
  await as(ANN, 'delete from amc.outings where id = $1', [planned]);
  assert.equal((await db.query("select to_regclass('amc.picks') as t")).rows[0].t, null, 'pencil marks are gone');
});

test('ingest stores release dates from the movies page without needing a theatre', async () => {
  const r = await ingest({ started_at: new Date().toISOString(), ok: true, pages: 1, theatres: [], releases: [
    { id: 77032, slug: 'dune-part-three-77032', name: 'Dune: Part Three', rating: null, run_time: 150, poster_url: 'https://example.com/d.jpg', release_date: '2026-12-18', status: 'opening', kind: 'film' },
    { id: 84722, slug: 'avengers-doomsday-reald-3d-fan-event-84722', name: 'Avengers: Doomsday RealD 3D Fan Event', run_time: 151, release_date: '2026-12-20', status: 'opening', kind: 'event' },
    { id: 72478, slug: 'disney-s-hexed-72478', name: "Disney's Hexed", release_date: '2026-11-06', status: 'released', kind: 'nonsense' },
    { id: 1, slug: 'bad-poster-1', name: 'Bad', poster_url: 'http://insecure/x.jpg' },
  ] });
  assert.equal(r.releases, 3);
  const rows = (await as(ANN, "select id, release_date::text d, release_status s, release_kind k, rating, run_time, listed_at is not null as listed from amc.movies where id in (77032, 84722, 72478, 1) order by id")).rows;
  assert.deepEqual(rows.map((x) => [x.id, x.d, x.s, x.k]), [[72478, '2026-11-06', 'released', 'film'], [77032, '2026-12-18', 'opening', 'film'], [84722, '2026-12-20', 'opening', 'event']]);
  // what the showtimes pages knew (rating, runtime) is kept when the movies page doesn't say
  assert.equal(rows.find((x) => x.id === 72478).rating, 'PG');
  assert.ok(rows.every((x) => x.listed));
});
