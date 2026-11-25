-- Showtimes scraped from amctheatres.com, replacing the AMC developer API (no vendor key to be had).
-- A scheduled scraper (scraper/, run from a PC) reads today's showtimes page of each tracked theatre and sends it
-- to the amc-ingest Edge Function, which calls amc.ingest() below with the service role. Members only read.

-- the API cache is gone with the API
drop table if exists amc.api_cache;

-- ---------------------------------------------------------------------------------------------
-- theatres: which ones the scraper visits
-- ---------------------------------------------------------------------------------------------

alter table amc.theatres
  add column market          text check (market is null or market ~ '^[a-z0-9-]+$'),
  add column scrape          boolean not null default false,
  add column last_scraped_at timestamptz;
alter table amc.theatres add constraint theatres_slug_format check (slug is null or slug ~ '^[a-z0-9-]+$');

insert into amc.theatres (id, name, slug, market, city, state, tz, scrape, added_by) values
  (349, 'AMC Columbia 14',      'amc-columbia-14',      'baltimore',        'Columbia', 'MD', 'America/New_York', true,  null),
  (366, 'AMC Tysons Corner 16', 'amc-tysons-corner-16', 'washington-d-c',   'McLean',   'VA', 'America/New_York', false, null)
on conflict (id) do update set slug = excluded.slug, market = excluded.market, scrape = excluded.scrape;

-- ---------------------------------------------------------------------------------------------
-- scraped data
-- ---------------------------------------------------------------------------------------------

create table amc.movies (
  id         int primary key,                     -- AMC movie number (the tail of its slug)
  slug       text not null,
  name       text not null,
  rating     text,
  run_time   int check (run_time is null or run_time between 1 and 600),  -- minutes
  poster_url text check (poster_url is null or poster_url like 'https://%'),
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table amc.showtimes (
  id             bigint primary key,              -- AMC showtime number (amctheatres.com/showtimes/<id>)
  theatre_id     int not null references amc.theatres (id) on delete cascade,
  movie_id       int not null references amc.movies (id) on delete cascade,
  show_date      date not null,                   -- the AMC business day it is listed under
  starts_at      timestamptz not null,
  format         text not null default 'Standard',
  format_code    text,
  tags           text[] not null default '{}',
  status         text,                            -- AMC's: Sellable, Soldout, ...
  alist_excluded boolean not null default false,
  seen_at        timestamptz not null default now()
);
create index showtimes_theatre_day_idx on amc.showtimes (theatre_id, show_date);
create index showtimes_movie_idx on amc.showtimes (movie_id, starts_at);

-- One row per scraper run, so the site can say how fresh the data is.
create table amc.scrape_runs (
  id          bigint generated always as identity primary key,
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  ok          boolean not null,
  pages       int not null default 0,
  showtimes   int not null default 0,
  error       text check (error is null or length(error) <= 2000),
  runner      text check (runner is null or length(runner) <= 100)
);
create index scrape_runs_finished_idx on amc.scrape_runs (finished_at desc);

alter table amc.movies      enable row level security;
alter table amc.showtimes   enable row level security;
alter table amc.scrape_runs enable row level security;
revoke all on amc.movies, amc.showtimes, amc.scrape_runs from anon, authenticated;
grant select on amc.movies, amc.showtimes, amc.scrape_runs to authenticated;
grant all on amc.movies, amc.showtimes, amc.scrape_runs to service_role;
create policy "members read movies"      on amc.movies      for select to authenticated using (amc.has_access());
create policy "members read showtimes"   on amc.showtimes   for select to authenticated using (amc.has_access());
create policy "members read scrape runs" on amc.scrape_runs for select to authenticated using (amc.has_access());

-- ---------------------------------------------------------------------------------------------
-- ingest: one scraper run in one transaction (service role only)
-- ---------------------------------------------------------------------------------------------
-- p = { started_at, ok, error?, runner?, pages,
--       theatres: [{ slug, id?, name?, days: [ 'YYYY-MM-DD', ... ],
--                    movies: [{ id, slug, name, rating, run_time, poster_url }],
--                    showtimes: [{ id, movie_id, show_date, starts_at, format, format_code, tags, status, alist_excluded }] }] }
-- For every day listed in `days`, showtimes of that theatre on that day that weren't sent are deleted (AMC dropped
-- them). Days not listed are left alone, so a partial run never wipes data it didn't look at.
create function amc.ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t      jsonb;
  tid    int;
  n      int := 0;
  pruned int := 0;
  k      int;
begin
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

    update amc.theatres set last_scraped_at = now() where id = tid;
  end loop;

  -- old showtimes are no use to anyone (outings keep their own copy of what was planned)
  delete from amc.showtimes where starts_at < now() - interval '2 days';

  insert into amc.scrape_runs (started_at, ok, pages, showtimes, error, runner)
  values (coalesce((p->>'started_at')::timestamptz, now()), coalesce((p->>'ok')::boolean, true),
          coalesce((p->>'pages')::int, 0), n, left(p->>'error', 2000), left(p->>'runner', 100));
  delete from amc.scrape_runs where finished_at < now() - interval '30 days';

  return jsonb_build_object('showtimes', n, 'pruned', pruned);
end $$;
revoke all on function amc.ingest(jsonb) from public, anon, authenticated;
grant execute on function amc.ingest(jsonb) to service_role;
