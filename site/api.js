// Everything the pages ask for, all from the `amc` schema. The group's plans: supabase/migrations/20261110000000_amc.sql.
// Movies and showtimes are read off amctheatres.com by the scraper (scraper/) and stored by the amc-ingest function:
// supabase/migrations/20261125000000_amc_scrape.sql. Members only read those.
import { supabase } from './session.js';

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

/** Showtimes from today on, optionally for one theatre, movie and/or date. */
export async function showtimes({ theatre, movie: movieId, date } = {}) {
  let q = db.from('showtimes').select('*').gte('show_date', today());
  if (theatre != null) q = q.eq('theatre_id', theatre);
  if (movieId != null) q = q.eq('movie_id', movieId);
  if (date) q = q.eq('show_date', date);
  const [rows, ms] = await Promise.all([q.order('starts_at'), movieMap()]);
  return ok(rows).map((r) => toShowtime(r, ms.get(r.movie_id)));
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
