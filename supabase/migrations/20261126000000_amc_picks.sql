-- Movies pencilled in for a day without a showtime yet: dropped on a day whose showtimes haven't been read, or a day
-- the movie isn't showing. The planner marks them with a warning until someone picks an actual showing (which clears
-- the pick). Shared by the whole entourage, like everything else in the plan; they don't use an A-List admission.

create table amc.picks (
  id         uuid primary key default gen_random_uuid(),
  day        date not null,
  movie_id   int,
  movie_name text not null check (length(movie_name) between 1 and 200),
  movie_slug text check (movie_slug is null or movie_slug ~ '^[a-z0-9-]+$'),
  poster_url text check (poster_url is null or poster_url like 'https://%'),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (day, movie_name)
);
create index picks_day_idx on amc.picks (day);

alter table amc.picks enable row level security;
revoke all on amc.picks from anon, authenticated;
grant select, insert, update, delete on amc.picks to authenticated;
grant all on amc.picks to service_role;
create policy "members read picks"   on amc.picks for select to authenticated using (amc.has_access());
create policy "members add picks"    on amc.picks for insert to authenticated with check (amc.has_access());
create policy "members move picks"   on amc.picks for update to authenticated using (amc.has_access()) with check (amc.has_access());
create policy "members remove picks" on amc.picks for delete to authenticated using (amc.has_access());
