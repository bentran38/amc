// AMC A-List planner: pages and routing. Data access is in api.js, the A-List rules in rules.js, drag and drop in
// drag.js.
//   /                    the plan: a calendar (?view=day|week|month|year&date=) beside a catalog of movies to drag
//                        onto days; everyone's A-List admissions on top
//   /movies              what's on, for all stored days or one A-List week (?week=<friday>)
//   /movie/<id>          one movie's showtimes, day by day (?week=<friday> for just that week)
//   /day/<date>          the plan's day view for that date
//   /theatres            the theatres the scraper reads, switch them on or off
//   /theatre/<id>        everything on at one theatre (?date=)
//   /history             what everyone has watched
//   /rules               the A-List rules this follows
import { requireLogin, hasAccess, signOut, HOME, loadProfile } from './session.js';
import * as api from './api.js';
import { PER_WEEK, PENDING, TERMS_URL, addWeeks, weekLabel, standing, canAttend, localTz, wallToUtc, weekOfShowing, isUpcoming } from './rules.js';
import {
  $, el, icon, fmtWhen, fmtTime, fmtRun, isoDay, avatar, poster, toast, field, stat, table, skeleton,
  fmtBadge, shortTags, fmtDate, ago,
} from './ui.js';
import { draggable, dropzone, dock, resetZones } from './drag.js';

const SLUG = 'amc';

const session = await requireLogin();
if (!(await hasAccess(SLUG))) {
  location.replace(HOME);
  await new Promise(() => {});
}

const me = { id: session.user.id, name: (session.user.email ?? '').split('@')[0] || 'You' };
$('app').hidden = false;
$('signout').onclick = signOut;
$('home-link').href = HOME;

// Phones get their own layout (tab bar at the bottom, tap-first plan, bottom sheets) rather than a squeezed desktop.
const phone = matchMedia('(max-width: 760px)');
document.body.classList.toggle('phone', phone.matches);
phone.addEventListener('change', () => { document.body.classList.toggle('phone', phone.matches); render(); });
{
  const profile = await loadProfile(me.id);
  if (profile?.display_name || profile?.handle) me.name = profile.display_name || `@${profile.handle}`;
  $('handle').textContent = profile?.handle ? `@${profile.handle}` : me.name;
}

// ---- routing --------------------------------------------------------------------------------

const link = (href, ...kids) => el('a', { href }, ...kids);

function go(path, { replace = false } = {}) {
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
const query = () => new URLSearchParams(location.search);
const setQuery = (changes) => {
  const q = query();
  for (const [k, v] of Object.entries(changes)) (v === '' || v == null ? q.delete(k) : q.set(k, v));
  go(`${location.pathname}${q.size ? `?${q}` : ''}`, { replace: true });
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  const url = new URL(a.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  closeSheet();
  go(url.pathname + url.search);
});
addEventListener('popstate', render);

const NAV = [['/', 'Plan'], ['/movies', 'Movies'], ['/theatres', 'Theatres'], ['/history', 'History'], ['/rules', 'Rules']];
const TABS = [['/', 'Plan', 'cal'], ['/movies', 'Movies', 'film'], ['/history', 'History', 'clock'], ['/theatres', 'Theatres', 'pin'], ['/rules', 'Rules', 'book']];
function drawNav() {
  const here = location.pathname;
  const active = (p) => (p === '/' ? here === '/' : here === p || here.startsWith(`${p}/`) || (p === '/movies' && here.startsWith('/movie/')) || (p === '/theatres' && here.startsWith('/theatre/')));
  $('nav').replaceChildren(...NAV.map(([p, label]) => el('a', { className: `btn${active(p) ? ' nav-active' : ''}`, href: p }, label)));
  // the phone tab bar
  let bar = $('tabbar');
  if (!bar) { bar = el('nav', { id: 'tabbar', className: 'tabbar', ariaLabel: 'Sections' }); document.body.append(bar); }
  bar.replaceChildren(...TABS.map(([p, label, ic]) => el('a', { href: p, className: active(p) ? 'on' : '', ariaCurrent: active(p) ? 'page' : null }, icon(ic), el('span', {}, label))));
}

const view = (...nodes) => {
  const list = nodes.flat(Infinity).filter((n) => n != null && n !== false);
  list.forEach((n, i) => n.style?.setProperty('--i', Math.min(i, 8)));
  $('view').replaceChildren(...list);
};
const heading = (eyebrow, title, right) =>
  el('section', { className: 'hero' },
    el('div', {}, el('p', { className: 'eyebrow' }, el('span', { className: 'dot' }), eyebrow), el('h1', {}, title)),
    right);
const panel = (title, ...body) => el('section', { className: 'panel' }, title && el('h2', {}, title), ...body);
const failed = (e) => view(panel('Something went wrong', el('p', { className: 'muted' }, e.message)));
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');

async function render() {
  drawNav();
  resetZones();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const [first, id] = path.split('/').filter(Boolean).map(decodeURIComponent);
  const loading = setTimeout(() => view(skeleton()), 160);
  try {
    if (!first) await planPage();
    else if (first === 'movies') await moviesPage();
    else if (first === 'movie' && id) await moviePage(id);
    else if (first === 'day' && isDay(id)) go(`/?date=${id}`, { replace: true });
    else if (first === 'theatres') await theatresPage();
    else if (first === 'theatre' && id) await dayPage(null, +id);
    else if (first === 'history') await historyPage();
    else if (first === 'rules') rulesPage();
    else view(panel('Page not found', el('p', {}, link('/', 'Back to the plan'))));
  } catch (e) {
    console.error(e);
    failed(e);
  } finally {
    clearTimeout(loading);
  }
}

// ---- calendar days and A-List weeks -----------------------------------------------------------------
// Showtimes carry AMC's business day ('YYYY-MM-DD'). A calendar day's evening belongs to the A-List week that
// starts on the Friday on or before it, so weeks can be worked out from days without time zones.

const DAY_MS = 864e5;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const weekOf = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() - 5 + 7) % 7));
const weekDays = (friday) => Array.from({ length: 7 }, (_, i) => addDays(friday, i));
const isFriday = (day) => isDay(day) && weekOf(day) === day;
const weekdayOf = (day) => fmtDate(day, { weekday: 'short' });
function weekTitle(week) {
  const now = weekOf(isoDay());
  return week === now ? 'This week' : week === addWeeks(now, 1) ? 'Next week' : week === addWeeks(now, -1) ? 'Last week' : `Week of ${fmtDate(week, { month: 'short', day: 'numeric' })}`;
}
/** "Fri · Sat · Tue" for a few days, "Fri – Thu" when it is most of a week. */
function daysLabel(days) {
  const list = [...new Set(days)].sort();
  const md = (d) => fmtDate(d, { month: 'short', day: 'numeric' });
  if (list.length > 1 && addDays(list[0], 6) < list.at(-1)) return `${md(list[0])} – ${md(list.at(-1))} · ${list.length} days`;
  if (list.length > 4) return `${weekdayOf(list[0])} – ${weekdayOf(list.at(-1))} · ${list.length} days`;
  return list.map(weekdayOf).join(' · ');
}

// ---- release dates (AMC's movies page) --------------------------------------------------------------
// AMC posts a theatre's showtimes about a week ahead (plus advance tickets). For the days after that, a movie is
// "expected" from the day it opens: about four weeks for a film, a week for an anniversary reissue, the day itself for
// an event. A day AMC has posted in full (FULL_DAY showtimes or more) overrides that: if the movie isn't on it, it isn't.

const RUN_DAYS = { film: 28, reissue: 7, event: 1 };
const FULL_DAY = 20;
const expectedOn = (m, day) => !!m?.release && day >= m.release && day < addDays(m.release, RUN_DAYS[m.kind] ?? 28);
const opensLabel = (m, today = isoDay()) => (!m?.release ? null
  : m.release > today ? `${m.kind === 'event' ? 'On' : 'Opens'} ${fmtDate(m.release)}` : `Out since ${fmtDate(m.release)}`);

/** A movie on a day: 'showing' (AMC lists times), 'expected' (by its release date), 'not' (a posted day without it) or 'unknown'. */
function movieDayStatus({ showsByDay, dayInfo, movieById }, m, day) {
  const n = (showsByDay.get(day) ?? []).filter((x) => x.movieId === m?.id).length;
  if (n) return { s: 'showing', n };
  const info = dayInfo.get(day);
  const full = !!info && info.count >= FULL_DAY;
  const movie = movieById.get(m?.id) ?? m;
  if (!full && expectedOn(movie, day)) return { s: 'expected', movie };
  return { s: full ? 'not' : 'unknown' };
}

// ---- shared data ----------------------------------------------------------------------------

/** Members, outings and everyone's admissions in one go. */
async function groupData() {
  const [members, outings] = await Promise.all([api.members(), api.outings()]);
  const admissions = outings.flatMap((o) => (o.attendees ?? []).map((a) => ({
    outing_id: o.id, user_id: a.user_id, status: a.status, seat: a.seat,
    show_date: o.show_date, starts_at: o.starts_at, ends_at: o.ends_at, tz: o.tz, movie_name: o.movie_name,
  })));
  const of = (userId) => admissions.filter((a) => a.user_id === userId);
  return { members, outings, admissions, of };
}

// A showing has a date (show_date) and, only if someone knows it, a time (starts_at).
const hasTime = (o) => !!o.starts_at;
const isPast = (o) => !isUpcoming(o);
const showingKey = (o) => `${o.show_date} ${o.starts_at ?? '~'}`; // a day's timed showings first, then the rest
const byShowing = (a, b) => showingKey(a).localeCompare(showingKey(b));
const timeLabel = (o, short = false) => (o.starts_at
  ? (short ? fmtTime(o.starts_at, o.tz).replace(/\s?([AP])M$/i, (_, x) => x.toLowerCase()) : fmtTime(o.starts_at, o.tz))
  : 'Any time');
const whenLabel = (o) => (o.starts_at ? fmtWhen(o.starts_at, o.tz) : `${fmtDate(o.show_date, { weekday: 'short', month: 'short', day: 'numeric' })} · any time`);

const nameOf = (members, id) => {
  const m = members.find((x) => x.user_id === id);
  return id === me.id ? `${m?.display_name ?? me.name}` : m?.display_name ?? (m?.handle ? `@${m.handle}` : 'Someone');
};

/** How fresh the scraped showtimes are, shown above anything that uses them. */
function freshBanner(f) {
  const ok = f.lastOk;
  const failedSince = f.last && !f.last.ok;
  if (!ok) {
    return el('section', { className: 'panel notice warnbox' }, icon('warn'),
      el('p', {}, el('b', {}, 'No showtimes yet. '), el('span', { className: 'muted' },
        failedSince ? `The last update failed: ${f.last.error ?? 'unknown error'}.` : 'They appear after the next scheduled update.',
        ' You can still plan showings by hand from the Plan page.')));
  }
  const ageH = (Date.now() - Date.parse(ok.finished_at)) / 36e5;
  const stale = ageH > 12 || failedSince;
  return el('p', { className: `fresh${stale ? ' stale' : ''}` }, stale && icon('warn'),
    `Showtimes from amctheatres.com, last update ${ago(ok.finished_at)}. An update runs every hour and reads one day: today first, then days you've planned, then every date AMC lists, as far out as it goes.`,
    failedSince && el('span', { className: 'muted' }, ` Last update failed: ${f.last.error ?? 'unknown error'}`));
}

// ---- plan: a calendar (day / week / month / year) with the movie catalog beside it -------------------
// The calendar is on the left, the catalog of posters on the right (along the bottom on a phone). Drag a poster
// onto a day to plan it for that day: green if AMC lists it that day, blue if it's expected from its release date,
// amber if neither (you can still plan it, say when you already have tickets).

const MODES = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
// The group's A-List memberships started in November 2026: nothing before then is shown. The year view is a calendar
// year, so 2026 is just November and December.
const STUBS_START = '2026-11-01';
/** The first month of `day`'s calendar year that the planner shows (January, or November in 2026). */
const yearStart = (day) => (`${day.slice(0, 4)}-01-01` < STUBS_START ? STUBS_START : `${day.slice(0, 4)}-01-01`);
let catalogTab = 'view'; // 'view': showing in the period on screen; 'wish': wishlist; 'all'
let catalogQuery = '';

const addMonths = (day, n) => {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
const monthDays = (day) => {
  const first = `${day.slice(0, 7)}-01`;
  const out = [];
  for (let d = first; d.slice(0, 7) === first.slice(0, 7); d = addDays(d, 1)) out.push(d);
  return out;
};
const plansLink = (mode, d) => `/?view=${mode}&date=${d}`;
const groupBy = (list, key) => {
  const m = new Map();
  for (const x of list) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))).push(x);
  return m;
};

async function planPage() {
  const q = query();
  const mode = MODES.some(([m]) => m === q.get('view')) ? q.get('view') : 'week';
  const today = isoDay();
  const date = isDay(q.get('date')) ? q.get('date') : today;
  const [g, wants, movies, shows, dayInfo, theatres] = await Promise.all([
    groupData(), api.wants(), api.movies(), api.showtimes(), api.days(), api.theatres()]);
  const ctx = {
    g, wants, movies, shows, dayInfo, theatres, today, date, mode,
    movieById: new Map(movies.map((m) => [m.id, m])),
    showsByDay: groupBy(shows, (s) => s.date),
    plansByDay: groupBy(g.outings.slice().sort(byShowing), (o) => o.show_date),
    opensByDay: groupBy(movies.filter((m) => m.release && m.kind !== 'event'), (m) => m.release),
  };
  ctx.range = mode === 'week' ? weekDays(weekOf(date)) : mode === 'month' ? monthDays(date) : null;
  if (phone.matches) return view(phonePlan(ctx));

  dock({
    accepts: 'attendee', kind: 'danger', label: 'Drop here to take them off the showing', iconNode: () => icon('x'),
    onDrop: (d) => act(() => api.removeAttendee(d.outingId, d.userId), `${d.name} taken off ${d.movie}`)(),
  });
  const body = mode === 'week' ? weekView(ctx) : mode === 'month' ? monthView(ctx) : yearView(ctx);
  view(
    planBar(ctx),
    peopleStrip(ctx),
    el('div', { className: `planner mode-${mode}` }, el('div', { className: 'cal' }, body), catalog(ctx)),
  );
}

/** Run something that changes the plan, then redraw. */
const act = (fn, okMsg) => async () => {
  try { await fn(); if (okMsg) toast(okMsg); closeSheet(); render(); } catch (e) { toast(e.message, true); }
};

/** The date n days / weeks / months / years from `date`, for the ‹ › buttons. */
const stepDate = (mode, date, n) => (mode === 'week' ? addDays(weekOf(date), 7 * n)
  : mode === 'month' ? addMonths(date, n) : yearStart(`${Number(date.slice(0, 4)) + n}-01-01`));
/** Can the ‹ button go back from here? Not to a month or A-List year before the memberships started. */
const canGoBack = (mode, date) => mode === 'week'
  || (mode === 'year' ? date.slice(0, 4) > STUBS_START.slice(0, 4) : stepDate(mode, date, -1) >= STUBS_START.slice(0, 7));
const yearTitle = (date) => date.slice(0, 4);

function planBar(ctx) {
  const { mode, date, today } = ctx;
  const step = (n) => stepDate(mode, date, n);
  const title = mode === 'week' ? el('span', {}, weekTitle(weekOf(date)), el('span', { className: 'muted' }, ` · ${weekLabel(weekOf(date))}`))
    : mode === 'month' ? fmtDate(date, { month: 'long', year: 'numeric' }) : yearTitle(date);
  const goTo = (d) => setQuery({ date: d === today ? '' : d });
  return el('section', { className: 'planbar' },
    el('div', { className: 'pb-left' },
      el('h1', {}, 'Our plan'),
      el('div', { className: 'pb-nav' },
        el('button', { className: 'btn sm ghost', type: 'button', onclick: () => goTo(today) }, 'Today'),
        el('button', { className: 'btn sm ghost icon-only', type: 'button', ariaLabel: 'Previous', disabled: !canGoBack(mode, date), onclick: () => goTo(step(-1)) }, '‹'),
        el('button', { className: 'btn sm ghost icon-only', type: 'button', ariaLabel: 'Next', onclick: () => goTo(step(1)) }, '›'),
        el('h2', { className: 'pb-title' }, title))),
    el('div', { className: 'pb-right' },
      el('div', { className: 'seg modes', role: 'tablist', ariaLabel: 'Calendar view' }, MODES.map(([m, label]) =>
        el('button', { className: m === mode ? 'on' : '', type: 'button', role: 'tab', ariaSelected: String(m === mode), onclick: () => setQuery({ view: m === 'week' ? '' : m }) }, label))),
      el('button', { className: 'btn sm ghost', type: 'button', onclick: () => manualSheet(ctx.g) }, icon('plus'), 'Add by hand')));
}

/** Each person: draggable face, their 4 admissions in the A-List week on screen, reservations held. */
function peopleStrip({ g, date, mode, today }) {
  const week = weekOf(mode === 'week' ? date : today);
  const now = Date.now();
  const resetsIn = Math.max(0, Date.parse(`${addDays(weekOf(today), 7)}T06:00:00`) - now);
  return el('div', { className: 'peoplestrip' },
    g.members.map((m) => {
      const inWeek = g.of(m.user_id).filter((a) => weekOfShowing(a) === week).sort(byShowing);
      const pips = Array.from({ length: PER_WEEK }, (_, i) => {
        const a = inWeek[i];
        const cls = !a ? '' : isPast(a) ? 'used' : 'planned';
        return el('i', { className: `pip ${cls}`, title: a ? `${a.movie_name} · ${whenLabel(a)}` : 'Open' });
      });
      const face = draggable(el('span', { className: 'grab', title: `Drag ${m.display_name} onto a showing to add them` }, avatar(m.display_name)), {
        type: 'member', data: { userId: m.user_id, name: m.display_name },
        ghost: () => el('span', { className: 'chip-ghost' }, avatar(m.display_name, true), m.display_name),
      });
      return el('div', { className: 'pchip' }, face,
        el('div', {}, el('b', {}, m.display_name, m.user_id === me.id ? el('span', { className: 'muted' }, ' (you)') : ''), el('span', { className: 'pips' }, pips)),
        el('span', { className: 'pmeta muted' }, `${Math.max(0, PER_WEEK - inWeek.length)} left${week === weekOf(today) ? ' this week' : ` · ${fmtDate(week, { month: 'short', day: 'numeric' })} wk`}`,
));
    }),
    el('span', { className: 'muted reset' }, `Admissions reset Fri 6 AM, in ${Math.floor(resetsIn / 864e5)}d ${Math.floor((resetsIn % 864e5) / 36e5)}h`));
}

// ---- the calendar views ---------------------------------------------------------------------------

const timesFor = (ctx, movieId, day) => (ctx.showsByDay.get(day) ?? []).filter((s) => s.movieId === movieId);

/** Make a day a drop target: green when AMC lists the movie that day, blue when it's expected, amber otherwise. */
function dayDrop(ctx, node, day) {
  if (day < ctx.today) return node;
  return dropzone(node, {
    accepts: ['movie', 'showing'],
    hint: (data, type) => {
      const moving = type === 'showing';
      if (moving && data.show_date === day) return ['good', 'Its day now'];
      const st = movieDayStatus(ctx, moving ? { id: data.movie_id } : data, day);
      const verb = moving ? 'move here' : 'plan it';
      return st.s === 'showing' ? ['good', `Showing that day · ${verb}`] : st.s === 'expected' ? ['expect', `Expected that day · ${verb}`]
        : ['warn', st.s === 'not' ? `Not showing · ${moving ? 'move' : 'plan'} anyway` : `Not posted yet · ${moving ? 'move' : 'plan'} anyway`];
    },
    onDrop: (data, type) => (type === 'showing' ? moveTo(data, day) : movieDaySheet(data, day, ctx.g)),
  });
}

/** A planned showing: poster, time, title, who's going. Click for the details; drop a face on it to add them. */
function planChip(ctx, o, size = 'md') {
  const past = isPast(o);
  const going = o.attendees ?? [];
  const state = past ? 'past' : 'planned';
  const chip = el('button', {
    className: `pchipx plan ${state} ${size}`, type: 'button',
    title: `${o.movie_name} · ${whenLabel(o)}${past ? ' · watched' : ''}`,
    onclick: () => showingSheet(ctx.g, o),
  },
  size !== 'sm' && poster(o.poster_url, o.movie_name),
  el('span', { className: 'pl-text' },
    el('span', { className: `pl-time${hasTime(o) ? '' : ' anytime'}` }, timeLabel(o, size === 'sm'), size === 'lg' && o.format && o.format !== 'Standard' ? fmtBadge(o.format) : null),
    el('span', { className: 'pl-title' }, o.movie_name)),
  size !== 'sm' && el('span', { className: 'faces' }, going.map((a) => avatar(nameOf(ctx.g.members, a.user_id), true))));
  if (!past) {
    dropzone(chip, {
      accepts: ['member', 'attendee'],
      onDrop: (d) => {
        if (going.some((a) => a.user_id === d.userId)) return toast(`${d.name} is already going`);
        act(() => api.planShowing({ id: o.id }, [d.userId]), `${d.name} added to ${o.movie_name}`)();
      },
    });
    // drag it to another day to move it
    draggable(chip, { type: 'showing', data: o, ghost: () => el('span', { className: 'poster-ghost' }, poster(o.poster_url, o.movie_name)) });
    chip.title += ' · drag to another day to move it';
  }
  return chip;
}

/** Move a showing to another day (keeps who's going; see api.moveShowing for what happens to its time). */
function moveTo(o, day) {
  if (o.show_date === day) return;
  const note = o.showtime_id ? ' (any time: that showtime was for the old day)' : '';
  return act(() => api.moveShowing(o, day), `${o.movie_name} moved to ${fmtDate(day)}${note}`)();
}

/** The films opening that day, as small buttons that open the plan sheet. */
function opensRow(ctx, d) {
  const list = (ctx.opensByDay.get(d) ?? []).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return null;
  return el('div', { className: 'opens' }, el('span', { className: 'opens-label' }, 'Opens'),
    list.map((m) => el('button', { className: 'opens-chip', type: 'button', title: `${m.name} opens ${fmtDate(d)}: plan it`, onclick: () => movieDaySheet(m, d, ctx.g) }, m.name)));
}

function dayItems(ctx, d, size) {
  return (ctx.plansByDay.get(d) ?? []).map((o) => planChip(ctx, o, size));
}

/** Week: the A-List week (Fri → Thu) as a vertical bar of days. */
function weekView(ctx) {
  const w = weekOf(ctx.date);
  const counts = ctx.g.members.map((m) => {
    const n = ctx.g.of(m.user_id).filter((a) => weekOfShowing(a) === w).length;
    return el('span', {}, `${m.display_name} `, el('b', { className: n >= PER_WEEK ? 'warn' : '' }, `${n}/${PER_WEEK}`));
  });
  return el('div', { className: 'weekcol' },
    el('div', { className: 'wk-head' }, el('span', { className: 'counts' }, counts),
      el('a', { className: 'btn sm ghost', href: `/movies?week=${w}` }, icon('ticket'), 'Browse this week')),
    weekDays(w).map((d, i) => {
      const past = d < ctx.today;
      const info = ctx.dayInfo.get(d);
      const items = dayItems(ctx, d, 'md');
      return dayDrop(ctx, el('section', { className: `drow${past ? ' past' : ''}${d === ctx.today ? ' today' : ''}`, style: `--i:${i}` },
        el(past ? 'div' : 'button', { className: 'drow-date', ...(past ? {} : { type: 'button', title: `What's on ${fmtDate(d)}`, onclick: () => addSheet(ctx, d) }) },
          el('span', { className: 'dd-wd' }, d === ctx.today ? 'Today' : weekdayOf(d)),
          el('b', { className: 'dd-num' }, Number(d.slice(8))),
          el('span', { className: 'dd-mo' }, fmtDate(d, { month: 'short' }))),
        el('div', { className: 'drow-body' },
          items.length ? items : el('span', { className: 'drow-empty' }, past ? 'Nothing' : 'Drop a movie here'),
          !past && opensRow(ctx, d)),
        !past && el('span', { className: 'drow-meta' }, info ? `${info.count} showtimes` : 'not read yet')), d);
    }));
}

/** Month: rows are A-List weeks (Fri → Thu). */
function monthView(ctx) {
  const days = monthDays(ctx.date);
  const weeks = [];
  for (let w = weekOf(days[0]); w <= days.at(-1); w = addDays(w, 7)) weeks.push(w);
  const inMonth = (d) => d.slice(0, 7) === days[0].slice(0, 7);
  return el('div', { className: 'month' },
    el('div', { className: 'mo-head' }, weekDays(weeks[0]).map((d) => el('span', {}, weekdayOf(d)))),
    weeks.map((w) => el('div', { className: 'mo-week' }, weekDays(w).map((d) => {
      const items = dayItems(ctx, d, 'sm');
      const info = ctx.dayInfo.get(d);
      return dayDrop(ctx, el('div', { className: `mcell${inMonth(d) ? '' : ' out'}${d < ctx.today ? ' past' : ''}${d === ctx.today ? ' today' : ''}` },
        el('a', { className: 'mc-num', href: `/?date=${d}`, title: 'Open this week' }, Number(d.slice(8))),
        d >= ctx.today && info && el('span', { className: 'mc-info', title: `${info.count} showtimes stored` }, info.count),
        el('div', { className: 'mc-items' }, items.slice(0, 3),
          items.length > 3 && el('a', { className: 'mc-more', href: `/?date=${d}` }, `+${items.length - 3} more`))), d);
    }))));
}

/** Year: the months of a calendar year (from November in 2026); a day is coloured by what's on it. */
function yearView(ctx) {
  const start = yearStart(ctx.date);
  const months = 12 - (Number(start.slice(5, 7)) - 1);
  return el('div', { className: 'year' }, Array.from({ length: months }, (_, i) => {
    const first = addMonths(start, i);
    const days = monthDays(first);
    let count = 0;
    const weeks = [];
    for (let w = weekOf(first); w <= days.at(-1); w = addDays(w, 7)) weeks.push(w);
    const grid = weeks.map((w) => el('div', { className: 'ym-week' }, weekDays(w).map((d) => {
      if (d.slice(0, 7) !== first.slice(0, 7)) return el('span', { className: 'yd out' });
      const plans = ctx.plansByDay.get(d) ?? [];
      count += plans.length;
      const state = plans.length ? (plans.every(isPast) ? 'past' : 'planned') : '';
      const tip = plans.map((o) => `${o.movie_name} ${hasTime(o) ? fmtTime(o.starts_at, o.tz) : '(any time)'}`).join(', ');
      return el('a', { className: `yd ${state}${d === ctx.today ? ' today' : ''}`, href: `/?date=${d}`, title: tip ? `${fmtDate(d)}: ${tip}` : fmtDate(d) }, Number(d.slice(8)));
    })));
    return el('section', { className: 'ymonth', style: `--i:${i}` },
      el('a', { className: 'ym-title', href: plansLink('month', first) }, fmtDate(first, { month: 'long' }),
        count ? el('span', { className: 'pill planned' }, `${count} ${count === 1 ? 'movie' : 'movies'}`) : null),
      el('div', { className: 'ym-head' }, weekDays(weeks[0]).map((d) => el('span', {}, weekdayOf(d).slice(0, 1)))),
      grid);
  }));
}

// ---- the plan on a phone ----------------------------------------------------------------------------
// Same data and the same things you can do, laid out for a thumb: a period switcher, people as a scrolling row,
// a Fri → Thu strip of day chips, and an agenda of full-width cards. Instead of dragging posters, each day has an
// "Add" button that lists what's showing or expected that day (tap Plan) and everything else (plan it anyway);
// people are added from a showing's sheet.

function phonePlan(ctx) {
  const { mode, date, today } = ctx;
  const goTo = (d) => setQuery({ date: d === today ? '' : d });
  const w = weekOf(date);
  const [title, sub] = mode === 'week' ? [weekTitle(w), weekLabel(w)]
    : mode === 'month' ? [fmtDate(date, { month: 'long' }), date.slice(0, 4)]
    : [yearTitle(date), yearStart(date) === STUBS_START ? 'Since November' : 'Year'];
  const head = el('section', { className: 'm-head' },
    el('div', { className: 'm-row' },
      el('button', { className: 'm-icon', type: 'button', ariaLabel: 'Previous', disabled: !canGoBack(mode, date), onclick: () => goTo(stepDate(mode, date, -1)) }, '‹'),
      el('button', { className: 'm-period', type: 'button', title: 'Back to today', onclick: () => goTo(today) }, el('b', {}, title), el('small', {}, sub)),
      el('button', { className: 'm-icon', type: 'button', ariaLabel: 'Next', onclick: () => goTo(stepDate(mode, date, 1)) }, '›')),
    el('div', { className: 'seg m-modes', role: 'tablist', ariaLabel: 'Calendar view' }, MODES.map(([m, label]) =>
      el('button', { className: m === mode ? 'on' : '', type: 'button', role: 'tab', ariaSelected: String(m === mode), onclick: () => setQuery({ view: m === 'week' ? '' : m }) }, label))));

  const body = mode === 'week' ? phoneWeek(ctx) : mode === 'month' ? phoneMonth(ctx) : yearView(ctx);
  return [head, phonePeople(ctx), body,
    el('button', { className: 'btn ghost m-byhand', type: 'button', onclick: () => manualSheet(ctx.g) }, icon('plus'), 'Add a showing by hand')];
}

function phonePeople({ g, date, mode, today }) {
  const week = weekOf(mode === 'week' ? date : today);
  const now = Date.now();
  return el('div', { className: 'm-people' }, g.members.map((m) => {
    const inWeek = g.of(m.user_id).filter((a) => weekOfShowing(a) === week).sort(byShowing);
    return el('div', { className: 'm-person' }, avatar(m.display_name, true),
      el('span', {}, el('b', {}, m.display_name),
        el('span', { className: 'pips' }, Array.from({ length: PER_WEEK }, (_, i) => {
          const a = inWeek[i];
          return el('i', { className: `pip ${!a ? '' : isPast(a) ? 'used' : 'planned'}` });
        }))),
      el('span', { className: 'muted' }, `${Math.max(0, PER_WEEK - inWeek.length)} of ${PER_WEEK} left`));
  }));
}

const dotsFor = (ctx, d) => [
  ...(ctx.plansByDay.get(d) ?? []).map((o) => (isPast(o) ? 'past' : 'planned')),
].slice(0, 4).map((c) => el('i', { className: c }));

function phoneWeek(ctx) {
  const days = weekDays(weekOf(ctx.date));
  const counts = ctx.g.members.map((m) => {
    const n = ctx.g.of(m.user_id).filter((a) => weekOfShowing(a) === weekOf(ctx.date)).length;
    return `${m.display_name} ${n}/${PER_WEEK}`;
  }).join(' · ');
  return [
    el('div', { className: 'm-days', role: 'group', ariaLabel: 'Days' }, days.map((d) => el('button', {
      className: `m-day${d === ctx.today ? ' today' : ''}${d < ctx.today ? ' past' : ''}`, type: 'button',
      onclick: () => document.getElementById(`d-${d}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, el('span', {}, weekdayOf(d)), el('b', {}, Number(d.slice(8))), el('span', { className: 'm-dots' }, dotsFor(ctx, d))))),
    el('p', { className: 'm-counts muted' }, counts, ' · ', link(`/movies?week=${weekOf(ctx.date)}`, 'Browse this week')),
    days.map((d) => phoneDay(ctx, d)),
  ];
}

function phoneMonth(ctx) {
  const days = monthDays(ctx.date);
  const weeks = [];
  for (let w = weekOf(days[0]); w <= days.at(-1); w = addDays(w, 7)) weeks.push(w);
  const inMonth = (d) => d.slice(0, 7) === days[0].slice(0, 7);
  return [
    el('div', { className: 'm-month' },
      el('div', { className: 'm-mrow head' }, weekDays(weeks[0]).map((d) => el('span', {}, weekdayOf(d).slice(0, 2)))),
      weeks.map((w) => el('div', { className: 'm-mrow' }, weekDays(w).map((d) => el('button', {
        className: `m-mcell${inMonth(d) ? '' : ' out'}${d < ctx.today ? ' past' : ''}${d === ctx.today ? ' today' : ''}${d === ctx.date ? ' sel' : ''}`,
        type: 'button', ariaLabel: fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' }), ariaPressed: String(d === ctx.date),
        onclick: () => setQuery({ date: d === ctx.today ? '' : d }),
      }, Number(d.slice(8)), el('span', { className: 'm-dots' }, dotsFor(ctx, d))))))),
    phoneDay(ctx, ctx.date),
  ];
}

/** One day of the agenda: what's planned, what opens, and an Add button. */
function phoneDay(ctx, d) {
  const past = d < ctx.today;
  const plans = ctx.plansByDay.get(d) ?? [];
  const info = ctx.dayInfo.get(d);
  return el('section', { className: `m-agenda${past ? ' past' : ''}${d === ctx.today ? ' today' : ''}`, id: `d-${d}` },
    el('div', { className: 'm-agenda-head' },
      el('span', { className: 'm-date' }, el('b', {}, d === ctx.today ? 'Today' : fmtDate(d, { weekday: 'long' })), ` ${fmtDate(d, { month: 'short', day: 'numeric' })}`),
      !past && el('span', { className: 'muted' }, info ? `${info.count} times` : 'not read yet'),
      !past && el('button', { className: 'm-add', type: 'button', onclick: () => addSheet(ctx, d) }, icon('plus'), 'Add')),
    plans.map((o) => phonePlanCard(ctx, o)),
    !past && opensRow(ctx, d),
    !plans.length && (past
      ? el('p', { className: 'm-none' }, 'Nothing')
      : el('button', { className: 'm-empty', type: 'button', onclick: () => addSheet(ctx, d) }, 'Nothing planned · tap to add a movie')));
}

function phonePlanCard(ctx, o) {
  const past = isPast(o);
  const going = o.attendees ?? [];
  const state = past ? 'past' : 'planned';
  const status = past ? 'Watched' : going.length > 1 ? `${going.length} going` : 'Going';
  return el('button', { className: `m-card ${state}`, type: 'button', onclick: () => showingSheet(ctx.g, o) },
    poster(o.poster_url, o.movie_name),
    el('span', { className: 'm-card-main' },
      el('span', { className: `m-time${hasTime(o) ? '' : ' anytime'}` }, timeLabel(o), o.format && o.format !== 'Standard' ? fmtBadge(o.format) : null),
      el('span', { className: 'm-title' }, o.movie_name),
      el('span', { className: 'm-sub' }, el('span', { className: 'faces' }, going.map((a) => avatar(nameOf(ctx.g.members, a.user_id), true))), status)),
    el('span', { className: 'm-chev', ariaHidden: 'true' }, '›'));
}

/** Add a movie to a day: what's showing, what's expected, and everything else (plan it anyway). */
function addSheet(ctx, day) {
  const info = ctx.dayInfo.get(day);
  const showing = groupBy(ctx.showsByDay.get(day) ?? [], (s) => s.movieId);
  const wanted = new Set(ctx.wants.map((w) => w.movie_id));
  const extra = ctx.wants.filter((w) => !ctx.movieById.has(w.movie_id))
    .map((w) => ({ id: w.movie_id, name: w.movie_name, slug: w.movie_slug, poster: w.poster_url }));
  const everyone = [...ctx.movies, ...extra.filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)];
  const order = (a, b) => wanted.has(b.id) - wanted.has(a.id) || a.name.localeCompare(b.name);
  const search = el('input', { type: 'search', placeholder: 'Search movies', ariaLabel: 'Search movies' });
  const list = el('div', { className: 'm-addlist' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hit = (m) => !q || m.name.toLowerCase().includes(q);
    const on = everyone.filter((m) => showing.has(m.id) && hit(m)).sort(order);
    const exp = everyone.filter((m) => !showing.has(m.id) && hit(m) && movieDayStatus(ctx, m, day).s === 'expected').sort(order);
    const off = everyone.filter((m) => !showing.has(m.id) && hit(m) && !exp.includes(m)).sort(order);
    list.replaceChildren(...[
      el('h3', {}, on.length ? `Showing ${fmtDate(day)}` : info ? `Nothing else showing ${fmtDate(day)}` : `${fmtDate(day)} hasn't been read from AMC yet`),
      on.length ? el('p', { className: 'muted' }, 'Tap Plan. No need to pick a time.') : null,
      on.map((m) => el('div', { className: 'm-addrow' },
        poster(m.poster, m.name),
        el('div', { className: 'm-addmain' },
          el('b', {}, m.name, wanted.has(m.id) ? el('span', { className: 'star' }, ' ★') : ''),
          el('span', { className: 'muted' }, [m.rating, fmtRun(m.runTime), `${showing.get(m.id).length} showings`].filter(Boolean).join(' · '))),
        el('button', { className: 'btn sm primary m-plan', type: 'button', onclick: () => movieDaySheet(m, day, ctx.g) }, 'Plan'))),
      exp.length > 0 && el('h3', {}, 'Expected that day'),
      exp.length > 0 && el('p', { className: 'muted' }, 'AMC hasn’t posted times this far out, but these will be in theatres by then.'),
      exp.map((m) => el('div', { className: 'm-addrow' },
        poster(m.poster, m.name),
        el('div', { className: 'm-addmain' },
          el('b', {}, m.name, wanted.has(m.id) ? el('span', { className: 'star' }, ' ★') : ''),
          el('span', { className: 'muted' }, [opensLabel(m), m.rating, fmtRun(m.runTime)].filter(Boolean).join(' · '))),
        el('button', { className: 'btn sm primary m-plan', type: 'button', onclick: () => movieDaySheet(m, day, ctx.g) }, 'Plan'))),
      off.length > 0 && el('h3', {}, 'Everything else'),
      off.length > 0 && el('p', { className: 'muted' }, 'Not listed for that day. Plan one anyway if you know it’s on (say you already have tickets).'),
      off.map((m) => el('div', { className: 'm-addrow slim' },
        poster(m.poster, m.name),
        el('b', {}, m.name, wanted.has(m.id) ? el('span', { className: 'star' }, ' ★') : ''),
        el('button', { className: 'btn sm ghost', type: 'button', onclick: () => movieDaySheet(m, day, ctx.g) }, 'Plan'))),
      !on.length && !off.length && el('p', { className: 'muted' }, 'No movies match.'),
    ].flat(Infinity).filter((n) => n != null && n !== false));
  };
  search.oninput = draw;
  draw();
  openSheet(
    el('div', { className: 'row between' },
      el('h2', { style: 'margin:0' }, fmtDate(day, { weekday: 'long', month: 'short', day: 'numeric' })),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    search, list,
    el('div', { className: 'row' }, el('button', { className: 'btn ghost', type: 'button', onclick: () => manualSheet(ctx.g, { day }) }, icon('plus'), 'Add by hand')));
}

// ---- the movie catalog -----------------------------------------------------------------------------

function catalog(ctx) {
  const inView = ctx.range && new Set(ctx.range);
  const daysFor = new Map();
  for (const s of ctx.shows) if (!inView || inView.has(s.date)) (daysFor.get(s.movieId) ?? daysFor.set(s.movieId, new Set()).get(s.movieId)).add(s.date);
  const wanted = new Map();
  for (const w of ctx.wants) {
    const x = wanted.get(w.movie_id) ?? { id: w.movie_id, name: w.movie_name, slug: w.movie_slug, poster: w.poster_url, who: [] };
    x.who.push(w.user_id);
    wanted.set(w.movie_id, x);
  }
  const all = [...ctx.movies.map((m) => ({ ...m, who: wanted.get(m.id)?.who ?? [] })),
    ...[...wanted.values()].filter((w) => !ctx.movieById.has(w.id))];
  const weekParam = ctx.mode === 'week' ? `?week=${weekOf(ctx.date)}` : '';
  // expected on a day on screen (from today on), going by its release date
  const expIn = (m) => !daysFor.has(m.id) && (ctx.range
    ? ctx.range.some((d) => d >= ctx.today && movieDayStatus(ctx, m, d).s === 'expected')
    : !!m.release && addDays(m.release, RUN_DAYS[m.kind] ?? 28) > ctx.today);

  const tile = (m, i) => {
    const d = daysFor.get(m.id);
    const soon = m.release && m.release > ctx.today;
    return draggable(el('a', { className: 'cat-tile', href: `/movie/${m.id}${weekParam}`, style: `--i:${Math.min(i, 24)}`, title: `${m.name}: drag onto a day, or tap for its showtimes` },
      el('span', { className: 'pp' }, poster(m.poster, m.name), m.who.length > 0 && el('span', { className: 'ct-star', title: 'On the wishlist' }, '★')),
      el('span', { className: 'ct-name' }, m.name),
      el('span', { className: `ct-sub${d ? ' on' : expIn(m) ? ' expect' : ''}` },
        d ? daysLabel([...d]) : soon ? opensLabel(m, ctx.today) : expIn(m) ? 'Expected' : inView ? 'No times on screen' : 'No times stored'),
      m.kind === 'event' && el('span', { className: 'ct-kind' }, 'Event'),
      m.who.length > 0 && el('span', { className: 'faces' }, m.who.map((id) => avatar(nameOf(ctx.g.members, id), true)))), {
      type: 'movie', data: m, ghost: () => el('span', { className: 'poster-ghost' }, poster(m.poster, m.name)),
    });
  };

  const grid = el('div', { className: 'cat-grid' });
  const search = el('input', { type: 'search', placeholder: 'Search movies', value: catalogQuery, ariaLabel: 'Search movies' });
  const tabs = el('div', { className: 'seg cat-tabs', role: 'tablist' });
  const TABS = [['view', ctx.range ? 'On screen' : 'Showing'], ['soon', 'Coming soon'], ['wish', 'Wishlist'], ['all', 'All']];
  const draw = () => {
    catalogQuery = search.value;
    const q = search.value.trim().toLowerCase();
    tabs.replaceChildren(...TABS.map(([k, label]) => el('button', {
      className: k === catalogTab ? 'on' : '', type: 'button', role: 'tab', ariaSelected: String(k === catalogTab),
      onclick: () => { catalogTab = k; draw(); },
    }, label)));
    const list = all
      .filter((m) => (catalogTab === 'view' ? daysFor.has(m.id) || expIn(m) : catalogTab === 'soon' ? m.release > ctx.today
        : catalogTab === 'wish' ? m.who.length > 0 : true))
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .sort(catalogTab === 'soon'
        ? (a, b) => a.release.localeCompare(b.release) || (a.kind === 'event') - (b.kind === 'event') || a.name.localeCompare(b.name)
        : (a, b) => (b.who.length > 0) - (a.who.length > 0) || (daysFor.get(b.id)?.size ?? 0) - (daysFor.get(a.id)?.size ?? 0)
          || expIn(b) - expIn(a) || (a.kind === 'event') - (b.kind === 'event') || a.name.localeCompare(b.name));
    grid.replaceChildren(...(list.length ? list.map(tile) : [el('p', { className: 'muted cat-empty' },
      q ? 'No movies match.' : catalogTab === 'view' ? 'Nothing posted or expected for these days yet. Try Coming soon.'
        : catalogTab === 'soon' ? 'Nothing announced yet.' : catalogTab === 'wish' ? 'Nothing starred yet.' : 'No movies yet.')]));
  };
  search.oninput = draw;
  draw();

  let collapsed = false;
  try { collapsed = localStorage.getItem('amc.catalog') === 'closed'; } catch { /* no storage */ }
  const box = el('aside', { className: `catalog${collapsed ? ' collapsed' : ''}`, ariaLabel: 'Movie catalog' });
  const toggle = el('button', {
    className: 'btn sm ghost cat-toggle', type: 'button', ariaExpanded: String(!collapsed),
    onclick: () => {
      const c = box.classList.toggle('collapsed');
      toggle.ariaExpanded = String(!c);
      toggle.textContent = c ? 'Show' : 'Hide';
      try { localStorage.setItem('amc.catalog', c ? 'closed' : 'open'); } catch { /* no storage */ }
    },
  }, collapsed ? 'Show' : 'Hide');
  box.append(
    el('div', { className: 'cat-head' },
      el('div', { className: 'cat-title' }, el('h2', {}, 'Movies'), el('span', { className: 'muted' }, `${all.length}`), toggle),
      tabs, search),
    el('p', { className: 'cat-hint muted' }, 'Drag a poster onto a day to plan it: green = showing (times posted), blue = expected from its release date, amber = not listed that day.'),
    grid);
  return box;
}

// ---- sheets for a planned showing and for a movie on a day ------------------------------------------

function showingSheet(g, o) {
  openSheet(
    el('div', { className: 'row between' }, el('h2', { style: 'margin:0' }, 'Showing'),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    showingCard(g, o, Date.now()));
}

function showingCard(g, o, now) {
  const past = isPast(o);
  const going = (o.attendees ?? []).slice().sort((a, b) => nameOf(g.members, a.user_id).localeCompare(nameOf(g.members, b.user_id)));
  const state = past ? 'past' : 'planned';

  const goer = (a) => {
    const name = nameOf(g.members, a.user_id);
    const acts = [
      el('button', { className: 'btn sm ghost', type: 'button', title: 'Seat', onclick: act(async () => {
        const seat = prompt(`Seat for ${name} (e.g. F12)`, a.seat ?? '');
        if (seat == null) return;
        await api.setAttendee(o.id, a.user_id, { seat: seat.trim().toUpperCase().slice(0, 20) || null });
      }) }, icon('seat'), a.seat ? a.seat : 'Seat'),
      el('button', { className: 'btn sm ghost danger', type: 'button', title: `Take ${name} off this showing`, onclick: act(() => api.removeAttendee(o.id, a.user_id), `${name} removed`) }, icon('x')),
    ];
    return el('div', { className: 'goer' }, avatar(name, true), el('span', { className: 'name' }, name),
      el('span', { className: `pill ${past ? 'watched' : 'planned'}` }, past ? 'Watched' : 'Going'),
      el('div', { className: 'acts' }, acts));
  };

  const notGoing = g.members.filter((m) => !going.some((a) => a.user_id === m.user_id));
  const title = o.movie_id ? link(`/movie/${o.movie_id}?week=${weekOf(o.show_date)}`, o.movie_name) : o.movie_name;
  const hhmm = (iso) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: o.tz }).format(new Date(iso));
  const timeIn = el('input', { type: 'time', value: hasTime(o) ? hhmm(o.starts_at) : '', ariaLabel: 'Showtime' });
  const timeRow = el('div', { className: 'settime' },
    el('span', { className: 'muted' }, hasTime(o) ? 'Time' : past ? 'No time set' : 'No time set (it counts for the day). Know it?'), timeIn,
    el('button', { className: 'btn sm ghost', type: 'button', onclick: () => { if (!timeIn.value) return toast('Pick a time first', true); act(() => api.setShowingTime(o, timeIn.value), 'Time saved')(); } }, 'Save time'),
    hasTime(o) && el('button', { className: 'btn sm ghost', type: 'button', onclick: act(() => api.setShowingTime(o, ''), 'Time cleared') }, 'Clear'));
  const dateIn = el('input', { type: 'date', value: o.show_date, min: STUBS_START, ariaLabel: 'Date' });
  const dateRow = el('div', { className: 'settime' }, el('span', { className: 'muted' }, 'Date'), dateIn,
    el('button', { className: 'btn sm ghost', type: 'button', onclick: () => {
      if (!isDay(dateIn.value)) return toast('Pick a date first', true);
      if (dateIn.value === o.show_date) return toast('That is its date already');
      moveTo(o, dateIn.value);
    } }, 'Change date'));
  const remove = el('button', {
    className: 'btn sm ghost danger', type: 'button',
    onclick: () => {
      if (!confirm(`Delete ${o.movie_name} on ${fmtDate(o.show_date)} for everyone on it? This can't be undone.`)) return;
      act(() => api.deleteOuting(o.id), `${o.movie_name} deleted`)();
    },
  }, icon('x'), 'Delete showing');
  const card = el('article', { className: 'showing' },
    poster(o.poster_url, o.movie_name),
    el('div', { className: 'showing-main' },
      el('div', { className: 'showing-title' }, title),
      el('div', { className: 'meta' },
        el('span', { className: 'when' }, whenLabel(o)),
        el('span', {}, o.theatre_name),
        o.format && o.format !== 'Standard' && fmtBadge(o.format)),
      past && el('p', { className: 'muted past-note' }, "This one's in the past. Fix its date, time or who went, or delete it if you didn't go."),
      el('div', { className: 'goers' }, going.map(goer)),
      dateRow,
      timeRow,
      !past && el('div', { className: 'moveto' }, el('span', { className: 'muted' }, 'Move to'),
        el('div', { className: 'moveto-days' }, Array.from({ length: 14 }, (_, i) => addDays(isoDay(), i)).filter((d) => d !== o.show_date).map((d) =>
          el('button', { className: 'btn sm ghost', type: 'button', onclick: () => moveTo(o, d) },
            d === isoDay() ? 'Today' : fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }))))),
      el('div', { className: 'showing-foot' },
        notGoing.map((m) => el('button', {
          className: 'btn sm ghost', type: 'button',
          onclick: act(() => api.planShowing({ id: o.id }, [m.user_id]), `${m.display_name} added`),
        }, icon('plus'), m.display_name)),
        !past && o.purchase_url && el('a', { className: 'btn sm ghost', href: o.purchase_url, target: '_blank', rel: 'noopener' }, icon('seat'), 'Seats on AMC', icon('ext')),
        remove)));
  card.dataset.state = state;
  return card;
}

/** A movie on a day: plan it for that day (no time needed), or pick one of its times. */
async function movieDaySheet(m, day, g) {
  const [shows, theatres, dayInfo] = await Promise.all([api.showtimes({ movie: m.id, date: day }), api.theatres(), api.days()]);
  const movie = (m.id != null && (await api.movie(m.id))) || m;
  const info = dayInfo.get(day);
  const future = day >= isoDay();
  const showing = shows.length > 0;
  const expected = !showing && !(info && info.count >= FULL_DAY) && expectedOn(movie, day);
  const t = theatres.find((x) => x.id === shows[0]?.theatreId) ?? theatres.find((x) => x.scrape) ?? theatres[0] ?? { id: null, name: 'AMC', tz: 'America/New_York' };
  const outing = {
    movie_id: movie.id ?? null, movie_name: movie.name, movie_slug: movie.slug ?? null, poster_url: movie.poster ?? null,
    theatre_id: t.id ?? null, theatre_name: t.name, show_date: day, tz: t.tz ?? 'America/New_York',
  };
  const existing = g.outings.find((o) => o.show_date === day && !o.starts_at && o.movie_name === movie.name);
  if (existing) outing.id = existing.id;
  const already = new Set((existing?.attendees ?? []).map((a) => a.user_id));
  const who = future ? whoPicker(g, outing, already) : null;
  const save = el('button', { className: 'btn primary', type: 'button' }, icon('plus'), `Plan it for ${day === isoDay() ? 'today' : fmtDate(day, { weekday: 'long' })}`);
  save.onclick = async () => {
    const people = who.picked();
    if (!people.length) return toast('Pick who is going', true);
    save.setAttribute('aria-disabled', 'true');
    try {
      await api.planShowing(outing, people, who.status());
      toast(`${movie.name} planned for ${fmtDate(day)}`);
      closeSheet();
      render();
    } catch (e) {
      toast(e.message, true);
      save.removeAttribute('aria-disabled');
    }
  };
  openSheet(
    el('div', { className: 'sheet-head' },
      poster(movie.poster, movie.name),
      el('div', {},
        el('h2', {}, movie.name),
        el('p', { className: 'when big' }, fmtDate(day, { weekday: 'long', month: 'long', day: 'numeric' })),
        el('div', { className: 'meta' }, [movie.rating, fmtRun(movie.runTime)].filter(Boolean).map((x) => el('span', {}, x)),
          el('span', { className: `pill ${showing ? 'reserved' : expected ? 'expect' : 'warn'}` },
            showing ? `Showing that day (${shows.length})` : expected ? 'Expected that day' : info && info.count >= FULL_DAY ? 'Not listed that day' : 'Not posted yet'),
          movie.release && el('span', {}, opensLabel(movie)))),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    expected && el('section', { className: 'panel notice expectbox' }, icon('ticket'), el('p', {},
      el('b', {}, `${opensLabel(movie)}. `),
      el('span', { className: 'muted' }, `AMC hasn't posted times for ${fmtDate(day)} yet, but it should be on by then. Plan it now; times show up here once they're posted.`))),
    !showing && !expected && el('section', { className: 'panel notice warnbox' }, icon('warn'), el('p', {},
      el('b', {}, info && info.count >= FULL_DAY ? `AMC doesn't list it on ${fmtDate(day)}. ` : `AMC hasn't posted ${fmtDate(day)} for it yet. `),
      el('span', { className: 'muted' }, future ? 'You can still plan it if you know it is on (say you already have tickets).' : ''))),
    future && el('section', {}, el('h3', {}, "Who's going"), who.node),
    future && el('div', { className: 'row' }, save),
    future && el('p', { className: 'muted' }, "No time needed: it takes one of that A-List week's admissions either way, and you can add the time later."),
    showing && el('details', { className: 'times-more' }, el('summary', {}, `Or pick one of its ${shows.length} showtimes`),
      byTheatre(shows, theatres, (list, th) => showtimeGroups(list, th, movie, g))),
    el('div', { className: 'row' },
      movie.id != null && el('a', { className: 'btn ghost sm', href: `/movie/${movie.id}?week=${weekOf(day)}` }, 'Its whole week'),
      el('button', { className: 'btn ghost sm', type: 'button', onclick: () => manualSheet(g, { movie: movie.name, day }) }, icon('plus'), 'Add by hand')));
}

// ---- movies ---------------------------------------------------------------------------------

/** "All" plus each A-List week that has stored showtimes (and this/next week, and `also`). */
function weekTabs(shows, selected, onPick, also = []) {
  const now = weekOf(isoDay());
  const weeks = [...new Set([now, addWeeks(now, 1), ...shows.map((s) => weekOf(s.date)), ...also].filter(Boolean))].filter((w) => w >= now).sort();
  return el('div', { className: 'tabs', role: 'tablist' },
    [['', 'All days'], ...weeks.map((w) => [w, weekTitle(w)])].map(([w, label]) =>
      el('button', { className: `btn${w === selected ? ' nav-active' : ''}`, type: 'button', role: 'tab', ariaSelected: String(w === selected), onclick: () => onPick(w) },
        label, w && el('small', { className: 'tab-sub' }, weekLabel(w).replace(/^\w+,?\s/, '').replace(/ – \w+,?\s/, ' – ')))));
}

async function moviesPage() {
  const week = isFriday(query().get('week')) ? query().get('week') : '';
  const [members, wants, all, shows, fresh] = await Promise.all([api.members(), api.wants(), api.movies(), api.showtimes(), api.freshness()]);
  const inRange = week ? shows.filter((s) => weekOf(s.date) === week) : shows;
  const daysFor = new Map(), countFor = new Map();
  for (const s of inRange) {
    (daysFor.get(s.movieId) ?? daysFor.set(s.movieId, new Set()).get(s.movieId)).add(s.date);
    countFor.set(s.movieId, (countFor.get(s.movieId) ?? 0) + 1);
  }
  const today = isoDay();
  // for a chosen week: also the movies expected that week by their release date (AMC posts times about a week out)
  const expWeek = (m) => !!week && weekDays(week).some((d) => d >= today && expectedOn(m, d));
  const showing = all.filter((m) => daysFor.has(m.id) || (expWeek(m) && m.kind !== 'event'))
    .sort((a, b) => (countFor.get(b.id) ?? 0) - (countFor.get(a.id) ?? 0) || String(a.release).localeCompare(String(b.release)) || a.name.localeCompare(b.name));
  const soon = all.filter((m) => !showing.includes(m) && m.release > today).sort((a, b) => a.release.localeCompare(b.release) || a.name.localeCompare(b.name));
  const others = all.filter((m) => !showing.includes(m) && !soon.includes(m)).sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
  const href = (m) => `/movie/${m.id}${week ? `?week=${week}` : ''}`;

  // drag a movie onto the bottom bar to star or unstar it
  const mine = new Set(wants.filter((w) => w.user_id === me.id).map((w) => w.movie_id));
  dock({
    accepts: 'movie', label: 'Drop to star or unstar it', iconNode: () => el('span', { className: 'star' }, '★'),
    onDrop: (m) => act(() => (mine.has(m.id) ? api.unwant(me.id, m.id) : api.want(m)), mine.has(m.id) ? `${m.name} taken off your wishlist` : `${m.name} added to your wishlist`)(),
  });

  const search = el('input', { type: 'search', placeholder: 'Search titles', ariaLabel: 'Search titles' });
  const grid = el('ul', { className: 'movies' });
  const older = el('ul', { className: 'movies' });
  const olderHead = el('h2', { className: 'section' }, week ? 'Not showing that week' : 'Seen earlier');
  const soonList = el('ul', { className: 'movies' });
  const soonHead = el('h2', { className: 'section' }, 'Coming soon');
  const card = (m, i, sub) => el('li', { style: `--i:${Math.min(i, 30)}` }, movieCard(m, members, wants, sub, href(m)));
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hit = (m) => !q || m.name.toLowerCase().includes(q);
    const a = showing.filter(hit), b = others.filter(hit), c = soon.filter(hit);
    soonList.replaceChildren(...c.map((m, i) => card(m, i, [opensLabel(m, today), m.kind === 'event' ? 'event' : m.kind === 'reissue' ? 'reissue' : null].filter(Boolean).join(' · '))));
    soonHead.hidden = !c.length;
    grid.replaceChildren(...(a.length ? a.map((m, i) => card(m, i, daysFor.has(m.id) ? `${daysLabel([...daysFor.get(m.id)])} · ${countFor.get(m.id)} times` : `Expected · ${opensLabel(m, today)}`))
      : [el('li', { className: 'empty' }, q ? 'No movies match.' : week ? "No showtimes stored for that week yet. Days fill in a day or two ahead." : 'Nothing stored yet.')]));
    older.replaceChildren(...b.map((m, i) => card(m, i, null)));
    olderHead.hidden = !b.length;
  };
  search.oninput = draw;
  draw();
  view(heading(week ? `${weekTitle(week)} · ${weekLabel(week)}` : 'AMC Theatres', 'Movies', search), freshBanner(fresh),
    weekTabs(shows, week, (w) => setQuery({ week: w })),
    el('h2', { className: 'section' }, week ? 'Showing that week' : 'Showing'), grid, soonHead, soonList, olderHead, older);
}

function movieCard(m, members, wants, sub = null, href = `/movie/${m.id}`) {
  const who = wants.filter((w) => w.movie_id === m.id);
  const mine = who.some((w) => w.user_id === me.id);
  const btn = el('button', {
    className: 'btn wantbtn', type: 'button', ariaPressed: String(mine),
    onclick: async (e) => {
      e.preventDefault();
      try {
        if (mine) await api.unwant(me.id, m.id); else await api.want(m);
        toast(mine ? 'Taken off your wishlist' : 'Added to your wishlist');
        render();
      } catch (err) { toast(err.message, true); }
    },
  }, mine ? '★ Want' : '☆ Want');
  const art = draggable(el('a', { href, ariaLabel: m.name, className: 'poster-link' }, poster(m.poster, m.name)), {
    type: 'movie', data: m, ghost: () => el('span', { className: 'poster-ghost' }, poster(m.poster, m.name)),
  });
  return el('div', { className: 'movie-card' },
    art,
    el('a', { className: 'movie-name', href, style: 'color:inherit' }, m.name),
    el('span', { className: 'movie-sub' }, [m.rating, fmtRun(m.runTime)].filter(Boolean).join(' · ')),
    sub && el('span', { className: 'movie-sub strong' }, sub),
    el('span', { className: 'wantrow' }, btn, el('span', { className: 'faces' }, who.map((w) => avatar(nameOf(members, w.user_id), true)))));
}

// ---- one movie: its showtimes, day by day ---------------------------------------------------------

async function moviePage(id) {
  const movieId = Number(id);
  const week = isFriday(query().get('week')) ? query().get('week') : '';
  const [theatres, g, wants, found, shows, dayInfo, fresh] = await Promise.all([
    api.theatres(), groupData(), api.wants(), api.movie(movieId), api.showtimes({ movie: movieId }), api.days(), api.freshness()]);
  // a wishlist movie the scraper hasn't listed (yet, or any more) still gets a page
  const w = wants.find((x) => x.movie_id === movieId);
  const m = found ?? (w && { id: w.movie_id, name: w.movie_name, slug: w.movie_slug, poster: w.poster_url });
  if (!m) return view(panel('Movie not found', el('p', { className: 'muted' }, 'The scraper has not seen this movie. ', link('/movies', 'Back to movies'))));
  const who = wants.filter((x) => x.movie_id === m.id);
  const today = isoDay();

  const hero = el('section', { className: 'movie-hero' },
    poster(m.poster, m.name),
    el('div', {},
      el('p', { className: 'eyebrow' }, el('span', { className: 'dot' }), [opensLabel(m), shows.length ? `${shows.length} showtimes over ${new Set(shows.map((s) => s.date)).size} days` : 'no showtimes posted yet'].filter(Boolean).join(' · ')),
      el('h1', {}, m.name),
      el('div', { className: 'meta' }, [m.rating, fmtRun(m.runTime)].filter(Boolean).map((t) => el('span', {}, t))),
      el('div', { className: 'row', style: 'margin-top:14px' },
        movieCard(m, g.members, wants).querySelector('.wantrow'),
        who.length ? el('span', { className: 'muted' }, `Wanted by ${who.map((x) => nameOf(g.members, x.user_id)).join(', ')}`) : null,
        m.slug && el('a', { className: 'btn sm ghost', href: `https://www.amctheatres.com/movies/${m.slug}`, target: '_blank', rel: 'noopener' }, 'AMC page', icon('ext')))));

  // the days to list: a chosen week shows all seven (so gaps are visible), otherwise every day with showtimes, or for a
  // movie with nothing posted yet, its first week (from its release date)
  const firstWeek = !shows.length && m.release ? weekDays(weekOf(m.release > today ? m.release : today)).filter((d) => d >= today) : [];
  const days = week ? weekDays(week).filter((d) => d >= today) : shows.length ? [...new Set(shows.map((s) => s.date))].sort() : firstWeek;
  const full = (d) => (dayInfo.get(d)?.count ?? 0) >= FULL_DAY;
  const expect = (d) => !shows.some((s) => s.date === d) && !full(d) && expectedOn(m, d);
  const sectionId = (d) => `day-${d}`;
  const jump = days.length > 1 && el('nav', { className: 'jumpbar', ariaLabel: 'Days' }, days.map((d) => {
    const n = shows.filter((s) => s.date === d).length;
    return el('button', {
      className: `jump${n ? '' : ' none'}${d === today ? ' today' : ''}`, type: 'button',
      onclick: () => document.getElementById(sectionId(d))?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, el('span', {}, d === today ? 'Today' : weekdayOf(d)), el('b', {}, Number(d.slice(8))), el('small', {}, n ? `${n}` : expect(d) ? 'exp' : full(d) ? '–' : '?'));
  }));

  let lastWeek = null;
  const sections = days.flatMap((d) => {
    const list = shows.filter((s) => s.date === d);
    const info = dayInfo.get(d);
    const out = [];
    if (!week && weekOf(d) !== lastWeek) {
      lastWeek = weekOf(d);
      out.push(el('h2', { className: 'section weekmark' }, weekTitle(lastWeek), el('span', { className: 'muted' }, ` · ${weekLabel(lastWeek)}`)));
    }
    out.push(el('section', { className: `daysec${list.length ? '' : expect(d) ? ' expect-day' : ' empty-day'}`, id: sectionId(d) },
      el('div', { className: 'daysec-head' },
        el('h3', {}, fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' }), d === today && el('span', { className: 'pill planned' }, 'Today')),
        el('span', { className: 'muted' }, info ? `checked ${ago(info.checked)}` : 'not read yet'),
        el('a', { className: 'btn sm ghost', href: `/?date=${d}` }, 'See that week')),
      list.length
        ? [el('div', { className: 'row' }, el('button', { className: 'btn sm primary', type: 'button', onclick: () => movieDaySheet(m, d, g) }, icon('plus'), `Plan it for ${d === today ? 'today' : weekdayOf(d)}`),
          el('span', { className: 'muted' }, 'or pick a time:')),
          byTheatre(list, theatres, (l, t) => showtimeGroups(l, t, m, g))]
        : expect(d)
          ? el('div', { className: 'row' }, el('button', { className: 'btn sm primary', type: 'button', onclick: () => movieDaySheet(m, d, g) }, icon('plus'), `Plan it for ${d === today ? 'today' : weekdayOf(d)}`),
            el('span', { className: 'muted' }, `Expected (${opensLabel(m)}); times not posted yet.`))
        : el('p', { className: 'muted' }, full(d) ? 'Not showing this day.' : info ? 'Not posted for this day yet. ' : "This day hasn't been read from AMC yet. ",
          el('button', { className: 'btn sm ghost', type: 'button', onclick: () => movieDaySheet(m, d, g) }, 'Plan anyway'),
          el('button', { className: 'btn sm ghost', type: 'button', onclick: () => manualSheet(g, { movie: m.name, day: d }) }, icon('plus'), 'Add by hand'))));
    return out;
  });

  view(hero, freshBanner(fresh),
    weekTabs(shows, week, (x) => setQuery({ week: x }), [week, m.release && m.release >= today ? weekOf(m.release) : null]),
    jump,
    sections.length ? sections : el('p', { className: 'empty' }, 'No showtimes stored for this movie yet. Days fill in a day or two ahead; ',
      el('button', { className: 'btn sm ghost', type: 'button', onclick: () => manualSheet(g, { movie: m.name }) }, icon('plus'), 'add it by hand'), ' meanwhile.'));
}

/** Split showtimes by theatre (a heading only when there's more than one). */
function byTheatre(list, theatres, draw) {
  const groups = new Map();
  for (const s of list) (groups.get(s.theatreId) ?? groups.set(s.theatreId, []).get(s.theatreId)).push(s);
  const tOf = (id) => theatres.find((t) => t.id === id) ?? { id, name: 'AMC', tz: 'America/New_York' };
  if (groups.size === 1) {
    const [[tid, l]] = groups;
    return el('div', { className: 'one-theatre' }, el('div', { className: 'muted tname' }, tOf(tid).name), draw(l, tOf(tid)));
  }
  return [...groups].map(([tid, l]) => el('div', { className: 'theatre-sub' }, el('h4', {}, link(`/theatre/${tid}`, tOf(tid).name)), draw(l, tOf(tid))));
}

/** Showtime buttons grouped by format (with AMC-style badges). Opens the showtime sheet on click. */
function showtimeGroups(showtimes, t, movie, g) {
  if (!showtimes.length) return el('p', { className: 'muted' }, 'No showtimes this day.');
  const byFmt = new Map();
  for (const s of showtimes.slice().sort((a, b) => a.utc.localeCompare(b.utc))) {
    const key = `${s.format}|${shortTags(s.tags).join(',')}`;
    (byFmt.get(key) ?? byFmt.set(key, []).get(key)).push(s);
  }
  const goingTo = new Map(g.outings.filter((o) => o.showtime_id).map((o) => [Number(o.showtime_id), o]));
  return el('div', { className: 'fmts' }, [...byFmt.values()].map((list) => el('div', { className: 'fmt' },
    el('div', { className: 'fmt-name' }, fmtBadge(list[0].format, list[0].tags),
      shortTags(list[0].tags).map((x) => el('span', { className: `tagchip${x === 'Not A-List' ? ' bad' : ''}` }, x))),
    el('div', { className: 'times' }, list.map((s) => {
      const past = new Date(s.utc) <= Date.now();
      const o = goingTo.get(s.id);
      const n = o ? (o.attendees ?? []).length : 0;
      return el('button', {
        className: `time${s.soldOut ? ' sold' : ''}${n ? ' going' : ''}${past ? ' past' : ''}${s.alistExcluded ? ' excluded' : ''}`,
        type: 'button', disabled: past,
        title: [...new Set([s.alistExcluded && 'Excluded from A-List', ...s.tags].filter(Boolean))].join(', '),
        onclick: () => (s.soldOut && !n ? toast('Sold out', true) : showtimeSheet(s, t, movie, g)),
      }, fmtTime(s.utc, t.tz), el('small', {}, n ? `${n} going` : s.soldOut ? 'Sold out' : s.alistExcluded ? 'Not A-List' : ' '));
    })))));
}

// ---- one day (all our theatres) or one theatre ---------------------------------------------------

async function dayPage(date, theatreId = null) {
  const [theatres, g, all, fresh, movieList, dayInfo] = await Promise.all([
    api.theatres(), groupData(), api.showtimes(theatreId != null ? { theatre: theatreId } : {}), api.freshness(), api.movies(), api.days()]);
  const t = theatreId != null ? theatres.find((x) => x.id === theatreId) : null;
  if (theatreId != null && !t) return view(panel('Theatre not found', el('p', {}, link('/theatres', 'Back to theatres'))));
  const today = isoDay();
  if (!date) date = isDay(query().get('date')) ? query().get('date') : today;
  // a strip of the two weeks around this day, so empty or unread days show up too
  const days = weekDays(weekOf(date)).concat(weekDays(addWeeks(weekOf(date), 1))).filter((d) => d >= today);
  const hrefFor = (d) => (t ? `/theatre/${t.id}${d === today ? '' : `?date=${d}`}` : `/?date=${d}`);
  const strip = el('div', { className: 'dates', role: 'group', ariaLabel: 'Date' }, days.map((d) => {
    const n = all.filter((s) => s.date === d).length;
    return el('a', { className: `date${n ? '' : ' none'}`, href: hrefFor(d), ariaCurrent: d === date ? 'date' : null },
      d === today ? 'Today' : weekdayOf(d), el('b', {}, Number(d.slice(8))), el('small', {}, n ? `${n}` : dayInfo.has(d) ? '–' : '?'));
  }));

  const showtimes = all.filter((s) => s.date === date);
  const movies = new Map(movieList.map((m) => [m.id, m]));
  const planned = g.outings.filter((o) => o.show_date === date);
  const byMovie = new Map();
  for (const s of showtimes) (byMovie.get(s.movieId) ?? byMovie.set(s.movieId, []).get(s.movieId)).push(s);
  const blocks = [...byMovie.values()].sort((a, b) => a[0].movieName.localeCompare(b[0].movieName)).map((list) => {
    const s0 = list[0], m = movies.get(s0.movieId) ?? { id: s0.movieId, name: s0.movieName, slug: s0.movieSlug, runTime: s0.runTime };
    return el('section', { className: 'theatre-block movie-block' },
      el('a', { className: 'mb-poster', href: `/movie/${m.id}?week=${weekOf(date)}` }, poster(m.poster, m.name)),
      el('div', {},
        el('h3', {}, link(`/movie/${m.id}?week=${weekOf(date)}`, m.name)),
        el('div', { className: 'muted' }, [m.rating, fmtRun(m.runTime)].filter(Boolean).join(' · ')),
        byTheatre(list, theatres, (l, th) => showtimeGroups(l, th, m, g))));
  });
  const info = dayInfo.get(date);
  view(
    heading(t ? t.name : 'Everything on', fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' })),
    freshBanner(fresh), strip,
    planned.length > 0 && el('p', { className: 'muted' }, 'Planned that day: ', planned.map((o) => `${o.movie_name} ${hasTime(o) ? `at ${fmtTime(o.starts_at, o.tz)}` : '(any time)'}`).join(', ')),
    blocks.length ? blocks : el('p', { className: 'empty' },
      t && !t.scrape ? 'The scraper is switched off for this theatre. Switch it on from the Theatres page.'
        : info ? 'No showtimes this day.' : "This day hasn't been read from AMC yet; it fills in within a day or two."));
}

// ---- the showtime sheet: who's going, add to plan ----------------------------------------------

const sheet = $('sheet');
function openSheet(...nodes) {
  $('sheet-body').replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
{
  // on a phone the sheet slides up from the bottom; pull it down by its top edge to close it
  let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    if (!phone.matches || sheet.scrollTop > 0 || e.touches[0].clientY - sheet.getBoundingClientRect().top > 64) return;
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    sheet.style.transform = '';
    if (dy > 90) closeSheet();
  });
}

/** People checkboxes that re-check the A-List rules for each person as the status changes. */
function whoPicker(g, outing, alreadyGoing = new Set()) {
  let status = 'planned';
  const boxes = new Map();
  const list = el('div', { className: 'who' });
  const draw = () => {
    list.replaceChildren(...g.members.map((m) => {
      const already = alreadyGoing.has(m.user_id);
      const check = canAttend(g.of(m.user_id), outing, status);
      const box = boxes.get(m.user_id) ?? el('input', { type: 'checkbox', checked: m.user_id === me.id && !already && check.ok });
      boxes.set(m.user_id, box);
      box.disabled = already || !check.ok;
      if (box.disabled) box.checked = already;
      const why = already ? el('span', { className: 'why good' }, 'Already going')
        : !check.ok ? el('span', { className: 'why bad' }, check.problems.join(' · '))
        : check.notes.length ? el('span', { className: 'why warn' }, check.notes.join(' · '))
        : el('span', { className: 'why muted' }, `${standing(g.of(m.user_id)).byWeek[weekOfShowing(outing)] ?? 0} of ${PER_WEEK} used that week`);
      return el('label', { className: box.disabled && !already ? 'blocked' : '' }, box, avatar(m.display_name, true), el('span', {}, m.display_name, m.user_id === me.id ? ' (you)' : ''), why);
    }));
  };
  draw();
  return {
    node: el('div', { className: 'stack', style: 'display:grid;gap:10px' }, list),
    picked: () => [...boxes].filter(([, b]) => b.checked && !b.disabled).map(([id]) => id),
    status: () => status,
  };
}

function showtimeSheet(s, t, movie, g) {
  const outing = {
    showtime_id: s.id, movie_id: s.movieId, movie_name: s.movieName, movie_slug: s.movieSlug ?? movie?.slug ?? null,
    poster_url: movie?.poster ?? null, theatre_id: t.id, theatre_name: t.name, auditorium: s.auditorium,
    format: s.format, show_date: s.date, starts_at: s.utc, ends_at: new Date(Date.parse(s.utc) + (s.runTime || movie?.runTime || 150) * 60e3).toISOString(),
    tz: t.tz, purchase_url: s.purchaseUrl,
  };
  const existing = g.outings.find((o) => Number(o.showtime_id) === s.id);
  if (existing) outing.id = existing.id;
  const already = new Set((existing?.attendees ?? []).map((a) => a.user_id));
  const who = whoPicker(g, outing, already);

  const excluded = s.alistExcluded && el('section', { className: 'panel notice warnbox' }, icon('warn'),
    el('p', {}, el('b', {}, 'Excluded from A-List. '), el('span', { className: 'muted' }, 'AMC lists this showing as not covered by A-List, so it would be a paid ticket. Planning it here still counts it against the week.')));

  const save = el('button', { className: 'btn primary', type: 'button' }, icon('plus'), 'Add to plan');
  save.onclick = async () => {
    const people = who.picked();
    if (!people.length) return toast('Pick who is going', true);
    save.setAttribute('aria-disabled', 'true');
    try {
      await api.planShowing(outing, people, who.status());
      toast(people.length > 1 ? 'Added for everyone' : 'Added to the plan');
      closeSheet();
      render();
    } catch (e) {
      toast(e.message, true);
      save.removeAttribute('aria-disabled');
    }
  };

  openSheet(
    el('div', { className: 'sheet-head' },
      poster(outing.poster_url, s.movieName),
      el('div', {},
        el('h2', {}, s.movieName),
        el('p', { className: 'when big' }, fmtDate(s.date, { weekday: 'long', month: 'long', day: 'numeric' }), ' · ', fmtTime(s.utc, t.tz)),
        el('div', { className: 'meta' }, fmtBadge(s.format, s.tags), el('span', {}, t.name), shortTags(s.tags).map((x) => el('span', { className: 'tagchip' }, x)))),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    excluded,
    el('section', {}, el('h3', {}, 'Seats'),
      el('p', { className: 'muted' }, s.soldOut ? 'AMC lists this showing as sold out. ' : '',
        el('a', { href: s.purchaseUrl, target: '_blank', rel: 'noopener' }, 'Open the live seat map on AMC ', icon('ext')))),
    el('section', {}, el('h3', {}, "Who's going"), who.node),
    el('div', { className: 'row' }, save,
      el('a', { className: 'btn ghost', href: s.purchaseUrl, target: '_blank', rel: 'noopener' }, 'Reserve on AMC', icon('ext'))),
    el('p', { className: 'muted' }, 'Adding here plans it for the group. Book the seats in the AMC app (your entourage can book for each other there).'));
}

// ---- adding a showing by hand (any day, any theatre) ----------------------------------------------

async function manualSheet(g, prefill = {}) {
  const [theatres, known] = await Promise.all([api.theatres().catch(() => []), api.movies().catch(() => [])]);
  const list = el('datalist', { id: 'known-movies' }, known.map((m) => new Option(m.name)));
  const movie = el('input', { required: true, maxLength: 200, placeholder: 'Movie title', value: prefill.movie ?? '' });
  movie.setAttribute('list', 'known-movies');
  const theatreSel = el('select', {}, theatres.map((t) => new Option(t.name, String(t.id))), new Option('Other…', ''));
  const theatreName = el('input', { maxLength: 200, placeholder: 'AMC theatre name', hidden: theatres.length > 0 });
  theatreSel.onchange = () => { theatreName.hidden = theatreSel.value !== ''; recheck(); };
  const day = el('input', { type: 'date', value: prefill.day ?? isoDay(), required: true });
  const time = el('input', { type: 'time', value: '' });
  const run = el('input', { type: 'number', min: 30, max: 400, value: 150, inputMode: 'numeric' });
  const fmt = el('select', {}, ['Standard', 'Laser at AMC', 'IMAX with Laser at AMC', 'Dolby Cinema at AMC', 'PRIME at AMC', 'RealD 3D', 'Other'].map((f) => new Option(f, f)));
  const match = () => known.find((m) => m.name.toLowerCase() === movie.value.trim().toLowerCase());
  const fillRun = () => { const m = match(); if (m?.runTime) run.value = m.runTime; };
  movie.addEventListener('change', () => { fillRun(); recheck(); });
  fillRun();

  const outing = () => {
    const t = theatres.find((x) => String(x.id) === theatreSel.value);
    const tz = t?.tz ?? localTz();
    const m = match();
    const o = {
      movie_name: m?.name ?? movie.value.trim(), movie_id: m?.id ?? null, movie_slug: m?.slug ?? null, poster_url: m?.poster ?? null,
      theatre_id: t?.id ?? null, theatre_name: t?.name ?? theatreName.value.trim(), format: fmt.value, tz, show_date: day.value,
    };
    if (time.value) { // after midnight counts as the night before
      const start = wallToUtc(time.value < '05:00' ? addDays(day.value, 1) : day.value, time.value, tz);
      o.starts_at = start.toISOString();
      o.ends_at = new Date(start.getTime() + (Math.min(400, Math.max(30, +run.value || 150))) * 60e3).toISOString();
    }
    return o;
  };
  const whoWrap = el('div');
  let who;
  const recheck = () => { if (day.value) { who = whoPicker(g, outing()); whoWrap.replaceChildren(who.node); } };
  for (const x of [day, time, run]) x.addEventListener('change', recheck);
  recheck();

  const save = el('button', { className: 'btn primary', type: 'button' }, icon('plus'), 'Add to plan');
  save.onclick = async () => {
    const o = outing();
    if (!o.movie_name) return toast('Enter the movie', true);
    if (!o.theatre_name) return toast('Enter the theatre', true);
    const people = who.picked();
    if (!people.length) return toast('Pick who is going', true);
    try {
      await api.planShowing(o, people, who.status());
      toast('Added to the plan');
      closeSheet();
      render();
    } catch (e) { toast(e.message, true); }
  };

  openSheet(
    el('div', { className: 'row between' }, el('h2', { style: 'margin:0' }, 'Add a showing by hand'),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    el('div', { className: 'form' },
      el('div', { className: 'wide' }, field('Movie', movie), list),
      field('Theatre', theatreSel), !theatres.length ? field('Theatre name', theatreName) : el('div', {}, theatreName),
      field('Date', day), field('Start time (optional)', time), field('Runtime (minutes)', run), field('Format', fmt)),
    el('section', {}, el('h3', {}, "Who's going"), whoWrap),
    el('div', { className: 'row' }, save));
  requestAnimationFrame(() => (prefill.movie ? time : movie).focus());
}

// ---- theatres -------------------------------------------------------------------------------

async function theatresPage() {
  const saved = await api.theatres();
  view(heading('Where we watch', 'Theatres'),
    el('p', { className: 'muted' }, "The scraper runs every hour and reads one day per theatre switched on here: today first, then days someone has planned something on, then every date AMC lists (months out, for advance tickets), nearest and stalest first. AMC's site lets one page through per run, so keep it to one theatre."),
    saved.length
      ? table([
        { label: 'Theatre', val: (t) => t.name, cell: (t) => link(`/theatre/${t.id}`, t.name), num: false },
        { label: 'Where', val: (t) => [t.city, t.state].filter(Boolean).join(', '), num: false },
        { label: 'Updated', val: (t) => t.last_scraped_at ?? '', cell: (t) => ago(t.last_scraped_at), num: false },
        { label: 'Scrape', val: (t) => (t.scrape ? 1 : 0), cell: (t) => el('button', {
          className: `btn sm ${t.scrape ? 'primary' : 'ghost'}`, type: 'button', ariaPressed: String(t.scrape),
          onclick: async () => {
            try { await api.setScrape(t.id, !t.scrape); toast(t.scrape ? `${t.name} switched off` : `${t.name} switched on`); render(); } catch (e) { toast(e.message, true); }
          },
        }, t.scrape ? 'On' : 'Off') },
        { label: '', val: () => '', cell: (t) => t.slug && t.market && el('a', { className: 'btn sm ghost', href: `https://www.amctheatres.com/movie-theatres/${t.market}/${t.slug}/showtimes`, target: '_blank', rel: 'noopener' }, 'AMC', icon('ext')) },
      ], saved)
      : el('p', { className: 'empty' }, 'No theatres set up.'));
}

// ---- history --------------------------------------------------------------------------------

async function historyPage() {
  const g = await groupData();
  const now = Date.now();
  const past = g.outings.filter(isPast).sort(byShowing).reverse();
  const watched = (id) => g.of(id).filter(isPast);
  const year = String(new Date().getFullYear());
  view(heading('Everything so far', 'History'),
    el('div', { className: 'tiles' }, g.members.flatMap((m) => [
      stat(`${m.display_name} · all time`, watched(m.user_id).length),
      stat(`${m.display_name} · ${year}`, watched(m.user_id).filter((a) => a.show_date.startsWith(year)).length),
    ])),
    table([
      { label: 'When', val: (o) => showingKey(o), cell: (o) => whenLabel(o) },
      { label: 'Movie', val: (o) => o.movie_name, cell: (o) => (o.movie_id ? link(`/movie/${o.movie_id}`, o.movie_name) : o.movie_name), num: false },
      { label: 'Theatre', val: (o) => o.theatre_name, num: false },
      { label: 'Format', val: (o) => o.format ?? '', cell: (o) => (o.format ? fmtBadge(o.format) : '–'), num: false },
      { label: 'Who', val: (o) => (o.attendees ?? []).map((a) => nameOf(g.members, a.user_id)).join(', '), num: false },
      { label: '', val: () => '', cell: (o) => el('button', { className: 'btn sm ghost', type: 'button', title: 'Fix its date, time or who went, or delete it', onclick: () => showingSheet(g, o) }, 'Edit'), num: false },
    ], past, { sortCol: 0 }));
}

// ---- rules ----------------------------------------------------------------------------------

function rulesPage() {
  view(heading('AMC Stubs A-List', 'The rules'),
    panel(null,
      el('ol', { className: 'rules' },
        el('li', {}, el('b', {}, `Up to ${PER_WEEK} movies a week`), ', in any format (IMAX, Dolby Cinema and PRIME included). An A-List week runs ', el('b', {}, 'Friday 6:00 AM to the next Friday 5:59 AM'), '. Unused weeks don\'t carry over, and a no-show still counts.'),
        el('li', {}, el('b', {}, `No more than ${PENDING} reservations at a time`), ', whatever weeks they are in. Once you hold 4, you can\'t book another until one has been used or cancelled.'),
        el('li', {}, el('b', {}, 'Same day is fine'), ' as long as the showtimes don\'t overlap.'),
        el('li', {}, el('b', {}, 'Entourage'), ': A-List members can invite each other and make reservations on one another\'s behalf in the AMC app.'),
        el('li', {}, 'Special events (fan events, marathons, the Met Opera, sports broadcasts and some others) aren\'t covered.')),
      el('p', { className: 'muted', style: 'margin-top:16px' }, 'From AMC\'s ', el('a', { href: TERMS_URL, target: '_blank', rel: 'noopener' }, 'A-List terms and conditions'), ', checked November 2026.')),
    panel('How the planner uses them',
      el('ul', { className: 'rules' },
        el('li', {}, 'Every showing someone is on takes one of their 4 for that A-List week (by its date). Adding a fifth is refused.'),
        el('li', {}, 'Overlapping showings for the same person are refused, when both have a time (a showing lasts its runtime).'),
        el('li', {}, "The planner doesn't track bookings, so the 4-at-a-time reservation limit is up to the AMC app."),
        el('li', {}, 'Taking someone off a showing frees the admission again. The database checks every rule, so nothing can slip past from two phones at once.'))));
}

render();
