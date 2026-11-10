// Stand-in for https://www.durpeesquid.com/auth.js, used only by `npm run dev:mock` (dev/serve.js maps
// the real URL to this file). It fakes a signed-in user, an in-memory copy of the amc schema and the
// amc-api Edge Function (made-up movies, showtimes and seats), so every page can be tried locally
// without Supabase or an AMC key. Add ?nokey to the URL to see the "AMC key not set up" state.
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

// ---- fake AMC ---------------------------------------------------------------------------------

const TITLES = [
  ['Starfall Protocol', 'PG-13', 148, 'Action'], ['The Quiet Orchard', 'PG', 112, 'Drama'], ['Neon Harbor', 'R', 126, 'Thriller'],
  ['Paper Moons', 'PG', 98, 'Animation'], ['Glass Kingdom', 'PG-13', 162, 'Fantasy'], ['Low Tide', 'R', 104, 'Horror'],
  ['The Last Commute', 'PG-13', 119, 'Comedy'], ['Iron Meridian', 'PG-13', 141, 'Sci-Fi'],
];
const UPCOMING = [['Echoes of Juno', 'PG-13', 155, 'Sci-Fi', 9], ['Hollow Pines', 'R', 101, 'Horror', 16], ['Kite Season', 'PG', 95, 'Family', 23], ['The Cartographer', 'PG-13', 133, 'Adventure', 30]];
const mk = (id, [name, rating, runTime, genre], releaseDays) => ({
  id, name, slug: name.toLowerCase().replace(/\W+/g, '-'), poster: null, rating, runTime, genre,
  release: new Date(now + releaseDays * DAY).toISOString(), hasShowtimes: releaseDays <= 9,
  synopsis: `${name} is a made-up movie for trying the planner locally.`, formats: [], url: 'https://www.amctheatres.com',
});
const NOW = TITLES.map((t, i) => mk(1000 + i, t, -3 - i * 6));
const SOON = UPCOMING.map((t, i) => mk(2000 + i, t, t[4]));
const MOVIES = { 'now-playing': NOW, advance: SOON.slice(0, 2), 'coming-soon': SOON };
const THEATRES = [
  { id: 610, name: 'AMC Lincoln Square 13', slug: 'amc-lincoln-square-13', city: 'New York', state: 'NY', tz: 'America/New_York', address: '1998 Broadway' },
  { id: 2325, name: 'AMC 34th Street 14', slug: 'amc-34th-street-14', city: 'New York', state: 'NY', tz: 'America/New_York', address: '312 W 34th St' },
  { id: 4001, name: 'AMC Empire 25', slug: 'amc-empire-25', city: 'New York', state: 'NY', tz: 'America/New_York', address: '234 W 42nd St' },
  { id: 515, name: 'AMC River East 21', slug: 'amc-river-east-21', city: 'Chicago', state: 'IL', tz: 'America/Chicago', address: '322 E Illinois St' },
];
const FORMATS = ['IMAX with Laser', 'Dolby Cinema', 'Standard', 'Standard', 'PRIME', 'RealD 3D'];

function showtimesFor(theatre, date) {
  const t = THEATRES.find((x) => x.id === theatre) ?? { tz: 'America/New_York' };
  const list = [];
  for (const m of [...NOW, ...SOON.slice(0, 1)]) {
    if (Date.parse(m.release) > Date.parse(`${date}T23:59:00`)) continue;
    const fmts = [FORMATS[(m.id + theatre) % FORMATS.length], 'Standard'];
    fmts.forEach((format, fi) => {
      for (const hour of [11.5, 14.75, 18, 21.25].slice(fi, fi + 3)) {
        const id = Number(`${theatre}${date.replace(/-/g, '').slice(4)}${m.id % 100}${fi}${Math.round(hour * 4)}`);
        const local = `${date}T${String(Math.floor(hour)).padStart(2, '0')}:${String((hour % 1) * 60).padStart(2, '0')}:00`;
        const r = (id % 97) / 97;
        list.push({
          id, movieId: m.id, movieName: m.name, movieSlug: m.slug, utc: new Date(local).toISOString(), local, runTime: m.runTime, rating: m.rating,
          theatreId: theatre, auditorium: 1 + (id % 13), format, tags: [format, 'Reserved Seating', 'Closed Caption'],
          soldOut: r > 0.93, almostSoldOut: r > 0.75 && r <= 0.93, canceled: false,
          purchaseUrl: `https://www.amctheatres.com/showtimes/${id}/seats`, tz: t.tz,
        });
      }
    });
  }
  return list;
}

function seatsFor(showtime) {
  let s = showtime % 1000;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const rows = 'ABCDEFGHJKL'.split('').map((name, i) => ({
    name,
    seats: Array.from({ length: i < 2 ? 14 : 20 }, (_, c) => ({
      name: `${name}${c + 1}`, row: name, col: c + 1,
      type: i === 0 && (c < 2 || c > 11) ? 'Wheelchair' : 'Recliner',
      available: r() > (i > 3 && i < 8 ? 0.7 : 0.35),
    })),
  }));
  const all = rows.flatMap((x) => x.seats);
  return { total: all.length, available: all.filter((x) => x.available).length, rows, fetchedAt: new Date().toISOString() };
}

async function invoke(name, { body }) {
  await new Promise((r) => setTimeout(r, 150 + rand() * 250));
  const fail = (status, error, code) => ({ data: null, error: { message: error, context: { json: async () => ({ error, code }) } } });
  if (name !== 'amc-api') return fail(404, 'No such function');
  if (new URLSearchParams(location.search).has('nokey') || sessionStorage.getItem('nokey')) {
    sessionStorage.setItem('nokey', '1');
    return fail(503, 'The AMC API key is not set up yet', 'no_key');
  }
  const ok = (data) => ({ data, error: null });
  switch (body.action) {
    case 'movies': return ok({ movies: MOVIES[body.view] ?? NOW });
    case 'movie': {
      const m = [...NOW, ...SOON].find((x) => x.id === body.id || x.slug === body.id);
      return m ? ok({ movie: m }) : fail(404, 'AMC has nothing for that', 'not_found');
    }
    case 'theatres': return ok({ theatres: THEATRES.filter((t) => (!body.state || t.state === body.state) && (!body.city || t.city.toLowerCase().includes(body.city.toLowerCase())) && (!body.name || t.name.toLowerCase().includes(body.name.toLowerCase()))) });
    case 'showtimes': {
      const list = showtimesFor(body.theatre, body.date);
      return ok({ showtimes: body.movie ? list.filter((s) => s.movieId === body.movie) : list });
    }
    case 'seats': return ok(seatsFor(body.showtime));
    default: return fail(400, 'Unknown action');
  }
}

// ---- fake amc schema ----------------------------------------------------------------------------

const people = [
  { user_id: 'me', handle: 'you', display_name: 'You' },
  { user_id: 'sam', handle: 'sam', display_name: 'Sam' },
];
const tables = {
  theatres: [THEATRES[0], THEATRES[2]].map((t) => ({ ...t })),
  outings: [],
  attendees: [],
  wants: [
    { user_id: 'me', movie_id: 2000, movie_name: SOON[0].name, movie_slug: SOON[0].slug, poster_url: null, release_date: SOON[0].release.slice(0, 10), created_at: '1' },
    { user_id: 'sam', movie_id: 2000, movie_name: SOON[0].name, movie_slug: SOON[0].slug, poster_url: null, release_date: SOON[0].release.slice(0, 10), created_at: '2' },
    { user_id: 'sam', movie_id: 1004, movie_name: NOW[4].name, movie_slug: NOW[4].slug, poster_url: null, release_date: null, created_at: '3' },
  ],
};
let uid = 0;
function addOuting(m, theatre, startMs, who) {
  const id = `o${++uid}`;
  tables.outings.push({
    id, showtime_id: 90000 + uid, movie_id: m.id, movie_name: m.name, movie_slug: m.slug, poster_url: null,
    theatre_id: theatre.id, theatre_name: theatre.name, auditorium: 3 + uid, format: uid % 2 ? 'IMAX with Laser' : 'Standard',
    starts_at: new Date(startMs).toISOString(), ends_at: new Date(startMs + m.runTime * 60e3).toISOString(), tz: theatre.tz,
    purchase_url: `https://www.amctheatres.com/showtimes/${90000 + uid}/seats`, note: null, created_at: new Date().toISOString(),
  });
  for (const [user_id, status, seat] of who) tables.attendees.push({ outing_id: id, user_id, status, seat: seat ?? null, updated_at: '' });
}
{
  const at = (days, hour) => { const d = new Date(now + days * DAY); d.setHours(hour, 30, 0, 0); return d.getTime(); };
  addOuting(NOW[0], THEATRES[0], at(-2, 19), [['me', 'reserved', 'H12'], ['sam', 'reserved', 'H13']]);
  addOuting(NOW[2], THEATRES[2], at(1, 20), [['me', 'reserved'], ['sam', 'planned']]);
  addOuting(NOW[3], THEATRES[0], at(2, 14), [['sam', 'planned']]);
  addOuting(NOW[5], THEATRES[2], at(8, 21), [['me', 'planned']]);
  addOuting(NOW[1], THEATRES[0], at(-9, 18), [['me', 'reserved'], ['sam', 'reserved']]);
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
export const supabase = { from, schema: () => ({ from, rpc }), functions: { invoke } };
