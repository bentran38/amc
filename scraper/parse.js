// Pure parsers for AMC's showtimes page. amctheatres.com is a Next.js app that streams its data into the page as
// `self.__next_f.push([1, "<chunk>"])` scripts; joined together the chunks hold every showtime as a JSON object.
// Nothing here touches the network, so it can be tested against a saved page.

/** The page's streamed data (the __next_f chunks, decoded and joined). */
export function flightData(html) {
  const out = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { out.push(JSON.parse(m[1])); } catch { /* a chunk we can't read is skipped */ }
  }
  return out.join('');
}

/** AMC's movie number is the tail of its slug: "disney-s-hexed-72478" -> 72478. */
export const movieIdFromSlug = (slug) => {
  const m = /-(\d+)$/.exec(slug ?? '');
  return m ? Number(m[1]) : null;
};

/** The theatre this page is for: { id, name, slug, utcOffset } (null if the page doesn't say). */
export function parseTheatre(data, slug) {
  const re = new RegExp(`\\{"slug":"${slug.replace(/[^a-z0-9-]/g, '')}","name":"((?:[^"\\\\]|\\\\.)*)"[^{}]*?"theatreId":(\\d+)[^{}]*?"utcOffset":"([^"]*)"`);
  const m = re.exec(data);
  return m ? { id: Number(m[2]), name: JSON.parse(`"${m[1]}"`), slug, utcOffset: m[3] } : null;
}

/**
 * Every showtime object on the page. Each one sits next to an aria-describedby list that names its movie and
 * format group: "<movie> <movie>-<theatre> <movie>-<theatre>-<format> <movie>-<theatre>-<format>-<n> ...-attributes".
 */
export function parseShowtimes(data) {
  const out = new Map();
  const re = /"showtime":(\{"showtimeId":\d+(?:[^{}]|\{[^{}]*\})*\}),"selectTheatreOnClick":(?:"[^"]*"|null|true|false),"aria-describedby":"([^"]+)"/g;
  for (const m of data.matchAll(re)) {
    let s;
    try { s = JSON.parse(m[1]); } catch { continue; }
    const ids = m[2].split(' ');
    const [movieSlug, theatrePart, formatPart, group] = ids;
    if (!movieSlug || !s.showDateTimeUtc) continue;
    out.set(s.showtimeId, {
      id: s.showtimeId,
      utc: s.showDateTimeUtc,
      status: s.status ?? null,
      movieSlug,
      movieId: movieIdFromSlug(movieSlug),
      formatCode: theatrePart && formatPart?.startsWith(`${theatrePart}-`) ? formatPart.slice(theatrePart.length + 1) : null,
      group: group ?? null,
    });
  }
  return [...out.values()];
}

/** The movies on the page by slug: { id, slug, name, rating, runTime, poster }. */
export function parseMovies(data) {
  const out = new Map();
  // the short list: {"name":"Disney's Hexed","slug":"disney-s-hexed-72478","movieId":72478}
  for (const m of data.matchAll(/\{"name":"((?:[^"\\]|\\.)*)","slug":"([a-z0-9-]+)","movieId":(\d+)\}/g)) {
    out.set(m[2], { id: Number(m[3]), slug: m[2], name: JSON.parse(`"${m[1]}"`), rating: null, runTime: null, poster: null });
  }
  // each movie's section header carries the details, in an object that starts like
  // "activeSectionId":"<slug>","value":{"avatarImage":{"url":...},"name":...,"mpaaRating":...,...,"runTime":128
  for (const m of data.matchAll(/"activeSectionId":"([a-z0-9-]+)","value":\{/g)) {
    const slug = m[1];
    const chunk = data.slice(m.index, m.index + 4000);
    const end = chunk.indexOf('"runTimeAttributes"');
    const head = end > 0 ? chunk.slice(0, end) : chunk.slice(0, 2500);
    const str = (re) => { const x = re.exec(head); try { return x ? JSON.parse(x[1]) : null; } catch { return null; } };
    const name = str(/"name":("(?:[^"\\]|\\.)*")/);
    const rating = str(/"mpaaRating":("[^"]*")/);
    const poster = str(/"avatarImage":\{"url":("https:\/\/[^"]*")/);
    const run = /"runTime":(\d+)/.exec(head);
    const prev = out.get(slug) ?? { id: movieIdFromSlug(slug), slug, name };
    out.set(slug, { ...prev, name: prev.name ?? name, rating: rating ?? prev.rating ?? null, runTime: run ? Number(run[1]) : prev.runTime ?? null, poster: poster ?? prev.poster ?? null });
  }
  return out;
}

/** The dates AMC offers in the page's date picker (YYYY-MM-DD, sorted). */
export function parseDates(data) {
  return [...new Set([...data.matchAll(/\["\$","option","(\d{4}-\d{2}-\d{2})",/g)].map((m) => m[1]))].sort();
}

// Showtimes that aren't a movie you'd use A-List on.
const NOT_A_MOVIE = /^private-theatre-rental/;

/**
 * One page's worth of data, ready to store. `groups` maps a format group id to { name, tags } (read from the page's
 * DOM by the scraper, since the streamed data only references them indirectly).
 */
export function showtimesPage(html, { theatreSlug, groups = {} }) {
  const data = flightData(html);
  const theatre = parseTheatre(data, theatreSlug);
  const movies = parseMovies(data);
  const showtimes = parseShowtimes(data)
    .filter((s) => s.movieId && !NOT_A_MOVIE.test(s.movieSlug))
    .map((s) => {
      const g = groups[s.group] ?? {};
      const tags = g.tags ?? [];
      return {
        id: s.id,
        movie_id: s.movieId,
        starts_at: s.utc,
        format: g.name ?? s.formatCode ?? 'Standard',
        format_code: s.formatCode,
        tags,
        status: s.status,
        alist_excluded: tags.some((t) => /excluded from a-list/i.test(t)),
      };
    });
  const used = new Set(showtimes.map((s) => s.movie_id));
  return {
    theatre,
    dates: parseDates(data),
    movies: [...movies.values()].filter((m) => used.has(m.id)).map((m) => ({ id: m.id, slug: m.slug, name: m.name, rating: m.rating, run_time: m.runTime, poster_url: m.poster })),
    showtimes,
  };
}

/** Is this the Cloudflare block page rather than AMC's? */
export const isBlocked = (html, title = '') =>
  /Attention Required|Just a moment|cf-error-details|challenge-platform\/h\/[a-z]\/orchestrate/i.test(title + html.slice(0, 20000)) && !html.includes('__next_f');
