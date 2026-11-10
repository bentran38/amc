-- AMC A-List planner. Everything lives in its own `amc` schema, separate from the dashboard's `public`.
-- The schema must also be listed under Settings > API > Exposed schemas so the client can reach it.
-- Only users with access to the 'amc' project (public.project_access) can read or write anything here,
-- and everyone with that access is one "entourage": they see each other's plans and can plan for each
-- other (like AMC's A-List Entourage feature, which lets members reserve on behalf of one another).
--
-- A-List rules enforced in the database (AMC Stubs A-List terms, checked November 2026):
--   * up to 4 showtimes per A-List week. A "week" runs Friday 6:00 a.m. to the next Friday 5:59 a.m.
--     (theatre local time). Unused and no-show reservations still count, so past showings count too;
--   * no more than 4 pending (upcoming) reservations at any one time, whatever week they fall in;
--   * several showtimes may be on the same day as long as they don't overlap.
-- Plans that are not reserved yet still count toward the weekly 4 (you can't watch a fifth), but only
-- reservations count toward the 4-at-a-time limit: a plan beyond it is allowed and shown as "reserve
-- once one of your current reservations has been used".

create schema if not exists amc;
grant usage on schema amc to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- access
-- ---------------------------------------------------------------------------------------------

create function amc.is_member(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.project_access a where a.user_id = p_user and a.project_slug = 'amc')
$$;

create function amc.has_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select amc.is_member((select auth.uid()))
$$;
revoke all on function amc.is_member(uuid), amc.has_access() from public, anon;
grant execute on function amc.is_member(uuid), amc.has_access() to authenticated, service_role;

-- The entourage: everyone with access, with their profile name. project_access only shows a user their
-- own rows, so this is a definer function that answers only for members.
create function amc.members() returns table (user_id uuid, handle text, display_name text)
language sql stable security definer set search_path = '' as $$
  select a.user_id, p.handle, coalesce(nullif(p.display_name, ''), p.handle, 'Member')
  from public.project_access a
  left join public.profiles p on p.user_id = a.user_id
  where a.project_slug = 'amc' and amc.has_access()
  order by 3
$$;
revoke all on function amc.members() from public, anon;
grant execute on function amc.members() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- the A-List week
-- ---------------------------------------------------------------------------------------------

-- The Friday (a date) that starts the A-List week containing `ts`, in time zone `tz`.
-- Shifting back 6 hours makes "Friday 6:00 a.m." the start of the day, so Friday 5:59 a.m. still
-- belongs to the week before.
create function amc.alist_week(ts timestamptz, tz text) returns date
language sql immutable set search_path = '' as $$
  select (s::date - ((extract(dow from s)::int - 5 + 7) % 7))
  from (select (ts at time zone tz) - interval '6 hours' as s) x
$$;
grant execute on function amc.alist_week(timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------------------------

-- Theatres the group goes to (shared list). Filled from the AMC API, or by hand.
create table amc.theatres (
  id         int primary key,                -- AMC theatre number
  name       text not null,
  slug       text,
  city       text,
  state      text,
  tz         text not null default 'America/New_York',
  added_by   uuid default auth.uid() references auth.users (id) on delete set null,
  added_at   timestamptz not null default now()
);

-- A showing someone in the group plans to go to. One row per showtime; who is going is in attendees.
create table amc.outings (
  id            uuid primary key default gen_random_uuid(),
  showtime_id   bigint unique,                 -- AMC showtime / performance number (null if entered by hand)
  movie_id      int,
  movie_name    text not null check (length(movie_name) between 1 and 200),
  movie_slug    text,
  poster_url    text check (poster_url is null or poster_url like 'https://%'),
  theatre_id    int,
  theatre_name  text not null check (length(theatre_name) between 1 and 200),
  auditorium    int,
  format        text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  tz            text not null default 'America/New_York',
  purchase_url  text check (purchase_url is null or purchase_url like 'https://%'),
  note          text check (note is null or length(note) <= 500),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '8 hours'),
  check (tz <> '')
);
create index outings_starts_idx on amc.outings (starts_at);

-- Who is going to an outing. Each row uses one of that person's A-List admissions.
create table amc.attendees (
  outing_id  uuid not null references amc.outings (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  status     text not null default 'planned' check (status in ('planned', 'reserved', 'cancelled')),
  seat       text check (seat is null or length(seat) <= 20),
  added_by   uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (outing_id, user_id)
);
create index attendees_user_idx on amc.attendees (user_id);

-- Movies someone wants to see, so the group can line up what to spend the weekly admissions on.
create table amc.wants (
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  movie_id     int  not null,
  movie_name   text not null,
  movie_slug   text,
  poster_url   text check (poster_url is null or poster_url like 'https://%'),
  release_date date,
  created_at   timestamptz not null default now(),
  primary key (user_id, movie_id)
);

-- AMC API responses, cached by the amc-api Edge Function (service role only).
create table amc.api_cache (
  key        text primary key,
  body       jsonb not null,
  fetched_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- A-List rule checks
-- ---------------------------------------------------------------------------------------------

-- Checks one person's admissions after a change. Raises with a readable message if a rule breaks.
create function amc.check_alist(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  who text;
begin
  select coalesce(nullif(p.display_name, ''), p.handle, 'This member') into who
  from public.profiles p where p.user_id = p_user;
  who := coalesce(who, 'This member');

  -- 4 per A-List week (planned, reserved, used and no-shows all count)
  select amc.alist_week(o.starts_at, o.tz) as wk, count(*) as n into r
  from amc.attendees a join amc.outings o on o.id = a.outing_id
  where a.user_id = p_user and a.status <> 'cancelled'
  group by 1 having count(*) > 4 limit 1;
  if found then
    raise exception '% already has 4 movies in the A-List week starting Friday %', who, to_char(r.wk, 'Mon FMDD')
      using errcode = 'check_violation';
  end if;

  -- 4 pending reservations at a time
  if (select count(*) from amc.attendees a join amc.outings o on o.id = a.outing_id
      where a.user_id = p_user and a.status = 'reserved' and o.starts_at > now()) > 4 then
    raise exception '% already holds 4 upcoming reservations (A-List allows 4 at a time)', who
      using errcode = 'check_violation';
  end if;

  -- no overlapping showtimes
  select o1.movie_name as a_name, o2.movie_name as b_name into r
  from amc.attendees a1 join amc.outings o1 on o1.id = a1.outing_id
  join amc.attendees a2 on a2.user_id = a1.user_id and a2.outing_id > a1.outing_id
  join amc.outings o2 on o2.id = a2.outing_id
  where a1.user_id = p_user and a1.status <> 'cancelled' and a2.status <> 'cancelled'
    and tstzrange(o1.starts_at, o1.ends_at) && tstzrange(o2.starts_at, o2.ends_at)
  limit 1;
  if found then
    raise exception '% would be in two showings at once (% and %)', who, r.a_name, r.b_name
      using errcode = 'check_violation';
  end if;
end $$;
revoke all on function amc.check_alist(uuid) from public, anon, authenticated;

create function amc.attendees_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then return old; end if;
  if not amc.is_member(new.user_id) then
    raise exception 'Only members of the group can be added to a showing' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

create function amc.attendees_after() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- one person's changes are checked one at a time, so two people booking at once can't both slip past
  perform pg_advisory_xact_lock(hashtext('amc:' || new.user_id::text));
  perform amc.check_alist(new.user_id);
  return null;
end $$;

create trigger attendees_check before insert or update on amc.attendees
  for each row execute function amc.attendees_check();
create trigger attendees_after after insert or update on amc.attendees
  for each row execute function amc.attendees_after();

-- moving an outing's time re-checks everyone going
create function amc.outings_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u uuid;
begin
  for u in select user_id from amc.attendees where outing_id = new.id loop
    perform pg_advisory_xact_lock(hashtext('amc:' || u::text));
    perform amc.check_alist(u);
  end loop;
  return null;
end $$;
create trigger outings_after after update of starts_at, ends_at, tz on amc.outings
  for each row execute function amc.outings_after();

-- ---------------------------------------------------------------------------------------------
-- a person's admissions, with the A-List week each falls in
-- ---------------------------------------------------------------------------------------------

create view amc.admissions with (security_invoker = true) as
  select a.user_id, a.status, a.seat, o.*, amc.alist_week(o.starts_at, o.tz) as alist_week,
         (o.starts_at > now()) as upcoming
  from amc.attendees a join amc.outings o on o.id = a.outing_id;

-- ---------------------------------------------------------------------------------------------
-- planning a showing in one step: find or create the outing for that showtime, then add people.
-- Runs with the caller's rights (RLS applies) and in one transaction, so if anyone breaks a rule
-- nothing is saved.
-- ---------------------------------------------------------------------------------------------

create function amc.plan_showing(p_outing jsonb, p_people uuid[], p_status text default 'planned') returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  oid uuid;
  st  timestamptz := (p_outing->>'starts_at')::timestamptz;
begin
  if not amc.has_access() then raise exception 'No access to the planner' using errcode = 'insufficient_privilege'; end if;
  if p_status not in ('planned', 'reserved') then raise exception 'Status must be planned or reserved'; end if;
  if coalesce(array_length(p_people, 1), 0) = 0 then raise exception 'Pick at least one person'; end if;

  if p_outing->>'id' is not null then
    select id into oid from amc.outings where id = (p_outing->>'id')::uuid;
    if oid is null then raise exception 'That showing no longer exists'; end if;
  elsif p_outing->>'showtime_id' is not null then
    select id into oid from amc.outings where showtime_id = (p_outing->>'showtime_id')::bigint;
  end if;
  if oid is null then
    insert into amc.outings (showtime_id, movie_id, movie_name, movie_slug, poster_url, theatre_id, theatre_name,
                             auditorium, format, starts_at, ends_at, tz, purchase_url, note)
    values ((p_outing->>'showtime_id')::bigint, (p_outing->>'movie_id')::int, p_outing->>'movie_name',
            p_outing->>'movie_slug', p_outing->>'poster_url', (p_outing->>'theatre_id')::int, p_outing->>'theatre_name',
            (p_outing->>'auditorium')::int, p_outing->>'format', st,
            coalesce((p_outing->>'ends_at')::timestamptz, st + interval '150 minutes'),
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
revoke all on function amc.plan_showing(jsonb, uuid[], text) from public, anon;
grant execute on function amc.plan_showing(jsonb, uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- row-level security: members see everything and plan for each other; wants are your own
-- ---------------------------------------------------------------------------------------------

alter table amc.theatres  enable row level security;
alter table amc.outings   enable row level security;
alter table amc.attendees enable row level security;
alter table amc.wants     enable row level security;
alter table amc.api_cache enable row level security;

revoke all on all tables in schema amc from anon, authenticated;
grant select, insert, update, delete on amc.theatres, amc.outings, amc.attendees, amc.wants to authenticated;
grant select on amc.admissions to authenticated;
grant all on all tables in schema amc to service_role;

create policy "members read theatres"   on amc.theatres  for select to authenticated using (amc.has_access());
create policy "members add theatres"    on amc.theatres  for insert to authenticated with check (amc.has_access());
create policy "members edit theatres"   on amc.theatres  for update to authenticated using (amc.has_access()) with check (amc.has_access());
create policy "members remove theatres" on amc.theatres  for delete to authenticated using (amc.has_access());

create policy "members read outings"    on amc.outings   for select to authenticated using (amc.has_access());
create policy "members add outings"     on amc.outings   for insert to authenticated with check (amc.has_access());
create policy "members edit outings"    on amc.outings   for update to authenticated using (amc.has_access()) with check (amc.has_access());
create policy "members remove outings"  on amc.outings   for delete to authenticated using (amc.has_access());

create policy "members read attendees"   on amc.attendees for select to authenticated using (amc.has_access());
create policy "members add attendees"    on amc.attendees for insert to authenticated with check (amc.has_access());
create policy "members edit attendees"   on amc.attendees for update to authenticated using (amc.has_access()) with check (amc.has_access());
create policy "members remove attendees" on amc.attendees for delete to authenticated using (amc.has_access());

create policy "members read wants" on amc.wants for select to authenticated using (amc.has_access());
create policy "own wants insert"   on amc.wants for insert to authenticated with check (amc.has_access() and user_id = (select auth.uid()));
create policy "own wants update"   on amc.wants for update to authenticated using (user_id = (select auth.uid())) with check (amc.has_access() and user_id = (select auth.uid()));
create policy "own wants delete"   on amc.wants for delete to authenticated using (user_id = (select auth.uid()));
