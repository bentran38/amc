// AMC Stubs A-List rules, as the pages use them to show what is still free and to warn before adding a
// showing. The database enforces the same rules (supabase/migrations/..._amc.sql, amc.check_alist), so
// this is only for display; keep the two in step.
//
//   * up to 4 showtimes per A-List week, which runs Friday 6:00 a.m. to the next Friday 5:59 a.m.
//     (theatre local time). Used, planned and no-show admissions all count;
//   * showtimes on the same day are fine as long as they don't overlap.

export const PER_WEEK = 4;
export const PENDING = 4;
export const TERMS_URL = 'https://www.amctheatres.com/amcstubs/alist/terms-and-conditions';
const DAY = 864e5;

/** The parts of a date/time as seen in time zone `tz`. */
function partsIn(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}

/**
 * The A-List week that `when` falls in, as the 'YYYY-MM-DD' of its Friday (same answer as
 * amc.alist_week in SQL). Shifting back 6 hours makes Friday 6:00 a.m. the start of a day.
 */
export function alistWeek(when, tz = localTz()) {
  const p = partsIn(new Date(when), tz);
  const shifted = new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - 6 * 3600e3);
  const back = (shifted.getUTCDay() - 5 + 7) % 7;
  return new Date(shifted.getTime() - back * DAY).toISOString().slice(0, 10);
}

/** A wall-clock date and time at a place ('2026-11-13', '19:30', 'America/Chicago') as a Date. */
export function wallToUtc(day, time, tz = localTz()) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, h, min);
  let t = want;
  for (let i = 0; i < 3; i++) { // converge on the zone's offset (twice is enough, even across DST)
    const p = partsIn(new Date(t), tz);
    t += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  }
  return new Date(t);
}

export const localTz = () =>Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

/** 'YYYY-MM-DD' Friday + n weeks. */
export const addWeeks = (friday, n) => new Date(Date.parse(`${friday}T00:00:00Z`) + n * 7 * DAY).toISOString().slice(0, 10);

/** "Fri Nov 13 – Thu Nov 19" for a week's Friday. */
export function weekLabel(friday) {
  const f = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const thursday = new Date(Date.parse(`${friday}T00:00:00Z`) + 6 * DAY).toISOString().slice(0, 10);
  return `${f(friday)} – ${f(thursday)}`;
}

const active = (a) => a.status !== 'cancelled';
// only showings with a time can overlap; a movie planned for a day without one fits around anything
const overlaps = (a, b) => !!(a.starts_at && b.starts_at) &&
  new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at);

/** The A-List week (its Friday) for a calendar day 'YYYY-MM-DD' (same as amc.day_week in SQL). */
export function weekOfDay(day) {
  const t = Date.parse(`${day}T00:00:00Z`);
  return new Date(t - ((new Date(t).getUTCDay() - 5 + 7) % 7) * DAY).toISOString().slice(0, 10);
}
/** The A-List week a showing counts in: by its date (every showing has one), else by its time. */
export const weekOfShowing = (a, tz = localTz()) => (a.show_date ? weekOfDay(a.show_date) : alistWeek(a.starts_at, a.tz ?? tz));
/** Still to come: its time hasn't passed, or (without a time) its day isn't over. */
export function isUpcoming(a, now = Date.now()) {
  if (a.starts_at) return new Date(a.starts_at) > now;
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return a.show_date >= today;
}

/**
 * Where one person stands. `admissions` are that person's rows (an outing plus status), as in the
 * amc.admissions view: { outing_id, status, show_date, starts_at?, ends_at?, tz }.
 */
export function standing(admissions, now = Date.now(), tz = localTz()) {
  const live = admissions.filter(active);
  const thisWeek = alistWeek(now, tz);
  const byWeek = {};
  for (const a of live) {
    const w = weekOfShowing(a, tz);
    byWeek[w] = (byWeek[w] ?? 0) + 1;
  }
  const upcoming = live.filter((a) => isUpcoming(a, now));
  return {
    thisWeek,
    byWeek,
    usedThisWeek: byWeek[thisWeek] ?? 0,
    leftThisWeek: Math.max(0, PER_WEEK - (byWeek[thisWeek] ?? 0)),
    upcoming: upcoming.length,
  };
}

/**
 * Can this person go to `outing` ({ id?, show_date?, starts_at?, ends_at?, tz })? Returns { ok, problems: string[], notes: string[] }: problems are rule
 * breaks the database will refuse; notes are things worth knowing that don't block a plan.
 */
export function canAttend(admissions, outing, status = 'planned', now = Date.now()) {
  const others = admissions.filter((a) => active(a) && a.outing_id !== outing.id);
  const problems = [], notes = [];
  const wk = weekOfShowing(outing);
  const sameWeek = others.filter((a) => weekOfShowing(a) === wk).length;
  if (sameWeek >= PER_WEEK) problems.push(`Already has ${PER_WEEK} movies that A-List week`);
  const clash = others.find((a) => overlaps(a, outing));
  if (clash) problems.push(`Overlaps ${clash.movie_name ?? 'another showing'}`);
  if (!problems.length && sameWeek === PER_WEEK - 1) notes.push('Uses the last admission of that week');
  return { ok: !problems.length, problems, notes };
}
