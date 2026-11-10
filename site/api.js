// Everything the pages ask for. The group's plans live in the `amc` schema
// (supabase/migrations/20261110000000_amc.sql); movies, theatres, showtimes and seats come from the
// AMC Theatres API through the amc-api Edge Function, which keeps the AMC key server-side.
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

// ---- theatres the group uses ------------------------------------------------------------------

export const theatres = async () => ok(await db.from('theatres').select('*').order('name'));
export const addTheatre = async (t) =>
  ok(await db.from('theatres').upsert({ id: t.id, name: t.name, slug: t.slug, city: t.city, state: t.state, tz: t.tz }));
export const removeTheatre = async (id) => ok(await db.from('theatres').delete().eq('id', id));

// ---- wants ----------------------------------------------------------------------------------

export const wants = async () => ok(await db.from('wants').select('*').order('created_at'));
export const want = async (m) =>
  ok(await db.from('wants').upsert({
    movie_id: m.id, movie_name: m.name, movie_slug: m.slug, poster_url: m.poster,
    release_date: m.release ? m.release.slice(0, 10) : null,
  }));
export const unwant = async (userId, movieId) =>
  ok(await db.from('wants').delete().eq('user_id', userId).eq('movie_id', movieId));

// ---- AMC API (through the Edge Function) ------------------------------------------------------

export class AmcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** Calls the amc-api function. Throws AmcError; code 'no_key' means the AMC key isn't set up yet. */
export async function amc(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('amc-api', { body: { action, ...payload } });
  if (!error) return data;
  let detail = error.message, code;
  try {
    const body = await error.context.json();
    detail = body.error || detail;
    code = body.code;
  } catch { /* not JSON */ }
  throw new AmcError(detail, code);
}

const memo = new Map();
/** Same as amc(), remembered for `ms` in this tab so moving between pages is instant. */
export async function amcCached(action, payload = {}, ms = 5 * 60e3) {
  const key = JSON.stringify([action, payload]);
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await amc(action, payload);
  memo.set(key, { at: Date.now(), value });
  return value;
}
