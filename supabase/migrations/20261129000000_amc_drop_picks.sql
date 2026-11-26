-- No more pencil marks: the plan is planned and reserved showings only. Days the scraper reads first are the days
-- with something planned.

create or replace function amc.scrape_wants() returns table (theatre_id int, day date)
language sql stable security definer set search_path = '' as $$
  with today as (select (now() at time zone 'America/New_York')::date as d)
  select distinct t.id, o.show_date
  from amc.theatres t
  join amc.outings o on o.theatre_id is null or o.theatre_id = t.id
  cross join today
  where t.scrape
    and o.show_date between today.d and today.d + 60
    and not exists (
      select 1 from amc.days_read r
      where r.theatre_id = t.id and r.show_date = o.show_date
        and r.read_at > now() - case when o.show_date <= today.d + 14 then interval '20 hours' else interval '3 days' end)
  order by 2
$$;

drop table amc.picks;
