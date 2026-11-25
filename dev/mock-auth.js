// Stand-in for https://www.durpeesquid.com/auth.js, used only by `npm run dev:mock` (dev/serve.js maps
// the real URL to this file). It fakes a signed-in user and an in-memory copy of the amc schema, with made-up
// scraped movies and today's showtimes at Columbia 14, so every page can be tried locally without Supabase.
// Add ?noruns to the URL to see the "no showtimes yet" state.
// The real rules live in the migration; this uses the JS copy in site/rules.js.
import { canAttend, localTz } from '/rules.js';

export const HOME = location.origin;
export const requireLogin = async () => ({ user: { id: 'me', email: 'you@example.com' } });
export const hasAccess = async () => true;
export const signOut = () => alert('Mock sign out');
export const loadProfile = async () => ({ handle: 'you', display_name: 'You', theme: 'midnight' });

const DAY = 864e5, now = Date.now(), TZ = localTz();
let seed = 11;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// ---- fake scraped data ------------------------------------------------------------------------

const TITLES = [
  ['Starfall Protocol', 'PG-13', 148], ['The Quiet Orchard', 'PG', 112], ['Neon Harbor', 'R', 126],
  ['Paper Moons', 'PG', 98], ['Glass Kingdom', 'PG-13', 162], ['Low Tide', 'R', 104],
  ['The Last Commute', 'PG-13', 119], ['Iron Meridian', 'PG-13', 141], ['Echoes of Juno', 'PG-13', 155], ['Hollow Pines', 'R', 101],
];
const slugify = (name, id) => `${name.toLowerCase().replace(/\W+/g, '-')}-${id}`;
const MOVIES = TITLES.map(([name, rating, run_time], i) => ({
  id: 70000 + i, slug: slugify(name, 70000 + i), name, rating, run_time, poster_url: null,
  first_seen: new Date(now - (20 - i) * DAY).toISOString(), updated_at: new Date().toISOString(),
}));
const THEATRES = [
  { id: 349, name: 'AMC Columbia 14', slug: 'amc-columbia-14', market: 'baltimore', city: 'Columbia', state: 'MD', tz: 'America/New_York', scrape: true, last_scraped_at: new Date(now - 2 * 36e5).toISOString() },
  { id: 366, name: 'AMC Tysons Corner 16', slug: 'amc-tysons-corner-16', market: 'washington-d-c', city: 'McLean', state: 'VA', tz: 'America/New_York', scrape: false, last_scraped_at: null },
];
const FORMATS = [['Dolby Cinema at AMC Prime', 'dolbycinemaatamcprime', ['Reserved Seating', 'Recliner Seating']],
  ['IMAX with Laser at AMC', 'imaxwithlaseratamc', ['Reserved Seating']], ['Laser at AMC', 'laseratamc', ['Reserved Seating', 'Closed Caption']],
  ['RealD 3D', 'reald3d', ['Reserved Seating', 'Excluded from A-List']]];
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

// Columbia 14, today and the next ten days, as the rotating scraper would leave it: a few days not read yet
// (days 4 and 9), and the last two movies never showing ("Seen earlier"). Echoes of Juno opens on day 3.
const dayPlus = (n) => { const d = new Date(now + n * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const SHOWTIMES = [];
for (const n of [0, 1, 2, 3, 5, 6, 7, 8, 10]) {
  const day = dayPlus(n);
  const showing = MOVIES.slice(0, 8).filter((_, mi) => (mi + n) % 5 !== 0).concat(n >= 3 ? [MOVIES[8]] : []);
  showing.forEach((m, mi) => {
    const fmts = [FORMATS[2], FORMATS[mi % 4 === 1 ? 0 : mi % 4 === 3 ? 3 : 1]];
    fmts.forEach(([format, code, tags], fi) => {
      for (const hour of [12.25, 15.5, 18.75, 21.5].slice(fi, fi + 3 - (n % 2))) {
        const id = 140000000 + n * 10000 + (m.id % 100) * 100 + fi * 10 + Math.round(hour);
        SHOWTIMES.push({
          id, theatre_id: 349, movie_id: m.id, show_date: day,
          starts_at: new Date(`${day}T${String(Math.floor(hour)).padStart(2, '0')}:${String((hour % 1) * 60).padStart(2, '0')}:00`).toISOString(),
          format, format_code: code, tags, status: id % 7 === 0 ? 'Soldout' : 'Sellable', alist_excluded: tags.includes('Excluded from A-List'),
          seen_at: new Date(now - (n === 0 ? 2 : 8 + n * 3) * 36e5).toISOString(),
        });
      }
    });
  });
}
const RUNS = new URLSearchParams(location.search).has('noruns') ? [] : [
  { id: 2, started_at: new Date(now - 2 * 36e5 - 60e3).toISOString(), finished_at: new Date(now - 2 * 36e5).toISOString(), ok: true, pages: 1, showtimes: SHOWTIMES.length, error: null, runner: 'local' },
];

// ---- fake amc schema ----------------------------------------------------------------------------

const people = [
  { user_id: 'me', handle: 'you', display_name: 'You' },
  { user_id: 'sam', handle: 'sam', display_name: 'Sam' },
];
const tables = {
  theatres: THEATRES.map((t) => ({ ...t })),
  movies: MOVIES,
  showtimes: SHOWTIMES,
  scrape_runs: RUNS,
  outings: [],
  attendees: [],
  wants: [
    { user_id: 'me', movie_id: MOVIES[8].id, movie_name: MOVIES[8].name, movie_slug: MOVIES[8].slug, poster_url: null, release_date: null, created_at: '1' },
    { user_id: 'sam', movie_id: MOVIES[8].id, movie_name: MOVIES[8].name, movie_slug: MOVIES[8].slug, poster_url: null, release_date: null, created_at: '2' },
    { user_id: 'sam', movie_id: MOVIES[4].id, movie_name: MOVIES[4].name, movie_slug: MOVIES[4].slug, poster_url: null, release_date: null, created_at: '3' },
  ],
};
let uid = 0;
function addOuting(m, theatre, startMs, who) {
  const id = `o${++uid}`;
  tables.outings.push({
    id, showtime_id: 90000 + uid, movie_id: m.id, movie_name: m.name, movie_slug: m.slug, poster_url: null,
    theatre_id: theatre.id, theatre_name: theatre.name, auditorium: null, format: uid % 2 ? 'IMAX with Laser at AMC' : 'Laser at AMC',
    starts_at: new Date(startMs).toISOString(), ends_at: new Date(startMs + m.run_time * 60e3).toISOString(), tz: theatre.tz,
    purchase_url: `https://www.amctheatres.com/showtimes/${90000 + uid}/seats`, note: null, created_at: new Date().toISOString(),
  });
  for (const [user_id, status, seat] of who) tables.attendees.push({ outing_id: id, user_id, status, seat: seat ?? null, updated_at: '' });
}
{
  const at = (days, hour) => { const d = new Date(now + days * DAY); d.setHours(hour, 30, 0, 0); return d.getTime(); };
  addOuting(MOVIES[0], THEATRES[0], at(-2, 19), [['me', 'reserved', 'H12'], ['sam', 'reserved', 'H13']]);
  addOuting(MOVIES[2], THEATRES[0], at(1, 20), [['me', 'reserved'], ['sam', 'planned']]);
  addOuting(MOVIES[3], THEATRES[1], at(2, 14), [['sam', 'planned']]);
  addOuting(MOVIES[5], THEATRES[0], at(8, 21), [['me', 'planned']]);
  addOuting(MOVIES[1], THEATRES[0], at(-9, 18), [['me', 'reserved'], ['sam', 'reserved']]);
}

const admissionsOf = (user) => tables.attendees.filter((a) => a.user_id === user).map((a) => {
  const o = tables.outings.find((x) => x.id === a.outing_id);
  return { ...a, starts_at: o.starts_at, ends_at: o.ends_at, tz: o.tz, movie_name: o.movie_name };
});
const err = (message) => ({ data: null, error: { message } });
function checkPerson(user, outing, status, ignoreOuting) {
  const name = people.find((p) => p.user_id === user)?.display_name ?? 'Someone';
  const c = canAttend(admissionsOf(user).filter((a) => a.outing_id !== ignoreOuting), outing, status);
  if (!c.ok) return `${name}: ${c.problems[0]}`;
  return null;
}

class Query {
  constructor(table) { this.table = table; this.filters = []; this.sorts = []; this.op = 'select'; }
  select(cols = '*') { if (this.op === 'select') this.cols = cols; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  order(c, { ascending = true } = {}) { this.sorts.push([c, ascending]); return this; }
  limit(n) { this.max = n; return this; }
  range(a, b) { this.from = a; this.max = b - a + 1; return this; }
  maybeSingle() { this.single = true; return this; }
  insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); return this; }
  upsert(rows) { this.op = 'upsert'; this.rows = [].concat(rows); return this; }
  update(changes) { this.op = 'update'; this.changes = changes; return this; }
  delete() { this.op = 'delete'; return this; }
  then(res, rej) { return new Promise((r) => setTimeout(r, 60)).then(() => this.run()).then(res, rej); }

  run() {
    const t = tables[this.table];
    const match = (r) => this.filters.every((f) => f(r));
    if (this.op === 'select') {
      let rows = t.filter(match).map((r) => (this.table === 'outings' && /attendees/.test(this.cols ?? '') ? { ...r, attendees: tables.attendees.filter((a) => a.outing_id === r.id) } : { ...r }));
      for (const [c, asc] of [...this.sorts].reverse()) rows.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      if (this.max) rows = rows.slice(this.from ?? 0, (this.from ?? 0) + this.max);
      return { data: this.single ? rows[0] ?? null : rows, error: null };
    }
    if (this.op === 'upsert' || this.op === 'insert') {
      for (const row of this.rows) {
        const r = this.table === 'wants' ? { user_id: 'me', created_at: new Date().toISOString(), ...row } : row;
        const key = this.table === 'wants' ? (x) => x.user_id === r.user_id && x.movie_id === r.movie_id : (x) => x.id === r.id;
        const old = t.find(key);
        if (old) Object.assign(old, r); else t.push(r);
      }
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      for (const r of t.filter(match)) {
        if (this.table === 'attendees' && this.changes.status && this.changes.status !== 'cancelled') {
          const o = tables.outings.find((x) => x.id === r.outing_id);
          const problem = checkPerson(r.user_id, { ...o }, this.changes.status, r.outing_id);
          if (problem) return err(problem);
        }
        Object.assign(r, this.changes);
      }
      return { data: null, error: null };
    }
    for (let i = t.length - 1; i >= 0; i--) if (match(t[i])) t.splice(i, 1);
    if (this.table === 'outings') tables.attendees = tables.attendees.filter((a) => tables.outings.some((o) => o.id === a.outing_id));
    return { data: null, error: null };
  }
}

async function rpc(name, a) {
  await new Promise((r) => setTimeout(r, 80));
  if (name === 'members') return { data: people, error: null };
  if (name !== 'plan_showing') return err('Unknown function');
  const o = a.p_outing;
  let outing = o.id ? tables.outings.find((x) => x.id === o.id) : o.showtime_id ? tables.outings.find((x) => x.showtime_id === o.showtime_id) : null;
  const shape = outing ?? { ...o, ends_at: o.ends_at ?? new Date(Date.parse(o.starts_at) + 150 * 60e3).toISOString() };
  for (const u of a.p_people) {
    const problem = checkPerson(u, shape, a.p_status, outing?.id);
    if (problem) return err(problem);
  }
  if (!outing) {
    outing = { ...shape, id: `o${++uid}`, tz: shape.tz || 'America/New_York', created_at: new Date().toISOString() };
    tables.outings.push(outing);
  }
  for (const u of a.p_people) {
    const old = tables.attendees.find((x) => x.outing_id === outing.id && x.user_id === u);
    if (old) old.status = a.p_status; else tables.attendees.push({ outing_id: outing.id, user_id: u, status: a.p_status, seat: null });
  }
  return { data: outing.id, error: null };
}

const from = (table) => new Query(table);
export const supabase = { from, schema: () => ({ from, rpc }) };
