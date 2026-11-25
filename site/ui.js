// Small DOM helpers and formatting shared by every page (same helpers as the other DurpeeSquid sites).

export const $ = (id) => document.getElementById(id);

export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return n;
};

const ICON = {
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  ticket: '<path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4z"/><path d="M9 7v10" stroke-dasharray="1.6 1.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  seat: '<path d="M6 19v-4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v4M7 13V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v6M5 19h14"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'i');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[name] ?? '';
  return s;
}

/** Date and time as seen at the theatre (`tz`), e.g. "Fri, Nov 13, 7:30 PM". */
export const fmtWhen = (iso, tz) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });
export const fmtTime = (iso, tz) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: tz || undefined });
export const fmtDay = (iso) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
export const fmtRun = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : null);

/** 'YYYY-MM-DD' of a date in the viewer's time zone. */
export const isoDay = (d = new Date()) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export const initials = (name = '?') => name.replace(/^@/, '').split(/[\s_.-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
export const avatar = (name, small = false) => el('span', { className: `avatar${small ? ' sm' : ''}`, title: name, ariaHidden: 'true' }, initials(name));

export function poster(url, name = '') {
  if (typeof url !== 'string' || !url.startsWith('https://')) return el('span', { className: 'poster' }, initials(name));
  return el('img', { className: 'poster', alt: '', loading: 'lazy', src: url });
}

let toastTimer;
export function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2400);
}

/** A labelled <select>. options: [value, text][] */
export function select(label, options, value, onchange) {
  const s = el('select');
  for (const [v, text] of options) s.append(new Option(text, String(v), false, String(v) === String(value)));
  s.value = String(value);
  s.onchange = () => onchange(s.value);
  return el('label', { className: 'field' }, label, s);
}

export const field = (label, input) => el('label', { className: 'field' }, label, input);

export const stat = (label, value, small = false) =>
  el('div', { className: 'tile-stat' }, el('span', { className: 'stat-label' }, label), el('span', { className: `stat-value${small ? ' small' : ''}` }, value));

/** Sortable table. cols: { label, val(row), cell?(row), num? } */
export function table(cols, rows, { sortCol = null, desc = true } = {}) {
  if (!rows.length) return el('p', { className: 'empty' }, 'Nothing to show yet.');
  let sc = sortCol, sd = desc;
  const wrap = el('div', { className: 'table-wrap' });
  const draw = () => {
    const data = [...rows];
    if (sc != null) {
      const c = cols[sc];
      data.sort((a, b) => {
        const x = c.val(a), y = c.val(b);
        const r = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? -Infinity) - (y ?? -Infinity);
        return sd ? -r : r;
      });
    }
    wrap.replaceChildren(el('table', {},
      el('thead', {}, el('tr', {}, cols.map((c, i) => el('th', {
        className: `sortable${c.num ? ' num' : ''}`,
        onclick: () => { if (sc === i) sd = !sd; else { sc = i; sd = c.num !== false; } draw(); },
      }, c.label, sc === i ? (sd ? ' ▼' : ' ▲') : '')))),
      el('tbody', {}, data.map((row, i) => el('tr', { style: `--i:${Math.min(i, 24)}` },
        cols.map((c) => el('td', { className: c.num ? 'num' : '' }, c.cell ? c.cell(row) : c.val(row) ?? '–')))))));
  };
  draw();
  return wrap;
}

/** Placeholder shown while a page loads. */
export const skeleton = () => [
  el('div', { className: 'skel title' }),
  el('div', { className: 'skel bar' }),
  el('div', { className: 'skel-grid' }, [0, 1, 2, 3].map(() => el('div', { className: 'skel card' }))),
];

// ---- AMC formats ------------------------------------------------------------------------------

/**
 * A badge for an AMC format group, styled after how AMC brands it ("Dolby Cinema at AMC", "IMAX with Laser at AMC",
 * "PRIME at AMC", "RealD 3D", "Laser at AMC"). Anything else (Digital, captions, a language) is a plain label.
 */
export function fmtBadge(format = '', tags = []) {
  const f = `${format} ${tags.join(' ')}`;
  const b = (cls, ...kids) => el('span', { className: `fmtb ${cls}`, title: format }, ...kids);
  if (/dolby/i.test(format)) return b('dolby', el('b', {}, 'DOLBY'), el('span', {}, 'CINEMA'), el('small', {}, 'at AMC'));
  if (/imax/i.test(format)) return b('imax', el('b', {}, 'IMAX'), /laser/i.test(format) && el('small', {}, 'with Laser'));
  if (/prime/i.test(format)) return b('prime', el('b', {}, 'PRIME'), el('small', {}, 'at AMC'));
  if (/reald|\b3d\b/i.test(format)) return b('reald', el('b', {}, 'RealD'), el('i', {}, '3D'));
  if (/^laser at amc$/i.test(format.trim())) return b('laser', el('b', {}, 'LASER'), el('small', {}, 'at AMC'));
  if (/sensory/i.test(format)) return b('plain', 'Sensory Friendly');
  if (/open caption/i.test(format)) return b('plain', 'Open Caption');
  if (/^digital$|^standard$/i.test(format.trim()) || !format) return b('plain', /laser at amc/i.test(f) ? 'Laser' : 'Standard');
  return b('plain', format.replace(/ Spoken with /i, ' · ').replace(/ Subtitles$/i, ' subs'));
}

// AMC's seat and series tags, shortened; the ones every showing has are left out.
const TAG_SHORT = [
  [/signature recliners/i, 'Recliners'], [/club rockers/i, 'Rockers'], [/artisan films/i, 'Artisan Films'],
  [/no trailers/i, 'No trailers'], [/excluded from a-list/i, 'Not A-List'], [/open caption/i, 'Open caption'],
];
export const shortTags = (tags = []) =>
  [...new Set(tags.flatMap((t) => TAG_SHORT.filter(([re]) => re.test(t)).map(([, s]) => s)))];

/** "Fri, Nov 27" for a 'YYYY-MM-DD' (no time zone games: it is a calendar day). */
export const fmtDate = (day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(`${day}T12:00:00`).toLocaleDateString([], opts);

/** "3 h ago" style. */
export function ago(iso) {
  if (!iso) return 'never';
  const m = (Date.now() - Date.parse(iso)) / 60e3;
  return m < 1 ? 'just now' : m < 60 ? `${Math.round(m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
