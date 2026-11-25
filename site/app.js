// AMC A-List planner: pages and routing. Data access is in api.js, the A-List rules in rules.js.
//   /                    the plan: everyone's admissions this week, upcoming weeks, wanted movies
//   /movies              what's showing at our theatres (read off amctheatres.com by the scraper)
//   /movie/<id>          one movie: its showtimes, add one to the plan
//   /theatres            the theatres the scraper reads, switch them on or off
//   /theatre/<id>        everything on at one theatre (?date=)
//   /history             what everyone has watched
//   /rules               the A-List rules this follows
import { requireLogin, hasAccess, signOut, HOME, loadProfile } from './session.js';
import * as api from './api.js';
import { PER_WEEK, PENDING, TERMS_URL, alistWeek, addWeeks, weekLabel, standing, canAttend, localTz, wallToUtc } from './rules.js';
import { $, el, icon, fmtWhen, fmtTime, fmtDay, fmtRun, isoDay, avatar, poster, toast, select, field, stat, table, skeleton } from './ui.js';

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

async function render() {
  drawNav();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const [first, id] = path.split('/').filter(Boolean).map(decodeURIComponent);
  const loading = setTimeout(() => view(skeleton()), 160);
  try {
    if (!first) await planPage();
    else if (first === 'movies') await moviesPage();
    else if (first === 'movie' && id) await moviePage(id);
    else if (first === 'theatres') await theatresPage();
    else if (first === 'theatre' && id) await theatrePage(+id);
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
  const ago = ageH < 1 ? `${Math.max(1, Math.round(ageH * 60))} min ago` : ageH < 48 ? `${Math.round(ageH)} h ago` : `${Math.round(ageH / 24)} days ago`;
  const stale = ageH > 12 || failedSince;
  return el('p', { className: `fresh${stale ? ' stale' : ''}` }, stale && icon('warn'),
    `Showtimes from amctheatres.com, updated ${ago}. Only today's are read; plan later days with Add by hand.`,
    failedSince && el('span', { className: 'muted' }, ` Last update failed: ${f.last.error ?? 'unknown error'}`));
}

// ---- plan -----------------------------------------------------------------------------------

async function planPage() {
  const [g, wants] = await Promise.all([groupData(), api.wants()]);
  const now = Date.now();
  const tz = localTz();
  const thisWeek = alistWeek(now, tz);

  // this week and the next three, plus any later week someone has plans in
  const weeks = new Set([0, 1, 2, 3].map((n) => addWeeks(thisWeek, n)));
  for (const o of g.outings) {
    const w = alistWeek(o.starts_at, o.tz);
    if (w > thisWeek) weeks.add(w);
  }

  const resetsIn = Math.max(0, Date.parse(`${addWeeks(thisWeek, 1)}T06:00:00`) - now);
  const days = Math.floor(resetsIn / 864e5), hours = Math.floor((resetsIn % 864e5) / 36e5);

  view(
    heading(`A-List week · ${weekLabel(thisWeek)}`, 'Our plan',
      el('div', { className: 'row' },
        el('a', { className: 'btn primary', href: '/movies' }, icon('ticket'), 'Find a movie'),
        el('button', { className: 'btn ghost', type: 'button', onclick: () => manualSheet(g) }, icon('plus'), 'Add by hand'))),
    el('p', { className: 'muted' }, `Admissions reset Friday 6:00 AM, in ${days ? `${days}d ` : ''}${hours}h. Each of you gets ${PER_WEEK} a week and can hold ${PENDING} reservations at a time.`),
    el('div', { className: 'people' }, g.members.map((m) => personCard(m, g.of(m.user_id), now, tz))),
    [...weeks].sort().map((w) => weekSection(g, w, thisWeek, now)),
    wantedSection(g, wants),
  );
}

function personCard(m, adm, now, tz) {
  const s = standing(adm, now, tz);
  const inWeek = adm.filter((a) => a.status !== 'cancelled' && alistWeek(a.starts_at, a.tz) === s.thisWeek)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const slots = Array.from({ length: PER_WEEK }, (_, i) => {
    const a = inWeek[i];
    if (!a) return el('div', { className: 'slot' }, 'open');
    const past = new Date(a.starts_at) <= now;
    const cls = past ? 'used' : a.status;
    return el('div', { className: `slot ${cls}`, title: `${a.movie_name} · ${past ? 'used' : a.status}` }, past ? 'used' : a.status === 'reserved' ? 'booked' : 'plan');
  });
  return el('article', { className: 'person' },
    el('div', { className: 'person-head' }, avatar(m.display_name), m.display_name, m.user_id === me.id && el('span', { className: 'muted' }, '(you)')),
    el('div', { className: 'slots', ariaLabel: `${s.usedThisWeek} of ${PER_WEEK} admissions used this week` }, slots),
    el('div', { className: 'kv' }, 'Left this week', el('b', { className: s.leftThisWeek ? '' : 'full' }, `${s.leftThisWeek} of ${PER_WEEK}`)),
    el('div', { className: 'kv' }, 'Reservations held', el('b', { className: s.reservedUpcoming >= PENDING ? 'full' : '' }, `${s.reservedUpcoming} of ${PENDING}`)),
    el('div', { className: 'kv' }, 'Planned, not reserved yet', el('b', {}, s.plannedUpcoming)));
}

function weekSection(g, week, thisWeek, now) {
  const list = g.outings.filter((o) => alistWeek(o.starts_at, o.tz) === week);
  const title = week === thisWeek ? 'This week' : week === addWeeks(thisWeek, 1) ? 'Next week' : `Week of ${fmtDay(`${week}T12:00:00`)}`;
  const counts = g.members.map((m) => {
    const n = g.of(m.user_id).filter((a) => a.status !== 'cancelled' && alistWeek(a.starts_at, a.tz) === week).length;
    return el('span', {}, `${m.display_name} `, el('b', { className: n >= PER_WEEK ? 'warn' : '' }, `${n}/${PER_WEEK}`));
  });
  return el('section', { className: 'week' },
    el('div', { className: 'week-head' }, el('h2', {}, title, el('span', { className: 'muted' }, ` · ${weekLabel(week)}`)), el('div', { className: 'counts' }, counts)),
    list.length
      ? el('ul', { className: 'showings' }, list.map((o, i) => el('li', { style: `--i:${i}` }, showingCard(g, o, now))))
      : el('p', { className: 'empty' }, week < thisWeek ? 'Nothing that week.' : 'Nothing planned yet. ', week >= thisWeek && link('/movies', 'Pick a movie')));
}

const STATUS_LABEL = { planned: 'Planned', reserved: 'Reserved', cancelled: 'Cancelled' };

function showingCard(g, o, now) {
  const past = new Date(o.starts_at) <= now;
  const going = (o.attendees ?? []).slice().sort((a, b) => nameOf(g.members, a.user_id).localeCompare(nameOf(g.members, b.user_id)));
  const state = past ? 'past' : going.some((a) => a.status === 'reserved') ? 'reserved' : 'planned';
  const act = (fn, okMsg) => async () => {
    try { await fn(); if (okMsg) toast(okMsg); render(); } catch (e) { toast(e.message, true); }
  };

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
  const title = o.movie_id ? link(`/movie/${o.movie_id}`, o.movie_name) : o.movie_name;

  const card = el('article', { className: 'showing' },
    poster(o.poster_url, o.movie_name),
    el('div', { className: 'showing-main' },
      el('div', { className: 'showing-title' }, title),
      el('div', { className: 'meta' },
        el('span', {}, fmtWhen(o.starts_at, o.tz)),
        el('span', {}, o.theatre_name),
        o.format && o.format !== 'Standard' && el('span', {}, o.format),
        o.auditorium && el('span', {}, `Aud ${o.auditorium}`)),
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

function wantedSection(g, wants) {
  if (!wants.length) return null;
  const byMovie = new Map();
  for (const w of wants) {
    const x = byMovie.get(w.movie_id) ?? { ...w, who: [] };
    x.who.push(w.user_id);
    byMovie.set(w.movie_id, x);
  }
  const planned = new Set(g.outings.filter((o) => new Date(o.starts_at) > Date.now()).map((o) => o.movie_id));
  const list = [...byMovie.values()].sort((a, b) => b.who.length - a.who.length || String(a.release_date ?? '').localeCompare(String(b.release_date ?? '')));
  return el('section', { className: 'week' },
    el('div', { className: 'week-head' }, el('h2', {}, 'On the wishlist'), el('span', { className: 'muted' }, 'Movies someone wants to see. Tap one to find showtimes.')),
    el('ul', { className: 'movies' }, list.map((w, i) => el('li', { style: `--i:${i}` },
      el('a', { className: 'movie-card', href: `/movie/${w.movie_id}` },
        poster(w.poster_url, w.movie_name),
        el('span', { className: 'movie-name' }, w.movie_name),
        el('span', { className: 'wantrow' },
          el('span', { className: 'faces' }, w.who.map((id) => avatar(nameOf(g.members, id), true))),
          planned.has(w.movie_id) ? el('span', { className: 'pill reserved' }, 'Planned') : w.release_date && new Date(`${w.release_date}T12:00:00`) > Date.now() ? el('span', { className: 'movie-sub' }, `Opens ${fmtDay(`${w.release_date}T12:00:00`)}`) : null))))));
}

// ---- movies ---------------------------------------------------------------------------------

async function moviesPage() {
  const [members, wants, theatres, all, shows, fresh] = await Promise.all([
    api.members(), api.wants(), api.theatres(), api.movies(), api.showtimes(), api.freshness()]);
  const names = new Map(theatres.map((t) => [t.id, t.name]));
  const where = new Map();
  for (const s of shows) (where.get(s.movieId) ?? where.set(s.movieId, new Set()).get(s.movieId)).add(s.theatreId);
  const showing = all.filter((m) => where.has(m.id));
  const earlier = all.filter((m) => !where.has(m.id)).sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));

  const search = el('input', { type: 'search', placeholder: 'Search titles', ariaLabel: 'Search titles' });
  const grid = el('ul', { className: 'movies' });
  const older = el('ul', { className: 'movies' });
  const olderHead = el('h2', { className: 'section' }, 'Seen earlier');
  const card = (m, i) => el('li', { style: `--i:${Math.min(i, 30)}` }, movieCard(m, members, wants,
    where.has(m.id) && [...where.get(m.id)].map((id) => names.get(id)).filter(Boolean).join(', ')));
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hit = (m) => !q || m.name.toLowerCase().includes(q);
    const a = showing.filter(hit), b = earlier.filter(hit);
    grid.replaceChildren(...(a.length ? a.map(card) : [el('li', { className: 'empty' }, q ? 'No movies match.' : 'Nothing listed today.')]));
    older.replaceChildren(...b.map(card));
    olderHead.hidden = !b.length;
  };
  search.oninput = draw;
  draw();
  view(heading('AMC Theatres', 'Movies', search), freshBanner(fresh),
    el('h2', { className: 'section' }, 'Showing today'), grid, olderHead, older);
}

function movieCard(m, members, wants, sub = null) {
  const who = wants.filter((w) => w.movie_id === m.id);
  const mine = who.some((w) => w.user_id === me.id);
  const opens = m.release && new Date(m.release) > Date.now();
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
  return el('div', { className: 'movie-card' },
    el('a', { href: `/movie/${m.id}`, ariaLabel: m.name }, poster(m.poster, m.name)),
    el('a', { className: 'movie-name', href: `/movie/${m.id}`, style: 'color:inherit' }, m.name),
    el('span', { className: 'movie-sub' }, [opens ? `Opens ${fmtDay(m.release)}` : null, m.rating, fmtRun(m.runTime)].filter(Boolean).join(' · ')),
    sub && el('span', { className: 'movie-sub' }, sub),
    el('span', { className: 'wantrow' }, btn, el('span', { className: 'faces' }, who.map((w) => avatar(nameOf(members, w.user_id), true)))));
}

// ---- one movie: showtimes at our theatres -------------------------------------------------------

/** Day buttons for the days that have showtimes (usually just today). Nothing if there is only one. */
function dateStrip(days, selected) {
  if (days.length < 2) return null;
  return el('div', { className: 'dates', role: 'group', ariaLabel: 'Date' }, days.map((d, i) => {
    const x = new Date(`${d}T12:00:00`);
    return el('button', { className: 'date', type: 'button', ariaPressed: String(d === selected), onclick: () => setQuery({ date: i === 0 ? '' : d }) },
      d === isoDay() ? 'Today' : x.toLocaleDateString([], { weekday: 'short' }),
      el('b', {}, x.getDate()),
      x.toLocaleDateString([], { month: 'short' }));
  }));
}
const daysOf = (shows) => [...new Set(shows.map((s) => s.date))].sort();
const pickDay = (days) => {
  const q = query().get('date');
  return days.includes(q) ? q : days[0] ?? isoDay();
};

async function moviePage(id) {
  const movieId = Number(id);
  const [theatres, g, wants, found, shows, fresh] = await Promise.all([
    api.theatres(), groupData(), api.wants(), api.movie(movieId), api.showtimes({ movie: movieId }), api.freshness()]);
  // a wishlist movie the scraper hasn't listed (yet, or any more) still gets a page
  const w = wants.find((x) => x.movie_id === movieId);
  const m = found ?? (w && { id: w.movie_id, name: w.movie_name, slug: w.movie_slug, poster: w.poster_url, release: w.release_date });
  if (!m) return view(panel('Movie not found', el('p', { className: 'muted' }, 'The scraper has not seen this movie. ', link('/movies', 'Back to movies'))));
  const who = wants.filter((x) => x.movie_id === m.id);
  const days = daysOf(shows), date = pickDay(days);

  const hero = el('section', { className: 'movie-hero' },
    poster(m.poster, m.name),
    el('div', {},
      el('p', { className: 'eyebrow' }, el('span', { className: 'dot' }), shows.length ? 'In theatres' : 'Not listed today'),
      el('h1', {}, m.name),
      el('div', { className: 'meta' }, [m.rating, fmtRun(m.runTime)].filter(Boolean).map((t) => el('span', {}, t))),
      el('div', { className: 'row', style: 'margin-top:14px' },
        movieCard(m, g.members, wants).querySelector('.wantrow'),
        who.length ? el('span', { className: 'muted' }, `Wanted by ${who.map((x) => nameOf(g.members, x.user_id)).join(', ')}`) : null,
        m.slug && el('a', { className: 'btn sm ghost', href: `https://www.amctheatres.com/movies/${m.slug}`, target: '_blank', rel: 'noopener' }, 'AMC page', icon('ext')))));

  const shown = theatres.filter((t) => t.scrape || shows.some((s) => s.theatreId === t.id));
  const blocks = shown.map((t) => el('section', { className: 'theatre-block' },
    el('h3', {}, link(`/theatre/${t.id}${date !== days[0] ? `?date=${date}` : ''}`, t.name)),
    el('div', { className: 'muted' }, [t.city, t.state].filter(Boolean).join(', ')),
    showtimeGroups(shows.filter((s) => s.theatreId === t.id && s.date === date), t, m, g)));

  view(hero, freshBanner(fresh), dateStrip(days, date), blocks);
}

/** Showtime buttons grouped by format. Opens the showtime sheet on click. */
function showtimeGroups(showtimes, t, movie, g) {
  if (!showtimes.length) return el('p', { className: 'muted' }, 'No showtimes this day.');
  const byFmt = new Map();
  for (const s of showtimes.slice().sort((a, b) => a.utc.localeCompare(b.utc))) (byFmt.get(s.format) ?? byFmt.set(s.format, []).get(s.format)).push(s);
  const goingTo = new Map(g.outings.filter((o) => o.showtime_id).map((o) => [Number(o.showtime_id), o]));
  return el('div', {}, [...byFmt].map(([fmt, list]) => el('div', { className: 'fmt' },
    el('div', { className: 'fmt-name' }, fmt),
    el('div', { className: 'times' }, list.map((s) => {
      const past = new Date(s.utc) <= Date.now();
      const o = goingTo.get(s.id);
      const n = o ? (o.attendees ?? []).filter((a) => a.status !== 'cancelled').length : 0;
      return el('button', {
        className: `time${s.soldOut ? ' sold' : ''}${s.almostSoldOut ? ' almost' : ''}${n ? ' going' : ''}${past ? ' past' : ''}`,
        type: 'button', disabled: past,
        title: [...new Set([s.alistExcluded && 'Excluded from A-List', ...s.tags].filter(Boolean))].join(', '),
        onclick: () => (s.soldOut && !n ? toast('Sold out', true) : showtimeSheet(s, t, movie, g)),
      }, fmtTime(s.utc, t.tz), el('small', {}, n ? `${n} going` : s.soldOut ? 'Sold out' : s.alistExcluded ? 'Not A-List' : '\u00a0'));
    })))));
}

// ---- one theatre: everything on a date ----------------------------------------------------------

async function theatrePage(id) {
  const [theatres, g, all, fresh, movieList] = await Promise.all([
    api.theatres(), groupData(), api.showtimes({ theatre: id }), api.freshness(), api.movies()]);
  const t = theatres.find((x) => x.id === id);
  if (!t) return view(panel('Theatre not found', el('p', {}, link('/theatres', 'Back to theatres'))));
  const days = daysOf(all), date = pickDay(days);
  const showtimes = all.filter((s) => s.date === date);
  const movies = new Map(movieList.map((m) => [m.id, m]));

  const byMovie = new Map();
  for (const s of showtimes) (byMovie.get(s.movieId) ?? byMovie.set(s.movieId, []).get(s.movieId)).push(s);
  const blocks = [...byMovie.values()].sort((a, b) => a[0].movieName.localeCompare(b[0].movieName)).map((list) => {
    const s0 = list[0], m = movies.get(s0.movieId) ?? { id: s0.movieId, name: s0.movieName, slug: s0.movieSlug, runTime: s0.runTime };
    return el('section', { className: 'theatre-block' },
      el('h3', {}, link(`/movie/${s0.movieId}`, s0.movieName)),
      el('div', { className: 'muted' }, [s0.rating, fmtRun(s0.runTime)].filter(Boolean).join(' · ')),
      showtimeGroups(list, t, m, g));
  });
  view(heading([t.city, t.state].filter(Boolean).join(', ') || 'Theatre', t.name), freshBanner(fresh), dateStrip(days, date),
    blocks.length ? blocks : el('p', { className: 'empty' }, t.scrape ? 'No showtimes stored for today yet.' : 'The scraper is switched off for this theatre. Switch it on from the Theatres page.'));
}

// ---- the showtime sheet: seats, who's going, add to plan ----------------------------------------

const sheet = $('sheet');
function openSheet(...nodes) {
  $('sheet-body').replaceChildren(...nodes);
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
        el('div', { className: 'meta' }, el('span', {}, fmtWhen(s.utc, t.tz)), el('span', {}, t.name), el('span', {}, s.format)),
        el('div', { className: 'meta' }, s.tags.filter((x) => x !== s.format).slice(0, 5).map((x) => el('span', {}, x)))),
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

async function manualSheet(g) {
  const [theatres, known] = await Promise.all([api.theatres().catch(() => []), api.movies().catch(() => [])]);
  const list = el('datalist', { id: 'known-movies' }, known.map((m) => new Option(m.name)));
  const movie = el('input', { required: true, maxLength: 200, placeholder: 'Movie title', autofocus: true });
  movie.setAttribute('list', 'known-movies');
  const theatreSel = el('select', {}, theatres.map((t) => new Option(t.name, String(t.id))), new Option('Other…', ''));
  const theatreName = el('input', { maxLength: 200, placeholder: 'AMC theatre name', hidden: theatres.length > 0 });
  theatreSel.onchange = () => { theatreName.hidden = theatreSel.value !== ''; recheck(); };
  const day = el('input', { type: 'date', value: isoDay(), required: true });
  const time = el('input', { type: 'time', value: '19:00', required: true });
  const run = el('input', { type: 'number', min: 30, max: 400, value: 150, inputMode: 'numeric' });
  const fmt = el('select', {}, ['Standard', 'IMAX', 'Dolby Cinema', 'PRIME', 'RealD 3D', 'Other'].map((f) => new Option(f, f)));
  const match = () => known.find((m) => m.name.toLowerCase() === movie.value.trim().toLowerCase());
  movie.addEventListener('change', () => { const m = match(); if (m?.runTime) { run.value = m.runTime; recheck(); } });

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
  requestAnimationFrame(() => movie.focus());
}

// ---- theatres -------------------------------------------------------------------------------

async function theatresPage() {
  const saved = await api.theatres();
  const ago = (iso) => {
    if (!iso) return 'never';
    const h = (Date.now() - Date.parse(iso)) / 36e5;
    return h < 1 ? 'under an hour ago' : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
  };
  view(heading('Where we watch', 'Theatres'),
    el('p', { className: 'muted' }, "The scraper reads today's showtimes for every theatre switched on here, a few times a day. AMC's site lets one page through per run, so keep it to one theatre."),
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
      { label: 'Format', val: (o) => o.format ?? '', num: false },
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
