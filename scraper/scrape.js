// Reads the showtimes of each tracked AMC theatre off amctheatres.com and sends them to the amc-ingest function.
//
//   node scrape.js                                        today's showtimes at the theatres switched on in the planner
//   node scrape.js --dry --theatre baltimore/amc-columbia-14   print what it found, store nothing
//
// Env: SUPABASE_URL, AMC_INGEST_TOKEN (not needed with --dry). Run on a schedule from this PC (scripts/scrape.ps1).
//
// amctheatres.com sits behind Cloudflare. A visible Chrome window (playwright-core with the installed browser) gets
// one page through; Cloudflare refuses the next one, and headless Chrome outright. So each run reads exactly one page
// per theatre, today's showtimes, and stops. If Cloudflare blocks it, the run is recorded as failed and the planner
// shows the data as stale; nothing tries to get around the block.
import { chromium } from 'playwright-core';
import { showtimesPage, isBlocked } from './parse.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

const DRY = flag('dry');
const SITE = 'https://www.amctheatres.com';
const FN = `${(process.env.SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/amc-ingest`;
const TOKEN = process.env.AMC_INGEST_TOKEN ?? '';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function fn(action, extra = {}) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': TOKEN },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`amc-ingest ${action}: ${res.status} ${body.error ?? ''}`);
  return body;
}

/** YYYY-MM-DD for "now + n days" in the theatre's time zone. */
const localDay = (tz, n = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 864e5));

/** Format group names and tags, read from the rendered page (the streamed data only points at them). */
const readGroups = () => {
  const out = {};
  for (const h of document.querySelectorAll('h3[id]')) {
    const list = document.getElementById(`${h.id}-attributes`);
    if (!list) continue;
    out[h.id] = {
      name: (h.querySelector('span')?.textContent ?? h.textContent ?? '').trim(),
      tags: [...list.querySelectorAll('li')].map((li) => li.textContent.trim()).filter(Boolean),
    };
  }
  return out;
};

async function loadDay(page, t, day) {
  const url = `${SITE}/movie-theatres/${t.market}/${t.slug}/showtimes${day ? `?date=${day}` : ''}`;
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('[aria-label="Showtime Group Results"], section[aria-label^="Showtimes for"]', { timeout: 15_000 }).catch(() => {});
  const html = await page.content();
  if (res?.status() === 403 || isBlocked(html, await page.title())) throw Object.assign(new Error(`Blocked by Cloudflare at ${url}`), { blocked: true });
  if (!res?.ok()) throw new Error(`AMC returned ${res?.status()} for ${url}`);
  const groups = await page.evaluate(readGroups);
  return { html, groups };
}

async function scrapeTheatre(page, t) {
  const tz = t.tz || 'America/New_York';
  const day = localDay(tz);
  const got = await loadDay(page, t, day);
  const r = showtimesPage(got.html, { theatreSlug: t.slug, groups: got.groups });
  if (r.theatre && t.id && r.theatre.id !== t.id) throw new Error(`${t.slug} is AMC theatre ${r.theatre.id}, expected ${t.id}`);
  log(`${t.slug} ${day}: ${r.showtimes.length} showtimes, ${r.movies.length} movies`);
  return { slug: t.slug, days: [day], movies: r.movies, showtimes: r.showtimes.map((s) => ({ ...s, show_date: day })) };
}

async function main() {
  if (!DRY && (!TOKEN || !process.env.SUPABASE_URL)) throw new Error('Set SUPABASE_URL and AMC_INGEST_TOKEN (or use --dry)');
  const only = opt('theatre');
  const targets = only
    ? [{ market: only.split('/')[0], slug: only.split('/')[1], tz: 'America/New_York' }]
    : (await fn('targets')).theatres;
  if (!targets.length) { log('No theatres are switched on for scraping.'); return; }

  const started_at = new Date().toISOString();
  const theatres = [], errors = [];
  let pages = 0;
  // One browser, one page per theatre. With more than one theatre switched on, Cloudflare will likely refuse the
  // second; that is recorded and left alone.
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const page = await browser.newPage();
    for (const t of targets) {
      try {
        pages++;
        theatres.push(await scrapeTheatre(page, t));
      } catch (e) {
        errors.push(`${t.slug}: ${e.message}`);
        log(`! ${t.slug}: ${e.message}`);
        if (e.blocked) break; // no point carrying on
      }
    }
  } finally {
    await browser.close();
  }

  const run = { started_at, ok: errors.length === 0, pages, error: errors.join('\n') || null, runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', theatres };
  const count = theatres.reduce((n, t) => n + t.showtimes.length, 0);
  if (DRY) {
    console.log(JSON.stringify({ ...run, theatres: theatres.map((t) => ({ ...t, showtimes: t.showtimes.slice(0, 3), movies: t.movies.slice(0, 3) })) }, null, 2));
    log(`dry run: ${count} showtimes over ${pages} pages`);
  } else {
    const r = await fn('ingest', { run });
    log(`stored ${r.showtimes} showtimes (${r.pruned} dropped) from ${pages} pages`);
  }
  if (errors.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
