-- Plan by day. What matters is which days a movie is on, not its exact showtimes: a showing now has a date
-- (show_date) and, only if someone knows it, a time. The A-List rules count by date; the no-overlap rule only applies
-- when both showings have times. The scraper also records every day it has read (even a day with nothing on) and is
-- told which days the group has plans or pencil marks on, so those get read first.

-- the A-List week (its Friday) for a calendar day; same answer as alist_week() for any time that day after 6 AM
create function amc.day_week(d date) returns date
language sql immutable set search_path = '' as $$
  select d - ((extract(dow from d)::int - 5 + 7) % 7)
$$;
grant execute on function amc.day_week(date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- outings: a date, and maybe a time
-- ---------------------------------------------------------------------------------------------

alter table amc.outings add column show_date date;
update amc.outings set show_date = ((starts_at at time zone tz) - interval '6 hours')::date;
alter table amc.outings
  alter column show_date set not null,
  alter column starts_at drop not null,
  alter column ends_at drop not null,
  add constraint outings_time_pair check ((starts_at is null) = (ends_at is null));
create index outings_day_idx on amc.outings (show_date);

-- fill in the date from the time (a 1 AM show belongs to the day before), and a length if only a start is given
create function amc.outings_day() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.starts_at is not null and new.ends_at is null then new.ends_at := new.starts_at + interval '150 minutes'; end if;
  if new.starts_at is null then new.ends_at := null; end if;
  if new.show_date is null then
    if new.starts_at is null then raise exception 'A showing needs a date or a time' using errcode = 'not_null_violation'; end if;
    new.show_date := ((new.starts_at at time zone new.tz) - interval '6 hours')::date;
  end if;
  return new;
end $$;
create trigger outings_day before insert or update on amc.outings
  for each row execute function amc.outings_day();

create or replace function amc.check_alist(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  who text;
begin
  select coalesce(nullif(p.display_name, ''), p.handle, 'This member') into who
  from public.profiles p where p.user_id = p_user;
  who := coalesce(who, 'This member');

  -- 4 per A-List week (planned, reserved, used and no-shows all count), by the showing's date
  select amc.day_week(o.show_date) as wk, count(*) as n into r
  from amc.attendees a join amc.outings o on o.id = a.outing_id
  where a.user_id = p_user and a.status <> 'cancelled'
  group by 1 having count(*) > 4 limit 1;
  if found then
    raise exception '% already has 4 movies in the A-List week starting Friday %', who, to_char(r.wk, 'Mon FMDD')
      using errcode = 'check_violation';
  end if;

  -- 4 pending reservations at a time (a showing without a time is upcoming until its day is over)
  if (select count(*) from amc.attendees a join amc.outings o on o.id = a.outing_id
      where a.user_id = p_user and a.status = 'reserved'
        and coalesce(o.starts_at > now(), o.show_date >= (now() at time zone o.tz)::date)) > 4 then
    raise exception '% already holds 4 upcoming reservations (A-List allows 4 at a time)', who
      using errcode = 'check_violation';
  end if;

  -- no overlapping showtimes (only showings with a time can overlap)
  select o1.movie_name as a_name, o2.movie_name as b_name into r
  from amc.attendees a1 join amc.outings o1 on o1.id = a1.outing_id
  join amc.attendees a2 on a2.user_id = a1.user_id and a2.outing_id > a1.outing_id
  join amc.outings o2 on o2.id = a2.outing_id
  where a1.user_id = p_user and a1.status <> 'cancelled' and a2.status <> 'cancelled'
    and o1.starts_at is not null and o2.starts_at is not null
    and tstzrange(o1.starts_at, o1.ends_at) && tstzrange(o2.starts_at, o2.ends_at)
  limit 1;
  if found then
    raise exception '% would be in two showings at once (% and %)', who, r.a_name, r.b_name
      using errcode = 'check_violation';
  end if;
end $$;

-- moving a showing to another day or time re-checks everyone going
drop trigger outings_after on amc.outings;
create trigger outings_after after update of starts_at, ends_at, tz, show_date on amc.outings
  for each row execute function amc.outings_after();

drop view amc.admissions;
create view amc.admissions with (security_invoker = true) as
  select a.user_id, a.status, a.seat, o.*, amc.day_week(o.show_date) as alist_week,
         coalesce(o.starts_at > now(), o.show_date >= (now() at time zone o.tz)::date) as upcoming
  from amc.attendees a join amc.outings o on o.id = a.outing_id;
grant select on amc.admissions to authenticated;
grant all on amc.admissions to service_role;

-- planning: a showtime, or just a movie on a day. Two people planning the same movie on the same day (no time)
-- share one showing.
create or replace function amc.plan_showing(p_outing jsonb, p_people uuid[], p_status text default 'planned') returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  oid uuid;
  st  timestamptz := (p_outing->>'starts_at')::timestamptz;
  d   date := (p_outing->>'show_date')::date;
begin
  if not amc.has_access() then raise exception 'No access to the planner' using errcode = 'insufficient_privilege'; end if;
  if p_status not in ('planned', 'reserved') then raise exception 'Status must be planned or reserved'; end if;
  if coalesce(array_length(p_people, 1), 0) = 0 then raise exception 'Pick at least one person'; end if;
  if st is null and d is null and p_outing->>'id' is null then raise exception 'Pick a day'; end if;

  if p_outing->>'id' is not null then
    select id into oid from amc.outings where id = (p_outing->>'id')::uuid;
    if oid is null then raise exception 'That showing no longer exists'; end if;
  elsif p_outing->>'showtime_id' is not null then
    select id into oid from amc.outings where showtime_id = (p_outing->>'showtime_id')::bigint;
  elsif st is null then
    select id into oid from amc.outings
    where show_date = d and starts_at is null and movie_name = p_outing->>'movie_name'
      and theatre_id is not distinct from (p_outing->>'theatre_id')::int
    limit 1;
  end if;
  if oid is null then
    insert into amc.outings (showtime_id, movie_id, movie_name, movie_slug, poster_url, theatre_id, theatre_name,
                             auditorium, format, show_date, starts_at, ends_at, tz, purchase_url, note)
    values ((p_outing->>'showtime_id')::bigint, (p_outing->>'movie_id')::int, p_outing->>'movie_name',
            p_outing->>'movie_slug', p_outing->>'poster_url', (p_outing->>'theatre_id')::int, p_outing->>'theatre_name',
            (p_outing->>'auditorium')::int, p_outing->>'format', d, st,
            case when st is null then null else coalesce((p_outing->>'ends_at')::timestamptz, st + interval '150 minutes') end,
            coalesce(nullif(p_outing->>'tz', ''), 'America/New_York'), p_outing->>'purchase_url', p_outing->>'note')
    returning id into oid;
  end if;

  insert into amc.attendees (outing_id, user_id, status)
  select oid, u, p_status from unnest(p_people) as u
  on conflict (outing_id, user_id) do update
    set status = case when amc.attendees.status = 'cancelled' or excluded.status = 'reserved'
                      then excluded.status else amc.attendees.status end;
  return oid;
end $$;

-- ---------------------------------------------------------------------------------------------
-- days the scraper has read, and days it should read first
-- ---------------------------------------------------------------------------------------------

create table amc.days_read (
  theatre_id int not null references amc.theatres (id) on delete cascade,
  show_date  date not null,
  read_at    timestamptz not null default now(),
  showtimes  int not null default 0,
  primary key (theatre_id, show_date)
);
insert into amc.days_read (theatre_id, show_date, read_at, showtimes)
select theatre_id, show_date, max(seen_at), count(*) from amc.showtimes group by 1, 2;

alter table amc.days_read enable row level security;
revoke all on amc.days_read from anon, authenticated;
grant select on amc.days_read to authenticated;
grant all on amc.days_read to service_role;
create policy "members read days read" on amc.days_read for select to authenticated using (amc.has_access());

-- Days with a plan or a pencil mark that a tracked theatre hasn't read lately: the next two weeks again after 20
-- hours, further out after 3 days (far-off schedules barely change).
create function amc.scrape_wants() returns table (theatre_id int, day date)
language sql stable security definer set search_path = '' as $$
  with today as (select (now() at time zone 'America/New_York')::date as d),
  wanted as (
    select o.show_date as day, o.theatre_id from amc.outings o, today where o.show_date between today.d and today.d + 60
    union
    select p.day, null from amc.picks p, today where p.day between today.d and today.d + 60
  )
  select distinct t.id, w.day
  from amc.theatres t join wanted w on w.theatre_id is null or w.theatre_id = t.id, today
  where t.scrape
    and not exists (
      select 1 from amc.days_read r
      where r.theatre_id = t.id and r.show_date = w.day
        and r.read_at > now() - case when w.day <= today.d + 14 then interval '20 hours' else interval '3 days' end)
  order by 2
$$;
revoke all on function amc.scrape_wants() from public, anon, authenticated;
grant execute on function amc.scrape_wants() to service_role;

-- ingest also notes each day it read, with how many showtimes it had
create or replace function amc.ingest(p jsonb) returns jsonb
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

  return jsonb_build_object('showtimes', n, 'pruned', pruned);
end $$;
