-- 0006: reporting stays open until the morning after the night.
--
-- Nights run 18:00 to 20:30. Nobody should have to chase people round the room
-- at 20:25, and nobody should lose their result because they left in a hurry.
-- You can report on the way home, or over breakfast. Organisers settle when
-- convenient. Admins are never blocked by the deadline, because the paper
-- fallback and week-later corrections both run through the proxy path.
--
-- Applied to production as: reporting_closes_next_morning

alter table public.nights add column if not exists reports_close_at timestamptz;
comment on column public.nights.reports_close_at is
  'Members may report until this moment. Defaults to 09:00 Oslo the morning after the night. Admins are never blocked by it.';
grant select (reports_close_at) on public.nights to authenticated;

update public.nights
   set reports_close_at = ((played_on + 1) + time '09:00') at time zone 'Europe/Oslo'
 where reports_close_at is null;

-- The insert trigger already assigns the attendance code. It now also sets the
-- reporting deadline, so every creation path gets one without anybody thinking
-- about it: create_night(), the seed, or a hand-written insert.
create or replace function public.trg_nights_code()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := public.gen_night_code();
  else
    new.code := upper(btrim(new.code));
  end if;
  if new.reports_close_at is null then
    new.reports_close_at :=
      ((new.played_on + 1) + time '09:00') at time zone 'Europe/Oslo';
  end if;
  return new;
end $$;

-- Let an organiser move the deadline: extend it for a night that ran long, or
-- close it early. Null means no deadline at all.
create or replace function public.set_reports_close(p_night_id uuid, p_at timestamptz)
returns public.nights
language plpgsql security definer set search_path = public, pg_temp as $$
declare n public.nights;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.nights set reports_close_at = p_at
   where id = p_night_id returning * into n;
  if n.id is null then raise exception 'night not found'; end if;
  return n;
end $$;
revoke all on function public.set_reports_close(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.set_reports_close(uuid, timestamptz) to authenticated;

-- Surface it so the report screen can say "you can report until 09:00 tomorrow"
-- instead of leaving people guessing. Dropped and recreated: column order changes.
drop view if exists public.v_upcoming_nights;
create view public.v_upcoming_nights as
  select n.id as night_id, n.season_id, n.played_on, n.title, n.kind,
         n.status, n.counts_as_round, n.affects_points,
         n.stack_size, n.attendance_bonus, n.reports_close_at,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'going')     as going_count,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'not_going') as not_going_count
    from public.nights n
   where n.status not in ('settled','void')
     and n.played_on >= current_date;
grant select on public.v_upcoming_nights to anon, authenticated;

-- report_entry gains the deadline check. Superseded by 0007, which adds the
-- live top-up rules; kept here so the history reads in order.
