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
import { PER_WEEK, PENDING, TERMS_URL, alistWeek, addWeeks, weekLabel, standing, canAttend, localTz, wallToUtc } from './rules.js';
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
function drawNav() {
  const here = location.pathname;
  const active = (p) => (p === '/' ? here === '/' : here === p || here.startsWith(`${p}/`) || (p === '/movies' && here.startsWith('/movie/')) || (p === '/theatres' && here.startsWith('/theatre/')));
  $('nav').replaceChildren(...NAV.map(([p, label]) => el('a', { className: `btn${active(p) ? ' nav-active' : ''}`, href: p }, label)));
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
    else if (first === 'day' && isDay(id)) go(`/?view=day&date=${id}`, { replace: true });
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

// ---- shared data ----------------------------------------------------------------------------

/** Members, outings and everyone's admissions in one go. */
async function groupData() {
  const [members, outings] = await Promise.all([api.members(), api.outings()]);
  const admissions = outings.flatMap((o) => (o.attendees ?? []).map((a) => ({
    outing_id: o.id, user_id: a.user_id, status: a.status, seat: a.seat,
    starts_at: o.starts_at, ends_at: o.ends_at, tz: o.tz, movie_name: o.movie_name,
  })));
  const of = (userId) => admissions.filter((a) => a.user_id === userId);
  return { members, outings, admissions, of };
}

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
    `Showtimes from amctheatres.com, last update ${ago(ok.finished_at)}. Each update reads one day: today every morning, the next two weeks in turn.`,
    failedSince && el('span', { className: 'muted' }, ` Last update failed: ${f.last.error ?? 'unknown error'}`));
}

// ---- plan: a calendar (day / week / month / year) with the movie catalog beside it -------------------
// The calendar is on the left, the catalog of posters on the right (along the bottom on a phone). Drag a poster
// onto a day: if the movie has showtimes that day you pick one; if not (not showing, or the day isn't read yet) it
// is pencilled in with a warning until a real showing is planned.

const MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
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
  const [g, wants, movies, shows, dayInfo, theatres, picks] = await Promise.all([
    groupData(), api.wants(), api.movies(), api.showtimes(), api.days(), api.theatres(), api.picks()]);
  const ctx = {
    g, wants, movies, shows, dayInfo, theatres, picks, today, date, mode,
    movieById: new Map(movies.map((m) => [m.id, m])),
    showsByDay: groupBy(shows, (s) => s.date),
    plansByDay: groupBy(g.outings.slice().sort((a, b) => a.starts_at.localeCompare(b.starts_at)), (o) => isoDay(o.starts_at)),
    picksByDay: groupBy(picks, (p) => p.day),
  };
  ctx.range = mode === 'day' ? [date] : mode === 'week' ? weekDays(weekOf(date)) : mode === 'month' ? monthDays(date) : null;

  dock({
    accepts: 'attendee', kind: 'danger', label: 'Drop here to take them off the showing', iconNode: () => icon('x'),
    onDrop: (d) => act(() => api.removeAttendee(d.outingId, d.userId), `${d.name} taken off ${d.movie}`)(),
  });
  dock({
    accepts: 'pick', kind: 'danger', label: 'Drop here to remove it', iconNode: () => icon('x'),
    onDrop: (p) => act(() => api.removePick(p.id), `${p.movie_name} taken off ${fmtDate(p.day)}`)(),
  });

  const body = mode === 'day' ? dayView(ctx) : mode === 'week' ? weekView(ctx) : mode === 'month' ? monthView(ctx) : yearView(ctx);
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

function planBar(ctx) {
  const { mode, date, today } = ctx;
  const step = (n) => (mode === 'day' ? addDays(date, n) : mode === 'week' ? addDays(weekOf(date), 7 * n)
    : mode === 'month' ? addMonths(date, n) : `${Number(date.slice(0, 4)) + n}${date.slice(4, 7)}-01`);
  const title = mode === 'day' ? fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric' })
    : mode === 'week' ? el('span', {}, weekTitle(weekOf(date)), el('span', { className: 'muted' }, ` · ${weekLabel(weekOf(date))}`))
    : mode === 'month' ? fmtDate(date, { month: 'long', year: 'numeric' }) : date.slice(0, 4);
  const goTo = (d) => setQuery({ date: d === today ? '' : d });
  return el('section', { className: 'planbar' },
    el('div', { className: 'pb-left' },
      el('h1', {}, 'Our plan'),
      el('div', { className: 'pb-nav' },
        el('button', { className: 'btn sm ghost', type: 'button', onclick: () => goTo(today) }, 'Today'),
        el('button', { className: 'btn sm ghost icon-only', type: 'button', ariaLabel: 'Previous', onclick: () => goTo(step(-1)) }, '‹'),
        el('button', { className: 'btn sm ghost icon-only', type: 'button', ariaLabel: 'Next', onclick: () => goTo(step(1)) }, '›'),
        el('h2', { className: 'pb-title' }, title))),
    el('div', { className: 'pb-right' },
      el('div', { className: 'seg modes', role: 'tablist', ariaLabel: 'Calendar view' }, MODES.map(([m, label]) =>
        el('button', { className: m === mode ? 'on' : '', type: 'button', role: 'tab', ariaSelected: String(m === mode), onclick: () => setQuery({ view: m === 'week' ? '' : m }) }, label))),
      el('button', { className: 'btn sm ghost', type: 'button', onclick: () => manualSheet(ctx.g) }, icon('plus'), 'Add by hand')));
}

/** Each person: draggable face, their 4 admissions in the A-List week on screen, reservations held. */
function peopleStrip({ g, date, mode, today }) {
  const week = weekOf(mode === 'day' || mode === 'week' ? date : today);
  const now = Date.now();
  const resetsIn = Math.max(0, Date.parse(`${addDays(weekOf(today), 7)}T06:00:00`) - now);
  return el('div', { className: 'peoplestrip' },
    g.members.map((m) => {
      const inWeek = g.of(m.user_id).filter((a) => a.status !== 'cancelled' && alistWeek(a.starts_at, a.tz) === week)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      const s = standing(g.of(m.user_id), now);
      const pips = Array.from({ length: PER_WEEK }, (_, i) => {
        const a = inWeek[i];
        const cls = !a ? '' : new Date(a.starts_at) <= now ? 'used' : a.status;
        return el('i', { className: `pip ${cls}`, title: a ? `${a.movie_name} · ${fmtWhen(a.starts_at, a.tz)}` : 'Open' });
      });
      const face = draggable(el('span', { className: 'grab', title: `Drag ${m.display_name} onto a showing to add them` }, avatar(m.display_name)), {
        type: 'member', data: { userId: m.user_id, name: m.display_name },
        ghost: () => el('span', { className: 'chip-ghost' }, avatar(m.display_name, true), m.display_name),
      });
      return el('div', { className: 'pchip' }, face,
        el('div', {}, el('b', {}, m.display_name, m.user_id === me.id ? el('span', { className: 'muted' }, ' (you)') : ''), el('span', { className: 'pips' }, pips)),
        el('span', { className: 'pmeta muted' }, `${Math.max(0, PER_WEEK - inWeek.length)} left${week === weekOf(today) ? ' this week' : ` · ${fmtDate(week, { month: 'short', day: 'numeric' })} wk`}`,
          el('br'), `${s.reservedUpcoming}/${PENDING} reservations held`));
    }),
    el('span', { className: 'muted reset' }, `Admissions reset Fri 6 AM, in ${Math.floor(resetsIn / 864e5)}d ${Math.floor((resetsIn % 864e5) / 36e5)}h`));
}

// ---- the calendar views ---------------------------------------------------------------------------

const timesFor = (ctx, movieId, day) => (ctx.showsByDay.get(day) ?? []).filter((s) => s.movieId === movieId);

/** Make a day a drop target: green when the movie has showtimes that day, amber when it doesn't. */
function dayDrop(ctx, node, day) {
  if (day < ctx.today) return node;
  return dropzone(node, {
    accepts: ['movie', 'pick'],
    hint: (data, type) => {
      const id = type === 'pick' ? data.movie_id : data.id;
      const n = timesFor(ctx, id, day).length;
      return n ? ['good', `${n} times · pick one`] : ['warn', ctx.dayInfo.has(day) ? 'Not showing · pencil in' : 'No times yet · pencil in'];
    },
    onDrop: (data, type) => (type === 'pick' ? movePick(ctx, data, day) : dropMovie(ctx, data, day)),
  });
}

function dropMovie(ctx, m, day) {
  if (timesFor(ctx, m.id, day).length) return movieDaySheet(m, day, ctx.g);
  if ((ctx.picksByDay.get(day) ?? []).some((p) => p.movie_name === m.name)) return toast(`${m.name} is already pencilled in for ${fmtDate(day)}`);
  const why = ctx.dayInfo.has(day) ? `isn't showing on ${fmtDate(day)}` : `has no showtimes for ${fmtDate(day)} yet`;
  return act(() => api.addPick({ day, movie_id: m.id ?? null, movie_name: m.name, movie_slug: m.slug ?? null, poster_url: m.poster ?? null }),
    `${m.name} ${why}, so it's pencilled in with a warning`)();
}

function movePick(ctx, p, day) {
  if (p.day === day) return;
  if ((ctx.picksByDay.get(day) ?? []).some((x) => x.movie_name === p.movie_name)) return toast(`${p.movie_name} is already pencilled in for ${fmtDate(day)}`);
  return act(() => api.movePick(p.id, day), `${p.movie_name} moved to ${fmtDate(day)}`)();
}

/** A planned showing: poster, time, title, who's going. Click for the details; drop a face on it to add them. */
function planChip(ctx, o, size = 'md') {
  const past = Date.parse(o.starts_at) <= Date.now();
  const going = (o.attendees ?? []).filter((a) => a.status !== 'cancelled');
  const state = past ? 'past' : going.some((a) => a.status === 'reserved') ? 'reserved' : 'planned';
  const chip = el('button', {
    className: `pchipx plan ${state} ${size}`, type: 'button',
    title: `${o.movie_name} · ${fmtWhen(o.starts_at, o.tz)} · ${state === 'past' ? 'watched' : state}`,
    onclick: () => showingSheet(ctx.g, o),
  },
  size !== 'sm' && poster(o.poster_url, o.movie_name),
  el('span', { className: 'pl-text' },
    el('span', { className: 'pl-time' }, size === 'sm' ? fmtTime(o.starts_at, o.tz).replace(/\s?([AP])M$/i, (_, x) => x.toLowerCase()) : fmtTime(o.starts_at, o.tz), size === 'lg' && o.format && o.format !== 'Standard' ? fmtBadge(o.format) : null),
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
  }
  return chip;
}

function pickStatus(ctx, p) {
  const n = timesFor(ctx, p.movie_id, p.day).length;
  if (n) return { cls: 'ready', note: `${n} times now · pick one` };
  return { cls: 'warn', note: ctx.dayInfo.has(p.day) ? 'Not showing this day' : 'No showtimes yet' };
}

/** A pencilled-in movie, with a warning marker until it has showtimes that day. Drag it to another day or off. */
function pickChip(ctx, p, size = 'md') {
  const st = pickStatus(ctx, p);
  const m = ctx.movieById.get(p.movie_id) ?? { id: p.movie_id, name: p.movie_name, slug: p.movie_slug, poster: p.poster_url };
  const mark = el('span', { className: `pick-mark ${st.cls}`, title: st.note, ariaLabel: st.note }, st.cls === 'warn' ? '!' : '✓');
  const chip = el('button', {
    className: `pchipx pick ${st.cls} ${size}`, type: 'button', title: `${p.movie_name} · pencilled in · ${st.note}`,
    onclick: () => movieDaySheet(m, p.day, ctx.g, p),
  },
  size !== 'sm' ? el('span', { className: 'pp' }, poster(p.poster_url ?? m.poster, p.movie_name), mark) : mark,
  el('span', { className: 'pl-text' },
    size !== 'sm' && el('span', { className: 'pl-time' }, st.note),
    el('span', { className: 'pl-title' }, p.movie_name)));
  if (p.day >= ctx.today) {
    draggable(chip, { type: 'pick', data: p, ghost: () => el('span', { className: 'poster-ghost' }, poster(p.poster_url ?? m.poster, p.movie_name)) });
  }
  return chip;
}

function dayItems(ctx, d, size) {
  return [...(ctx.plansByDay.get(d) ?? []).map((o) => planChip(ctx, o, size)), ...(ctx.picksByDay.get(d) ?? []).map((p) => pickChip(ctx, p, size))];
}

/** Week: the A-List week (Fri → Thu) as a vertical bar of days. */
function weekView(ctx) {
  const w = weekOf(ctx.date);
  const counts = ctx.g.members.map((m) => {
    const n = ctx.g.of(m.user_id).filter((a) => a.status !== 'cancelled' && alistWeek(a.starts_at, a.tz) === w).length;
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
        el('a', { className: 'drow-date', href: plansLink('day', d), title: 'Open this day' },
          el('span', { className: 'dd-wd' }, d === ctx.today ? 'Today' : weekdayOf(d)),
          el('b', { className: 'dd-num' }, Number(d.slice(8))),
          el('span', { className: 'dd-mo' }, fmtDate(d, { month: 'short' }))),
        el('div', { className: 'drow-body' },
          items.length ? items : el('span', { className: 'drow-empty' }, past ? 'Nothing' : 'Drop a movie here')),
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
        el('a', { className: 'mc-num', href: plansLink('day', d) }, Number(d.slice(8))),
        d >= ctx.today && info && el('span', { className: 'mc-info', title: `${info.count} showtimes stored` }, info.count),
        el('div', { className: 'mc-items' }, items.slice(0, 3),
          items.length > 3 && el('a', { className: 'mc-more', href: plansLink('day', d) }, `+${items.length - 3} more`))), d);
    }))));
}

/** Year: twelve small months; a day is coloured by what's on it. */
function yearView(ctx) {
  const y = ctx.date.slice(0, 4);
  const now = Date.now();
  return el('div', { className: 'year' }, Array.from({ length: 12 }, (_, i) => {
    const first = `${y}-${String(i + 1).padStart(2, '0')}-01`;
    const days = monthDays(first);
    let count = 0;
    const weeks = [];
    for (let w = weekOf(first); w <= days.at(-1); w = addDays(w, 7)) weeks.push(w);
    const grid = weeks.map((w) => el('div', { className: 'ym-week' }, weekDays(w).map((d) => {
      if (d.slice(0, 7) !== first.slice(0, 7)) return el('span', { className: 'yd out' });
      const plans = ctx.plansByDay.get(d) ?? [];
      const picks = ctx.picksByDay.get(d) ?? [];
      count += plans.length;
      const state = plans.length
        ? (plans.every((o) => Date.parse(o.starts_at) <= now) ? 'past' : plans.some((o) => (o.attendees ?? []).some((a) => a.status === 'reserved')) ? 'reserved' : 'planned')
        : picks.length ? 'pick' : '';
      const tip = [...plans.map((o) => `${o.movie_name} ${fmtTime(o.starts_at, o.tz)}`), ...picks.map((p) => `${p.movie_name} (pencilled in)`)].join(', ');
      return el('a', { className: `yd ${state}${d === ctx.today ? ' today' : ''}`, href: plansLink('day', d), title: tip ? `${fmtDate(d)}: ${tip}` : fmtDate(d) }, Number(d.slice(8)));
    })));
    return el('section', { className: 'ymonth', style: `--i:${i}` },
      el('a', { className: 'ym-title', href: plansLink('month', first) }, fmtDate(first, { month: 'long' }),
        count ? el('span', { className: 'pill planned' }, `${count} ${count === 1 ? 'movie' : 'movies'}`) : null),
      el('div', { className: 'ym-head' }, weekDays(weeks[0]).map((d) => el('span', {}, weekdayOf(d).slice(0, 1)))),
      grid);
  }));
}

/** Day: a timeline of what's planned, pencilled-in movies, then everything on that day. */
function dayView(ctx) {
  const d = ctx.date;
  const plans = ctx.plansByDay.get(d) ?? [];
  const picks = ctx.picksByDay.get(d) ?? [];
  const info = ctx.dayInfo.get(d);
  const START = 10, END = 26, H = 46; // 10 AM to 2 AM, px per hour
  const hourOf = (iso) => { const t = new Date(iso); const h = t.getHours(); return (h < 5 ? h + 24 : h) + t.getMinutes() / 60; };
  const label = (h) => { const x = h % 24; return `${x % 12 || 12} ${x < 12 ? 'AM' : 'PM'}`; };
  // side by side when showings overlap
  const lanes = [];
  const placed = plans.map((o) => {
    const s = Date.parse(o.starts_at), e = Date.parse(o.ends_at);
    let li = lanes.findIndex((end) => end <= s);
    if (li < 0) { li = lanes.length; lanes.push(e); } else lanes[li] = e;
    return { o, li };
  });
  const n = Math.max(1, lanes.length);
  const timeline = el('div', { className: 'timeline', style: `--h:${H}px` },
    Array.from({ length: END - START }, (_, i) => el('div', { className: 'tl-hour' }, el('span', {}, label(START + i)))),
    placed.map(({ o, li }) => {
      const chip = planChip(ctx, o, 'lg');
      const top = Math.max(0, (hourOf(o.starts_at) - START) * H);
      const height = Math.max(40, ((Date.parse(o.ends_at) - Date.parse(o.starts_at)) / 36e5) * H);
      chip.classList.add('tl-block');
      chip.style.cssText = `top:${top}px;height:${height}px;left:calc(52px + (100% - 52px) * ${li} / ${n});width:calc((100% - 52px) / ${n} - 6px)`;
      return chip;
    }));

  const panel_ = dayDrop(ctx, el('section', { className: `dayview${d < ctx.today ? ' past' : ''}` },
    el('div', { className: 'dv-head' },
      el('span', { className: 'muted' }, d < ctx.today ? 'Past day' : info ? `${info.count} showtimes stored · checked ${ago(info.checked)}` : "Showtimes for this day haven't been read yet"),
      d >= ctx.today && el('span', { className: 'muted' }, ' · drop a movie anywhere here')),
    picks.length > 0 && el('div', { className: 'dv-picks' }, el('span', { className: 'muted' }, 'Pencilled in'), picks.map((p) => pickChip(ctx, p, 'md'))),
    timeline), d);

  // everything on that day, by movie
  const on = ctx.shows.filter((s) => s.date === d);
  const byMovie = groupBy(on, (s) => s.movieId);
  const blocks = [...byMovie.values()].sort((a, b) => a[0].movieName.localeCompare(b[0].movieName)).map((list) => {
    const s0 = list[0], m = ctx.movieById.get(s0.movieId) ?? { id: s0.movieId, name: s0.movieName, slug: s0.movieSlug, runTime: s0.runTime };
    return el('section', { className: 'theatre-block movie-block' },
      el('a', { className: 'mb-poster', href: `/movie/${m.id}?week=${weekOf(d)}` }, poster(m.poster, m.name)),
      el('div', {},
        el('h3', {}, link(`/movie/${m.id}?week=${weekOf(d)}`, m.name)),
        el('div', { className: 'muted' }, [m.rating, fmtRun(m.runTime)].filter(Boolean).join(' · ')),
        byTheatre(list, ctx.theatres, (l, th) => showtimeGroups(l, th, m, ctx.g))));
  });
  return [panel_,
    el('h2', { className: 'section' }, 'On that day'),
    blocks.length ? blocks : el('p', { className: 'empty' }, d < ctx.today ? 'Past day.' : info ? 'No showtimes this day.' : "This day hasn't been read from AMC yet; it fills in within a day or two.")];
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
  const weekParam = ctx.mode === 'week' || ctx.mode === 'day' ? `?week=${weekOf(ctx.date)}` : '';

  const tile = (m, i) => {
    const d = daysFor.get(m.id);
    return draggable(el('a', { className: 'cat-tile', href: `/movie/${m.id}${weekParam}`, style: `--i:${Math.min(i, 24)}`, title: `${m.name}: drag onto a day, or tap for its showtimes` },
      el('span', { className: 'pp' }, poster(m.poster, m.name), m.who.length > 0 && el('span', { className: 'ct-star', title: 'On the wishlist' }, '★')),
      el('span', { className: 'ct-name' }, m.name),
      el('span', { className: `ct-sub${d ? ' on' : ''}` }, d ? daysLabel([...d]) : inView ? 'No times on screen' : 'No times stored'),
      m.who.length > 0 && el('span', { className: 'faces' }, m.who.map((id) => avatar(nameOf(ctx.g.members, id), true)))), {
      type: 'movie', data: m, ghost: () => el('span', { className: 'poster-ghost' }, poster(m.poster, m.name)),
    });
  };

  const grid = el('div', { className: 'cat-grid' });
  const search = el('input', { type: 'search', placeholder: 'Search movies', value: catalogQuery, ariaLabel: 'Search movies' });
  const tabs = el('div', { className: 'seg cat-tabs', role: 'tablist' });
  const TABS = [['view', ctx.range ? 'On screen' : 'Showing'], ['wish', 'Wishlist'], ['all', 'All']];
  const draw = () => {
    catalogQuery = search.value;
    const q = search.value.trim().toLowerCase();
    tabs.replaceChildren(...TABS.map(([k, label]) => el('button', {
      className: k === catalogTab ? 'on' : '', type: 'button', role: 'tab', ariaSelected: String(k === catalogTab),
      onclick: () => { catalogTab = k; draw(); },
    }, label)));
    const list = all
      .filter((m) => (catalogTab === 'view' ? daysFor.has(m.id) : catalogTab === 'wish' ? m.who.length > 0 : true))
      .filter((m) => !q || m.name.toLowerCase().includes(q))
      .sort((a, b) => (b.who.length > 0) - (a.who.length > 0) || (daysFor.get(b.id)?.size ?? 0) - (daysFor.get(a.id)?.size ?? 0) || a.name.localeCompare(b.name));
    grid.replaceChildren(...(list.length ? list.map(tile) : [el('p', { className: 'muted cat-empty' },
      q ? 'No movies match.' : catalogTab === 'view' ? 'No showtimes stored for these days yet. Try All.' : catalogTab === 'wish' ? 'Nothing starred yet.' : 'No movies yet.')]));
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
    el('p', { className: 'cat-hint muted' }, 'Drag a poster onto a day: green days have showtimes for it, amber ones get it pencilled in.'),
    grid);
  return box;
}

// ---- sheets for a planned showing and for a movie on a day ------------------------------------------

const STATUS_LABEL = { planned: 'Planned', reserved: 'Reserved', cancelled: 'Cancelled' };

function showingSheet(g, o) {
  openSheet(
    el('div', { className: 'row between' }, el('h2', { style: 'margin:0' }, 'Showing'),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    showingCard(g, o, Date.now()));
}

function showingCard(g, o, now) {
  const past = new Date(o.starts_at) <= now;
  const going = (o.attendees ?? []).slice().sort((a, b) => nameOf(g.members, a.user_id).localeCompare(nameOf(g.members, b.user_id)));
  const state = past ? 'past' : going.some((a) => a.status === 'reserved') ? 'reserved' : 'planned';

  const goer = (a) => {
    const name = nameOf(g.members, a.user_id);
    const label = past && a.status !== 'cancelled' ? (a.status === 'reserved' ? 'Watched' : 'Not reserved') : STATUS_LABEL[a.status];
    const cls = past && a.status === 'reserved' ? 'watched' : past && a.status === 'planned' ? 'warn' : a.status;
    const acts = past ? [] : [
      a.status === 'planned' && el('button', { className: 'btn sm ghost', type: 'button', title: 'I booked it in the AMC app', onclick: act(() => api.setAttendee(o.id, a.user_id, { status: 'reserved' }), `Marked reserved for ${name}`) }, 'Mark reserved'),
      a.status === 'reserved' && el('button', { className: 'btn sm ghost', type: 'button', onclick: act(() => api.setAttendee(o.id, a.user_id, { status: 'cancelled' }), 'Reservation cancelled') }, 'Cancel'),
      a.status === 'cancelled' && el('button', { className: 'btn sm ghost', type: 'button', onclick: act(() => api.setAttendee(o.id, a.user_id, { status: 'planned' }), 'Back in the plan') }, 'Restore'),
      el('button', { className: 'btn sm ghost', type: 'button', title: 'Seat', onclick: act(async () => {
        const seat = prompt(`Seat for ${name} (e.g. F12)`, a.seat ?? '');
        if (seat == null) return;
        await api.setAttendee(o.id, a.user_id, { seat: seat.trim().toUpperCase().slice(0, 20) || null });
      }) }, icon('seat'), a.seat ? a.seat : 'Seat'),
      el('button', { className: 'btn sm ghost danger', type: 'button', title: `Take ${name} off this showing`, onclick: act(() => api.removeAttendee(o.id, a.user_id), `${name} removed`) }, icon('x')),
    ];
    return el('div', { className: 'goer' }, avatar(name, true), el('span', { className: 'name' }, name),
      el('span', { className: `pill ${cls}` }, label), past && a.seat && el('span', { className: 'muted' }, a.seat),
      el('div', { className: 'acts' }, acts));
  };

  const notGoing = g.members.filter((m) => !going.some((a) => a.user_id === m.user_id));
  const title = o.movie_id ? link(`/movie/${o.movie_id}?week=${alistWeek(o.starts_at, o.tz)}`, o.movie_name) : o.movie_name;
  const card = el('article', { className: 'showing' },
    poster(o.poster_url, o.movie_name),
    el('div', { className: 'showing-main' },
      el('div', { className: 'showing-title' }, title),
      el('div', { className: 'meta' },
        el('span', { className: 'when' }, fmtWhen(o.starts_at, o.tz)),
        el('span', {}, o.theatre_name),
        o.format && o.format !== 'Standard' && fmtBadge(o.format)),
      el('div', { className: 'goers' }, going.map(goer)),
      !past && el('div', { className: 'showing-foot' },
        notGoing.map((m) => el('button', {
          className: 'btn sm ghost', type: 'button',
          onclick: act(() => api.planShowing({ id: o.id }, [m.user_id]), `${m.display_name} added`),
        }, icon('plus'), m.display_name)),
        o.purchase_url && el('a', { className: 'btn sm ghost', href: o.purchase_url, target: '_blank', rel: 'noopener' }, icon('seat'), 'Seats on AMC', icon('ext')))));
  card.dataset.state = state;
  return card;
}

/** A movie on a day: its showtimes that day, ready to pick one; or pencil it in / take the pencil mark off. */
async function movieDaySheet(m, day, g, pick = null) {
  const [shows, theatres, dayInfo] = await Promise.all([api.showtimes({ movie: m.id, date: day }), api.theatres(), api.days()]);
  const movie = (m.id != null && (await api.movie(m.id))) || m;
  const info = dayInfo.get(day);
  const future = day >= isoDay();
  openSheet(
    el('div', { className: 'sheet-head' },
      poster(movie.poster, movie.name),
      el('div', {},
        el('h2', {}, movie.name),
        el('p', { className: 'when big' }, fmtDate(day, { weekday: 'long', month: 'long', day: 'numeric' })),
        el('div', { className: 'meta' }, [movie.rating, fmtRun(movie.runTime)].filter(Boolean).map((x) => el('span', {}, x)),
          pick && el('span', { className: `pill ${shows.length ? 'planned' : 'warn'}` }, shows.length ? 'Pencilled in · pick a time' : 'Pencilled in'))),
      el('button', { className: 'btn sm ghost', type: 'button', ariaLabel: 'Close', onclick: closeSheet }, icon('x'))),
    shows.length
      ? byTheatre(shows, theatres, (list, t) => showtimeGroups(list, t, movie, g))
      : el('section', { className: 'panel notice warnbox' }, icon('warn'), el('p', {},
        el('b', {}, info ? `Not showing on ${fmtDate(day)}. ` : `No showtimes for ${fmtDate(day)} yet. `),
        el('span', { className: 'muted' }, info ? 'AMC has nothing for it that day.' : "That day hasn't been read from AMC yet; it fills in within a day or two."))),
    el('div', { className: 'row' },
      future && !pick && el('button', { className: 'btn ghost', type: 'button', onclick: act(() => api.addPick({ day, movie_id: movie.id ?? null, movie_name: movie.name, movie_slug: movie.slug ?? null, poster_url: movie.poster ?? null }), `${movie.name} pencilled in for ${fmtDate(day)}`) }, 'Pencil in without a time'),
      pick && el('button', { className: 'btn ghost danger', type: 'button', onclick: act(() => api.removePick(pick.id), `${movie.name} taken off ${fmtDate(day)}`) }, icon('x'), 'Remove pencil mark'),
      movie.id != null && el('a', { className: 'btn ghost', href: `/movie/${movie.id}?week=${weekOf(day)}` }, 'All of its times that week'),
      el('button', { className: 'btn ghost', type: 'button', onclick: () => manualSheet(g, { movie: movie.name, day }) }, icon('plus'), 'Add by hand')));
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
  const showing = all.filter((m) => daysFor.has(m.id)).sort((a, b) => countFor.get(b.id) - countFor.get(a.id) || a.name.localeCompare(b.name));
  const others = all.filter((m) => !daysFor.has(m.id)).sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
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
  const card = (m, i, sub) => el('li', { style: `--i:${Math.min(i, 30)}` }, movieCard(m, members, wants, sub, href(m)));
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hit = (m) => !q || m.name.toLowerCase().includes(q);
    const a = showing.filter(hit), b = others.filter(hit);
    grid.replaceChildren(...(a.length ? a.map((m, i) => card(m, i, `${daysLabel([...daysFor.get(m.id)])} · ${countFor.get(m.id)} times`))
      : [el('li', { className: 'empty' }, q ? 'No movies match.' : week ? "No showtimes stored for that week yet. Days fill in a day or two ahead." : 'Nothing stored yet.')]));
    older.replaceChildren(...b.map((m, i) => card(m, i, null)));
    olderHead.hidden = !b.length;
  };
  search.oninput = draw;
  draw();
  view(heading(week ? `${weekTitle(week)} · ${weekLabel(week)}` : 'AMC Theatres', 'Movies', search), freshBanner(fresh),
    weekTabs(shows, week, (w) => setQuery({ week: w })),
    el('h2', { className: 'section' }, week ? 'Showing that week' : 'Showing'), grid, olderHead, older);
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
      el('p', { className: 'eyebrow' }, el('span', { className: 'dot' }), shows.length ? `${shows.length} showtimes over ${new Set(shows.map((s) => s.date)).size} days` : 'No showtimes stored'),
      el('h1', {}, m.name),
      el('div', { className: 'meta' }, [m.rating, fmtRun(m.runTime)].filter(Boolean).map((t) => el('span', {}, t))),
      el('div', { className: 'row', style: 'margin-top:14px' },
        movieCard(m, g.members, wants).querySelector('.wantrow'),
        who.length ? el('span', { className: 'muted' }, `Wanted by ${who.map((x) => nameOf(g.members, x.user_id)).join(', ')}`) : null,
        m.slug && el('a', { className: 'btn sm ghost', href: `https://www.amctheatres.com/movies/${m.slug}`, target: '_blank', rel: 'noopener' }, 'AMC page', icon('ext')))));

  // the days to list: a chosen week shows all seven (so gaps are visible), otherwise every day with showtimes
  const days = week ? weekDays(week).filter((d) => d >= today) : [...new Set(shows.map((s) => s.date))].sort();
  const sectionId = (d) => `day-${d}`;
  const jump = days.length > 1 && el('nav', { className: 'jumpbar', ariaLabel: 'Days' }, days.map((d) => {
    const n = shows.filter((s) => s.date === d).length;
    return el('button', {
      className: `jump${n ? '' : ' none'}${d === today ? ' today' : ''}`, type: 'button',
      onclick: () => document.getElementById(sectionId(d))?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, el('span', {}, d === today ? 'Today' : weekdayOf(d)), el('b', {}, Number(d.slice(8))), el('small', {}, n ? `${n}` : dayInfo.has(d) ? '–' : '?'));
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
    out.push(el('section', { className: `daysec${list.length ? '' : ' empty-day'}`, id: sectionId(d) },
      el('div', { className: 'daysec-head' },
        el('h3', {}, fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' }), d === today && el('span', { className: 'pill planned' }, 'Today')),
        el('span', { className: 'muted' }, info ? `checked ${ago(info.checked)}` : 'not read yet'),
        el('a', { className: 'btn sm ghost', href: plansLink('day', d) }, 'Plan this day')),
      list.length
        ? byTheatre(list, theatres, (l, t) => showtimeGroups(l, t, m, g))
        : el('p', { className: 'muted' }, info ? 'Not showing this day.' : "This day hasn't been read from AMC yet; it fills in within a day or two. ",
          el('button', { className: 'btn sm ghost', type: 'button', onclick: () => manualSheet(g, { movie: m.name, day: d }) }, icon('plus'), 'Add by hand'))));
    return out;
  });

  view(hero, freshBanner(fresh),
    weekTabs(shows, week, (x) => setQuery({ week: x }), [week]),
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
      const n = o ? (o.attendees ?? []).filter((a) => a.status !== 'cancelled').length : 0;
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
  const hrefFor = (d) => (t ? `/theatre/${t.id}${d === today ? '' : `?date=${d}`}` : plansLink('day', d));
  const strip = el('div', { className: 'dates', role: 'group', ariaLabel: 'Date' }, days.map((d) => {
    const n = all.filter((s) => s.date === d).length;
    return el('a', { className: `date${n ? '' : ' none'}`, href: hrefFor(d), ariaCurrent: d === date ? 'date' : null },
      d === today ? 'Today' : weekdayOf(d), el('b', {}, Number(d.slice(8))), el('small', {}, n ? `${n}` : dayInfo.has(d) ? '–' : '?'));
  }));

  const showtimes = all.filter((s) => s.date === date);
  const movies = new Map(movieList.map((m) => [m.id, m]));
  const planned = g.outings.filter((o) => isoDay(o.starts_at) === date);
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
    planned.length > 0 && el('p', { className: 'muted' }, 'Planned that day: ', planned.map((o) => `${o.movie_name} at ${fmtTime(o.starts_at, o.tz)}`).join(', ')),
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
        : el('span', { className: 'why muted' }, `${standing(g.of(m.user_id)).byWeek[alistWeek(outing.starts_at, outing.tz)] ?? 0} of ${PER_WEEK} used that week`);
      return el('label', { className: box.disabled && !already ? 'blocked' : '' }, box, avatar(m.display_name, true), el('span', {}, m.display_name, m.user_id === me.id ? ' (you)' : ''), why);
    }));
  };
  const seg = el('div', { className: 'seg', role: 'radiogroup', ariaLabel: 'Status' }, [['planned', 'Planning to go'], ['reserved', 'Already reserved']].map(([v, label]) =>
    el('label', {}, el('input', { type: 'radio', name: 'status', value: v, checked: v === status, onchange: () => { status = v; draw(); } }), label)));
  draw();
  return {
    node: el('div', { className: 'stack', style: 'display:grid;gap:10px' }, list, seg),
    picked: () => [...boxes].filter(([, b]) => b.checked && !b.disabled).map(([id]) => id),
    status: () => status,
  };
}

function showtimeSheet(s, t, movie, g) {
  const outing = {
    showtime_id: s.id, movie_id: s.movieId, movie_name: s.movieName, movie_slug: s.movieSlug ?? movie?.slug ?? null,
    poster_url: movie?.poster ?? null, theatre_id: t.id, theatre_name: t.name, auditorium: s.auditorium,
    format: s.format, starts_at: s.utc, ends_at: new Date(Date.parse(s.utc) + (s.runTime || movie?.runTime || 150) * 60e3).toISOString(),
    tz: t.tz, purchase_url: s.purchaseUrl,
  };
  const existing = g.outings.find((o) => Number(o.showtime_id) === s.id);
  if (existing) outing.id = existing.id;
  const already = new Set((existing?.attendees ?? []).filter((a) => a.status !== 'cancelled').map((a) => a.user_id));
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
      await api.clearPick(s.date, s.movieName).catch(() => {});
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
    el('p', { className: 'muted' }, 'Adding here plans it for the group. Book the actual seats in the AMC app (your entourage can book for each other there), then mark it reserved.'));
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
  const time = el('input', { type: 'time', value: '19:00', required: true });
  const run = el('input', { type: 'number', min: 30, max: 400, value: 150, inputMode: 'numeric' });
  const fmt = el('select', {}, ['Standard', 'Laser at AMC', 'IMAX with Laser at AMC', 'Dolby Cinema at AMC', 'PRIME at AMC', 'RealD 3D', 'Other'].map((f) => new Option(f, f)));
  const match = () => known.find((m) => m.name.toLowerCase() === movie.value.trim().toLowerCase());
  const fillRun = () => { const m = match(); if (m?.runTime) run.value = m.runTime; };
  movie.addEventListener('change', () => { fillRun(); recheck(); });
  fillRun();

  const outing = () => {
    const t = theatres.find((x) => String(x.id) === theatreSel.value);
    const tz = t?.tz ?? localTz();
    const start = wallToUtc(day.value, time.value || '19:00', tz);
    const m = match();
    return {
      movie_name: m?.name ?? movie.value.trim(), movie_id: m?.id ?? null, movie_slug: m?.slug ?? null, poster_url: m?.poster ?? null,
      theatre_id: t?.id ?? null, theatre_name: t?.name ?? theatreName.value.trim(),
      format: fmt.value, tz, starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + (Math.min(400, Math.max(30, +run.value || 150))) * 60e3).toISOString(),
    };
  };
  const whoWrap = el('div');
  let who;
  const recheck = () => { if (day.value && time.value) { who = whoPicker(g, outing()); whoWrap.replaceChildren(who.node); } };
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
      await api.clearPick(day.value, o.movie_name).catch(() => {});
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
      field('Date', day), field('Start time', time), field('Runtime (minutes)', run), field('Format', fmt)),
    el('section', {}, el('h3', {}, "Who's going"), whoWrap),
    el('div', { className: 'row' }, save));
  requestAnimationFrame(() => (prefill.movie ? time : movie).focus());
}

// ---- theatres -------------------------------------------------------------------------------

async function theatresPage() {
  const saved = await api.theatres();
  view(heading('Where we watch', 'Theatres'),
    el('p', { className: 'muted' }, "The scraper reads one day's showtimes per run for every theatre switched on here: today each morning, then the next two weeks in turn. AMC's site lets one page through per run, so keep it to one theatre."),
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
  const past = g.outings.filter((o) => new Date(o.starts_at) <= now).reverse();
  const watched = (id) => g.of(id).filter((a) => a.status !== 'cancelled' && new Date(a.starts_at) <= now);
  const year = String(new Date().getFullYear());
  view(heading('Everything so far', 'History'),
    el('div', { className: 'tiles' }, g.members.flatMap((m) => [
      stat(`${m.display_name} · all time`, watched(m.user_id).length),
      stat(`${m.display_name} · ${year}`, watched(m.user_id).filter((a) => a.starts_at.startsWith(year)).length),
    ])),
    table([
      { label: 'When', val: (o) => o.starts_at, cell: (o) => fmtWhen(o.starts_at, o.tz) },
      { label: 'Movie', val: (o) => o.movie_name, cell: (o) => (o.movie_id ? link(`/movie/${o.movie_id}`, o.movie_name) : o.movie_name), num: false },
      { label: 'Theatre', val: (o) => o.theatre_name, num: false },
      { label: 'Format', val: (o) => o.format ?? '', cell: (o) => (o.format ? fmtBadge(o.format) : '–'), num: false },
      { label: 'Who', val: (o) => (o.attendees ?? []).filter((a) => a.status !== 'cancelled').map((a) => nameOf(g.members, a.user_id)).join(', '), num: false },
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
        el('li', {}, 'Every showing someone plans or reserves takes one of their 4 for that week. Adding a fifth is refused, for planned and reserved alike.'),
        el('li', {}, 'Only showings marked reserved count toward the 4-at-a-time limit. You can still plan further ahead; it tells you to reserve once a current reservation has been used.'),
        el('li', {}, 'Overlapping showings for the same person are refused (a showing lasts its runtime).'),
        el('li', {}, 'Cancelling a reservation frees the admission again. The database checks every rule, so nothing can slip past from two phones at once.'))));
}

render();
