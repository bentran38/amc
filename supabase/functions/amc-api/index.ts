// AMC Theatres API for the A-List planner. Runs server-side so the AMC vendor key never reaches the
// browser, and caches answers in amc.api_cache so the group doesn't hammer AMC.
// verify_jwt is off at the gateway; the checks below verify the caller (signed in + 'amc' access).
//
// Needs the function secret AMC_VENDOR_KEY (a free key from https://developers.amctheatres.com).
// Without it every call answers 503 { error, code: 'no_key' } and the site falls back to planning by hand.
//
//   POST { action: 'movies',    view: 'now-playing' | 'advance' | 'coming-soon' }
//   POST { action: 'movie',     id: number | slug }
//   POST { action: 'theatres',  state?: 'NY', city?: string, name?: string }
//   POST { action: 'showtimes', theatre: number, date: 'YYYY-MM-DD', movie?: number }
//   POST { action: 'seats',     theatre: number, showtime: number }
import { createClient } from 'npm:@supabase/supabase-js@2';

const PROJECT_SLUG = 'amc';
const API = 'https://api.amctheatres.com';
const KEY = Deno.env.get('AMC_VENDOR_KEY') ?? '';
const allowedOrigin = (o: string) =>
  o === 'https://amc.durpeesquid.com' || /^https:\/\/amc-[a-z0-9-]+\.vercel\.app$/.test(o) || /^http:\/\/localhost:\d+$/.test(o);

// how long each kind of answer stays fresh (seconds)
const TTL = { movies: 6 * 3600, movie: 6 * 3600, theatres: 24 * 3600, showtimes: 10 * 60, seats: 45 };

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

async function amc(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-AMC-Vendor-Key': KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  }).catch((e) => {
    throw new HttpError(502, `AMC did not respond (${e?.name === 'TimeoutError' ? 'timed out' : e})`);
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'AMC refused the vendor key (it may not be active yet)', 'bad_key');
  if (res.status === 404) throw new HttpError(404, 'AMC has nothing for that', 'not_found');
  if (!res.ok) throw new HttpError(502, `AMC returned ${res.status}`);
  return res.json();
}

/** Every item of a paged AMC collection (HAL: _embedded[name], count, pageSize). */
async function amcAll(path: string, name: string, max = 600): Promise<any[]> {
  const out: any[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; out.length < max; page++) {
    const j = await amc(`${path}${sep}page-size=100&page-number=${page}`);
    const items = j?._embedded?.[name] ?? [];
    out.push(...items);
    if (!items.length || out.length >= (j.count ?? 0)) break;
  }
  return out;
}

/** Cached fetch: returns the stored answer if it is fresh, else runs `load` and stores it. */
async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ data: T; fetchedAt: string }> {
  const { data: row } = await db.schema('amc').from('api_cache').select('body, fetched_at').eq('key', key).maybeSingle();
  if (row && Date.now() - new Date(row.fetched_at).getTime() < ttl * 1000) return { data: row.body as T, fetchedAt: row.fetched_at };
  try {
    const data = await load();
    const fetchedAt = new Date().toISOString();
    await db.schema('amc').from('api_cache').upsert({ key, body: data, fetched_at: fetchedAt });
    return { data, fetchedAt };
  } catch (e) {
    if (row) return { data: row.body as T, fetchedAt: row.fetched_at }; // stale beats nothing
    throw e;
  }
}

// ---- shaping AMC's answers into what the site needs ----------------------------------------------

const https = (u: unknown) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

function movie(m: any) {
  return {
    id: m.id,
    name: m.name,
    slug: m.slug ?? null,
    poster: https(m.media?.posterDynamic) ?? https(m.media?.posterLarge) ?? https(m.media?.posterStandard) ?? null,
    release: m.releaseDateUtc ?? null,
    earliest: m.earliestShowingUtc ?? null,
    runTime: m.runTime ?? null,
    rating: m.mpaaRating ?? null,
    genre: m.genre ?? null,
    synopsis: m.synopsis ?? null,
    starring: m.starringActors ?? null,
    directors: m.directors ?? null,
    trailer: https(m.media?.trailerHd) ?? null,
    hasShowtimes: !!m.hasScheduledShowtimes,
    formats: (m.attributes ?? []).map((a: any) => a.name).filter(Boolean),
    url: https(m.websiteUrl),
  };
}

function theatre(t: any) {
  return {
    id: t.id, name: t.longName ?? t.name, slug: t.slug ?? null,
    city: t.location?.city ?? null, state: t.location?.state ?? null,
    address: t.location?.addressLine1 ?? null, tz: t.timezone ?? 'America/New_York',
    lat: t.location?.latitude ?? null, lon: t.location?.longitude ?? null,
    closed: !!t.isClosed,
  };
}

// Premium formats first, so a showtime is labelled by the format that matters.
const FORMAT_ORDER = ['imax70mm', 'imaxwithlaser', 'imax', 'dolbycinemaatamcprime', 'dolbycinema', 'prime', 'xlatamc', 'screenx', 'dbox', '4dx', 'reald3d', '3d', 'laseratamc'];
function showtime(s: any) {
  const attrs = (s.attributes ?? []).map((a: any) => ({ code: String(a.code ?? '').toLowerCase(), name: a.name }));
  const fmt = FORMAT_ORDER.map((c) => attrs.find((a: any) => a.code === c)).find(Boolean)
    ?? attrs.find((a: any) => /imax|dolby|prime|3d|xl|screenx|d-box|4dx/i.test(a.name ?? ''));
  return {
    id: s.id, movieId: s.movieId, movieName: s.movieName, movieSlug: s.movieSlug ?? null,
    utc: s.showDateTimeUtc, local: s.showDateTimeLocal, runTime: s.runTime ?? null, rating: s.mpaaRating ?? null,
    theatreId: s.theatreId, auditorium: s.auditorium ?? null,
    format: fmt?.name ?? 'Standard',
    tags: attrs.map((a: any) => a.name).filter(Boolean),
    soldOut: !!s.isSoldOut, almostSoldOut: !!s.isAlmostSoldOut, canceled: !!s.isCanceled,
    purchaseUrl: https(s.purchaseUrl) ?? `https://www.amctheatres.com/showtimes/${s.id}/seats`,
  };
}

// AMC's seating layout. The documented shape is rows[].seats[] with isAvailable/seatType/row/column;
// older answers use a flat seats[] with available/type/name. Both are read, and things that aren't
// sellable seats (aisles, spaces) are skipped.
const NOT_A_SEAT = /notaseat|space|aisle|blank|stair|empty/i;
function seats(j: any) {
  const flat: any[] = [];
  if (Array.isArray(j?.rows)) for (const r of j.rows) for (const s of r.seats ?? []) flat.push({ ...s, row: s.row ?? r.name });
  if (Array.isArray(j?.seats)) flat.push(...j.seats);
  const list = flat
    .filter((s) => s && s.shouldDisplay !== false && !NOT_A_SEAT.test(String(s.seatType ?? s.type ?? '')))
    .map((s) => {
      const row = String(s.row ?? s.rowName ?? (s.name ? String(s.name).replace(/\d+$/, '') : ''));
      const col = Number(s.column ?? s.col ?? String(s.name ?? '').replace(/^\D+/, '')) || 0;
      return {
        name: String(s.seatId ?? s.name ?? `${row}${col}`),
        row, col,
        available: s.isAvailable ?? s.available ?? (s.status ? /avail|open/i.test(s.status) : false),
        type: String(s.seatType ?? s.type ?? 'Standard'),
      };
    });
  const rows = new Map<string, any[]>();
  for (const s of list) (rows.get(s.row) ?? rows.set(s.row, []).get(s.row)!).push(s);
  return {
    total: list.length,
    available: list.filter((s) => s.available).length,
    rows: [...rows.entries()].map(([name, ss]) => ({ name, seats: ss.sort((a, b) => a.col - b.col) })),
  };
}

// AMC's date path segment. Its docs show M-D-YY; ISO is tried if that is refused.
const amcDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${m}-${d}-${String(y).slice(2)}`; };

// ---- handler --------------------------------------------------------------------------------

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (allowedOrigin(origin)) cors['Access-Control-Allow-Origin'] = origin;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  if (!token) return reply(401, { error: 'Not signed in' });
  const { data: auth, error: authErr } = await db.auth.getUser(token);
  if (authErr || !auth.user) return reply(401, { error: 'Not signed in' });
  const { data: access, error: accessErr } = await db
    .from('project_access').select('project_slug')
    .eq('user_id', auth.user.id).eq('project_slug', PROJECT_SLUG).maybeSingle();
  if (accessErr) return reply(500, { error: 'Could not check access' });
  if (!access) return reply(403, { error: 'No access to this project' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'Invalid JSON' }); }

  if (!KEY) return reply(503, { error: 'The AMC API key is not set up yet', code: 'no_key' });

  const int = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
  const word = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

  try {
    switch (body.action) {
      case 'movies': {
        const view = ['now-playing', 'advance', 'coming-soon'].includes(body.view as string) ? body.view as string : 'now-playing';
        const r = await cached(`movies:${view}`, TTL.movies, async () => (await amcAll(`/v2/movies/views/${view}`, 'movies')).map(movie));
        return reply(200, { movies: r.data, fetchedAt: r.fetchedAt });
      }
      case 'movie': {
        const id = int(body.id) ?? (typeof body.id === 'string' && /^[a-z0-9-]{1,120}$/.test(body.id) ? body.id : null);
        if (!id) return reply(400, { error: 'Bad movie id' });
        const r = await cached(`movie:${id}`, TTL.movie, async () => movie(await amc(`/v2/movies/${id}`)));
        return reply(200, { movie: r.data, fetchedAt: r.fetchedAt });
      }
      case 'theatres': {
        const q = new URLSearchParams();
        const state = word(body.state, 2)?.toUpperCase();
        if (state && /^[A-Z]{2}$/.test(state)) q.set('state', state);
        const city = word(body.city); if (city) q.set('city', city);
        const name = word(body.name); if (name) q.set('name', name);
        if (![...q.keys()].length) return reply(400, { error: 'Search by state, city or name' });
        const r = await cached(`theatres:${q}`, TTL.theatres, async () =>
          (await amcAll(`/v2/theatres?${q}`, 'theatres', 400)).map(theatre).filter((t) => !t.closed));
        return reply(200, { theatres: r.data, fetchedAt: r.fetchedAt });
      }
      case 'showtimes': {
        const t = int(body.theatre);
        const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
        if (!t || !date) return reply(400, { error: 'Send a theatre number and a date' });
        const movieId = int(body.movie);
        const r = await cached(`showtimes:${t}:${date}`, TTL.showtimes, async () => {
          let list: any[];
          try { list = await amcAll(`/v2/theatres/${t}/showtimes/${amcDate(date)}`, 'showtimes'); }
          catch (e) {
            if (!(e instanceof HttpError) || e.code === 'bad_key') throw e;
            list = await amcAll(`/v2/theatres/${t}/showtimes/${date}`, 'showtimes');
          }
          return list.map(showtime).filter((s) => !s.canceled);
        });
        const list = movieId ? r.data.filter((s: any) => s.movieId === movieId) : r.data;
        return reply(200, { showtimes: list, fetchedAt: r.fetchedAt });
      }
      case 'seats': {
        const t = int(body.theatre), s = int(body.showtime);
        if (!t || !s) return reply(400, { error: 'Send a theatre number and a showtime' });
        const r = await cached(`seats:${t}:${s}`, TTL.seats, async () => seats(await amc(`/v2/seating-layouts/${t}/${s}`)));
        return reply(200, { ...r.data, fetchedAt: r.fetchedAt });
      }
      default:
        return reply(400, { error: 'Unknown action' });
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return reply(status, { error: e instanceof Error ? e.message : 'Something went wrong', code: (e as HttpError).code });
  }
});
