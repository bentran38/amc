-- One kind of entry: a person is going to a showing. Planned vs reserved (and cancelled) are gone; taking someone off
-- a showing removes them. With them goes the "4 reservations at a time" check, since the planner no longer knows what
-- is booked. The 4-a-week limit and the no-overlap check stay.

update amc.attendees set status = 'planned' where status <> 'planned';
alter table amc.attendees drop constraint attendees_status_check;
alter table amc.attendees add constraint attendees_status_check check (status = 'planned');

create or replace function amc.check_alist(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  who text;
begin
  select coalesce(nullif(p.display_name, ''), p.handle, 'This member') into who
  from public.profiles p where p.user_id = p_user;
  who := coalesce(who, 'This member');

  -- 4 per A-List week, by the showing's date (watched, no-shows and plans all count)
  select amc.day_week(o.show_date) as wk, count(*) as n into r
  from amc.attendees a join amc.outings o on o.id = a.outing_id
  where a.user_id = p_user
  group by 1 having count(*) > 4 limit 1;
  if found then
    raise exception '% already has 4 movies in the A-List week starting Friday %', who, to_char(r.wk, 'Mon FMDD')
      using errcode = 'check_violation';
  end if;

  -- no overlapping showtimes (only showings with a time can overlap)
  select o1.movie_name as a_name, o2.movie_name as b_name into r
  from amc.attendees a1 join amc.outings o1 on o1.id = a1.outing_id
  join amc.attendees a2 on a2.user_id = a1.user_id and a2.outing_id > a1.outing_id
  join amc.outings o2 on o2.id = a2.outing_id
  where a1.user_id = p_user
    and o1.starts_at is not null and o2.starts_at is not null
    and tstzrange(o1.starts_at, o1.ends_at) && tstzrange(o2.starts_at, o2.ends_at)
  limit 1;
  if found then
    raise exception '% would be in two showings at once (% and %)', who, r.a_name, r.b_name
      using errcode = 'check_violation';
  end if;
end $$;

-- p_status is still accepted (older pages send it) but there is only one kind of entry now
create or replace function amc.plan_showing(p_outing jsonb, p_people uuid[], p_status text default 'planned') returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  oid uuid;
  st  timestamptz := (p_outing->>'starts_at')::timestamptz;
  d   date := (p_outing->>'show_date')::date;
begin
  if not amc.has_access() then raise exception 'No access to the planner' using errcode = 'insufficient_privilege'; end if;
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
  select oid, u, 'planned' from unnest(p_people) as u
  on conflict (outing_id, user_id) do nothing;
  return oid;
end $$;
