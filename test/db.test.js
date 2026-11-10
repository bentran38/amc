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
  await assert.rejects(as(ANN, 'select * from amc.api_cache'), /permission denied/);
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
