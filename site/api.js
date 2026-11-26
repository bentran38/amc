// Everything the pages ask for, all from the `amc` schema. The group's plans: supabase/migrations/20261110000000_amc.sql.
// Movies and showtimes are read off amctheatres.com by the scraper (scraper/) and stored by the amc-ingest function:
// supabase/migrations/20261125000000_amc_scrape.sql. Members only read those.
import { supabase } from './session.js';
import { wallToUtc } from './rules.js';

const db = supabase.schema('amc');

const ok = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};

// ---- the group ------------------------------------------------------------------------------

let membersCache;
/** Everyone in the entourage (everyone with access): { user_id, handle, display_name }. */
export async function members() {
  membersCache ??= ok(await db.rpc('members'));
  return membersCache;
}

// ---- plans ----------------------------------------------------------------------------------

/** Every outing with who is going, oldest first. */
export const outings = async () =>
  ok(await db.from('outings').select('*, attendees(*)').order('starts_at'));

/** Plan a showing for some people in one go (rules are checked by the database). */
export const planShowing = async (outing, people, status = 'planned') =>
  ok(await db.rpc('plan_showing', { p_outing: outing, p_people: people, p_status: status }));

export const setAttendee = async (outingId, userId, changes) =>
  ok(await db.from('attendees').update(changes).eq('outing_id', outingId).eq('user_id', userId));

/** Take someone off a showing; the showing goes too once nobody is left. */
export async function removeAttendee(outingId, userId) {
  ok(await db.from('attendees').delete().eq('outing_id', outingId).eq('user_id', userId));
  const left = ok(await db.from('attendees').select('user_id').eq('outing_id', outingId));
  if (!left.length) ok(await db.from('outings').delete().eq('id', outingId));
}

export const deleteOuting = async (id) => ok(await db.from('outings').delete().eq('id', id));

/**
 * Give a showing a time ('19:30', on its own day; after midnight counts as that night) or take it away (''). Its
 * length comes from what it had, else the movie's runtime, else 2.5 hours. Everyone going is re-checked.
 */
export async function setShowingTime(o, hhmm) {
  if (!hhmm) return ok(await db.from('outings').update({ starts_at: null, ends_at: null }).eq('id', o.id));
  const day = hhmm < '05:00' ? new Date(Date.parse(`${o.show_date}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) : o.show_date;
  const start = wallToUtc(day, hhmm, o.tz);
  const run = o.starts_at && o.ends_at ? Date.parse(o.ends_at) - Date.parse(o.starts_at)
    : ((o.movie_id != null && (await movie(o.movie_id))?.runTime) || 150) * 60e3;
  return ok(await db.from('outings').update({ starts_at: start.toISOString(), ends_at: new Date(start.getTime() + run).toISOString() }).eq('id', o.id));
}

// ---- theatres ------------------------------------------------------------------------------------

export const theatres = async () => ok(await db.from('theatres').select('*').order('name'));
/** Switch the scraper on or off for a theatre. */
export const setScrape = async (id, on) => ok(await db.from('theatres').update({ scrape: on }).eq('id', id));

// ---- wants ----------------------------------------------------------------------------------

export const wants = async () => ok(await db.from('wants').select('*').order('created_at'));
export const want = async (m) =>
  ok(await db.from('wants').upsert({
    movie_id: m.id, movie_name: m.name, movie_slug: m.slug, poster_url: m.poster,
    release_date: m.release ? m.release.slice(0, 10) : null,
  }));
export const unwant = async (userId, movieId) =>
  ok(await db.from('wants').delete().eq('user_id', userId).eq('movie_id', movieId));

// ---- scraped movies and showtimes ---------------------------------------------------------------

const AMC = 'https://www.amctheatres.com';
const toMovie = (r) => ({
  id: r.id, slug: r.slug, name: r.name, rating: r.rating, runTime: r.run_time, poster: r.poster_url,
  url: `${AMC}/movies/${r.slug}`, firstSeen: r.first_seen,
  release: r.release_date ?? null, releaseStatus: r.release_status ?? null, kind: r.release_kind ?? 'film', listedAt: r.listed_at ?? null,
});

let moviesCache;
/** Every movie the scraper has seen, by id. */
async function movieMap() {
  moviesCache ??= ok(await db.from('movies').select('*').order('name')).map(toMovie);
  return new Map(moviesCache.map((m) => [m.id, m]));
}
export const movies = async () => [...(await movieMap()).values()];
export const movie = async (id) => (await movieMap()).get(id) ?? null;

const toShowtime = (r, m) => ({
  id: Number(r.id), theatreId: r.theatre_id, movieId: r.movie_id, movieName: m?.name ?? 'Movie', movieSlug: m?.slug ?? null,
  rating: m?.rating ?? null, runTime: m?.runTime ?? null, utc: r.starts_at, date: r.show_date,
  format: r.format, tags: r.tags ?? [], soldOut: r.status === 'Soldout', almostSoldOut: false,
  alistExcluded: r.alist_excluded, auditorium: null, purchaseUrl: `${AMC}/showtimes/${r.id}/seats`, seenAt: r.seen_at,
});

let allCache;
/** Every stored showtime from today on (all theatres), remembered for a minute so moving between pages is instant. */
async function allShowtimes() {
  if (allCache && Date.now() - allCache.at < 60e3) return allCache.rows;
  const rows = [];
  for (let from = 0; ; from += 1000) { // PostgREST hands out at most 1000 rows per request
    const page = ok(await db.from('showtimes').select('*').gte('show_date', today()).order('starts_at').order('id').range(from, from + 999));
    rows.push(...page);
    if (page.length < 1000) break;
  }
  const ms = await movieMap();
  allCache = { at: Date.now(), rows: rows.map((r) => toShowtime(r, ms.get(r.movie_id))) };
  return allCache.rows;
}

/** Showtimes from today on, optionally for one theatre, movie and/or date. */
export async function showtimes({ theatre, movie: movieId, date } = {}) {
  return (await allShowtimes()).filter((s) =>
    (theatre == null || s.theatreId === theatre) && (movieId == null || s.movieId === movieId) && (!date || s.date === date));
}

/** For each day the scraper has read: { count, checked } (count = showtimes stored; a day can be read and empty). */
export async function days() {
  const [read, shows] = await Promise.all([db.from('days_read').select('*').then(ok), allShowtimes()]);
  const out = new Map();
  for (const r of read) {
    const d = out.get(r.show_date);
    if (!d || r.read_at > d.checked) out.set(r.show_date, { count: 0, checked: r.read_at });
  }
  for (const s of shows) {
    const d = out.get(s.date) ?? { count: 0, checked: s.seenAt };
    d.count++;
    out.set(s.date, d);
  }
  return out;
}

/** The latest scraper run, and the latest one that worked. */
export async function freshness() {
  const runs = ok(await db.from('scrape_runs').select('*').order('finished_at', { ascending: false }).limit(20));
  return { last: runs[0] ?? null, lastOk: runs.find((r) => r.ok) ?? null };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
