-- Release dates from AMC's movies page (Now Playing, Events, Coming Soon), which the scraper reads once a day. The
-- planner counts a movie as expected on the days after it opens (about four weeks for a film, a week for an
-- anniversary reissue, the day itself for an event) until AMC posts that day's showtimes.

alter table amc.movies
  add column release_date   date,
  add column release_status text check (release_status is null or release_status in ('released', 'opening')),
  add column release_kind   text not null default 'film' check (release_kind in ('film', 'reissue', 'event')),
  add column listed_at      timestamptz;  -- last seen on AMC's movies page
create index movies_release_idx on amc.movies (release_date);

-- ingest also takes { releases: [{ id, slug, name, rating, run_time, poster_url, release_date, status, kind }] }
create or replace function amc.ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t      jsonb;
  tid    int;
  n      int := 0;
  pruned int := 0;
  rel    int := 0;
  k      int;
begin
  -- AMC's movies page: every movie it lists, with its opening date (once a day; see scraper/scrape.js)
  insert into amc.movies (id, slug, name, rating, run_time, poster_url, release_date, release_status, release_kind, listed_at)
  select r.id, r.slug, r.name, r.rating, r.run_time, r.poster_url, r.release_date,
         case when r.status in ('released', 'opening') then r.status end,
         case when r.kind in ('film', 'reissue', 'event') then r.kind else 'film' end, now()
  from jsonb_to_recordset(coalesce(p->'releases', '[]'::jsonb))
    as r(id int, slug text, name text, rating text, run_time int, poster_url text, release_date date, status text, kind text)
  where r.id is not null and r.name is not null and r.slug is not null
    and (r.poster_url is null or r.poster_url like 'https://%') and (r.run_time is null or r.run_time between 1 and 600)
  on conflict (id) do update set
    slug = excluded.slug, name = excluded.name,
    rating = coalesce(excluded.rating, amc.movies.rating),
    run_time = coalesce(excluded.run_time, amc.movies.run_time),
    poster_url = coalesce(excluded.poster_url, amc.movies.poster_url),
    release_date = coalesce(excluded.release_date, amc.movies.release_date),
    release_status = coalesce(excluded.release_status, amc.movies.release_status),
    release_kind = excluded.release_kind, listed_at = now(), updated_at = now();
  get diagnostics rel = row_count;

  for t in select * from jsonb_array_elements(coalesce(p->'theatres', '[]'::jsonb)) loop
    select id into tid from amc.theatres where slug = t->>'slug';
    if tid is null then continue; end if;

    insert into amc.movies (id, slug, name, rating, run_time, poster_url)
    select m.id, m.slug, m.name, m.rating, m.run_time, m.poster_url
    from jsonb_to_recordset(coalesce(t->'movies', '[]'::jsonb))
      as m(id int, slug text, name text, rating text, run_time int, poster_url text)
    where m.id is not null and m.name is not null and m.slug is not null
    on conflict (id) do update set
      slug = excluded.slug, name = excluded.name,
      rating = coalesce(excluded.rating, amc.movies.rating),
      run_time = coalesce(excluded.run_time, amc.movies.run_time),
      poster_url = coalesce(excluded.poster_url, amc.movies.poster_url),
      updated_at = now();

    insert into amc.showtimes (id, theatre_id, movie_id, show_date, starts_at, format, format_code, tags, status, alist_excluded, seen_at)
    select s.id, tid, s.movie_id, s.show_date, s.starts_at, coalesce(nullif(s.format, ''), 'Standard'), s.format_code,
           coalesce(s.tags, '{}'), s.status, coalesce(s.alist_excluded, false), now()
    from jsonb_to_recordset(coalesce(t->'showtimes', '[]'::jsonb))
      as s(id bigint, movie_id int, show_date date, starts_at timestamptz, format text, format_code text,
           tags text[], status text, alist_excluded boolean)
    where s.id is not null and s.starts_at is not null and s.show_date is not null
      and exists (select 1 from amc.movies m where m.id = s.movie_id)
    on conflict (id) do update set
      theatre_id = excluded.theatre_id, movie_id = excluded.movie_id, show_date = excluded.show_date,
      starts_at = excluded.starts_at, format = excluded.format, format_code = excluded.format_code,
      tags = excluded.tags, status = excluded.status, alist_excluded = excluded.alist_excluded, seen_at = now();
    get diagnostics k = row_count;
    n := n + k;

    delete from amc.showtimes s
    where s.theatre_id = tid
      and s.show_date in (select d::date from jsonb_array_elements_text(coalesce(t->'days', '[]'::jsonb)) d)
      and s.id not in (select (x->>'id')::bigint from jsonb_array_elements(coalesce(t->'showtimes', '[]'::jsonb)) x
                       where x->>'id' is not null);
    get diagnostics k = row_count;
    pruned := pruned + k;

    insert into amc.days_read (theatre_id, show_date, read_at, showtimes)
    select tid, d::date, now(), (select count(*) from amc.showtimes s where s.theatre_id = tid and s.show_date = d::date)
    from jsonb_array_elements_text(coalesce(t->'days', '[]'::jsonb)) d
    on conflict (theatre_id, show_date) do update set read_at = now(), showtimes = excluded.showtimes;

    update amc.theatres set last_scraped_at = now() where id = tid;
  end loop;

  -- old showtimes are no use to anyone (outings keep their own copy of what was planned)
  delete from amc.showtimes where starts_at < now() - interval '2 days';
  delete from amc.days_read where show_date < (now() at time zone 'America/New_York')::date - 3;

  insert into amc.scrape_runs (started_at, ok, pages, showtimes, error, runner)
  values (coalesce((p->>'started_at')::timestamptz, now()), coalesce((p->>'ok')::boolean, true),
          coalesce((p->>'pages')::int, 0), n, left(p->>'error', 2000), left(p->>'runner', 100));
  delete from amc.scrape_runs where finished_at < now() - interval '30 days';

  return jsonb_build_object('showtimes', n, 'pruned', pruned, 'releases', rel);
end $$;
