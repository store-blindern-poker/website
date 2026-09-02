-- A seat count for a night, so "9 of 38 going" is on the card and the 39th
-- person is told before they turn up rather than after.
--
-- This caps RSVPs ONLY. check_in() is deliberately untouched: someone who
-- walks in without answering is still welcome, and an organiser who has found
-- a spare chair should never be arguing with the software. The cap is a
-- planning signal, not a door policy.
--
-- Lowering the cap below the current headcount never removes anyone. The
-- people who already said yes keep their seat; the next person is refused.
--
-- The default of 38 is the room, not a rule. Postgres backfills existing rows
-- when a column is added WITH a default, so every night already on record
-- picked up 38 when this ran. Clear it per night for no limit.
--
-- Applied to production as 20260902091222_night_capacity.

alter table public.nights add column if not exists capacity integer default 38;
comment on column public.nights.capacity is
  'Seats for RSVP purposes. NULL means no cap. Caps set_rsvp(''going'') only, never check_in.';

alter table public.nights drop constraint if exists nights_capacity_positive;
alter table public.nights add constraint nights_capacity_positive
  check (capacity is null or capacity > 0);

grant select (capacity) on public.nights to authenticated;

create or replace function public.set_rsvp(p_night_id uuid, p_response text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self  uuid := public.current_member_id();
  v_night public.nights;
  v_going integer;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;

  -- FOR UPDATE serialises answers to this one night, so two people tapping
  -- Going on the last seat at the same moment cannot both get it.
  select * into strict v_night from public.nights where id = p_night_id for update;

  if v_night.status in ('settled','void') then
    raise exception 'that night is finished' using errcode = 'P0020';
  end if;

  if p_response is null then
    delete from public.rsvps where night_id = p_night_id and member_id = v_self;
    return null;
  end if;
  if p_response not in ('going','not_going') then
    raise exception 'response must be going or not_going';
  end if;

  if p_response = 'going' and v_night.capacity is not null then
    -- Count everyone else. Changing my own answer from going to going, or
    -- back from not_going to going when I already hold a seat, must not be
    -- refused by my own row.
    select count(*) into v_going from public.rsvps
     where night_id = p_night_id and response = 'going' and member_id <> v_self;
    if v_going >= v_night.capacity then
      raise exception 'that night is full (% of % going). Ask an organiser, or check back in case someone drops out',
        v_going, v_night.capacity using errcode = 'P0022';
    end if;
  end if;

  insert into public.rsvps (night_id, season_id, member_id, response, responded_at)
  values (p_night_id, v_night.season_id, v_self, p_response, now())
  on conflict (night_id, member_id)
    do update set response = excluded.response, responded_at = now();
  return p_response;
end $$;

-- p_capacity: NULL leaves it alone, 0 removes the cap, anything else sets it.
-- Zero is not a meaningful seat count, so it is free to act as the sentinel.
create or replace function public.update_night(
  p_night_id uuid,
  p_title text default null, p_location text default null,
  p_location_url text default null, p_notes text default null,
  p_played_on date default null, p_kind public.night_kind default null,
  p_stack_size integer default null, p_attendance_bonus integer default null,
  p_counts_as_round boolean default null, p_affects_points boolean default null,
  p_capacity integer default null)
returns public.nights
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_night public.nights; v_entries int; v_row public.nights;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;

  select * into strict v_night from public.nights where id = p_night_id;
  if v_night.status in ('settled','void') then
    raise exception 'that night is finished. Reopen it for corrections first'
      using errcode = 'P0060';
  end if;

  select count(*) into v_entries from public.entries
   where night_id = p_night_id and voided_at is null;

  -- Scoring fields are frozen once anyone has checked in. Capacity is NOT
  -- one of them: it changes nothing that has already been scored, and a room
  -- swap on the night is exactly when it needs changing.
  if v_entries > 0 and (
       (p_stack_size       is not null and p_stack_size       <> v_night.stack_size)
    or (p_attendance_bonus is not null and p_attendance_bonus <> v_night.attendance_bonus)
    or (p_counts_as_round  is not null and p_counts_as_round  <> v_night.counts_as_round)
    or (p_affects_points   is not null and p_affects_points   <> v_night.affects_points)
    or (p_played_on        is not null and p_played_on        <> v_night.played_on)
  ) then
    raise exception '% player(s) have already checked in, so the stack, bonus, date and scoring flags are locked. The title, venue, capacity and notes can still be changed',
      v_entries using errcode = 'P0061';
  end if;

  if p_stack_size is not null and p_stack_size < 0 then
    raise exception 'stack size cannot be negative';
  end if;
  if p_attendance_bonus is not null and p_attendance_bonus < 0 then
    raise exception 'attendance bonus cannot be negative';
  end if;
  if p_capacity is not null and p_capacity < 0 then
    raise exception 'capacity cannot be negative';
  end if;

  update public.nights set
    title            = case when p_title is null then title
                            else nullif(btrim(p_title), '') end,
    location         = case when p_location is null then location
                            else nullif(btrim(p_location), '') end,
    location_url     = case when p_location_url is null then location_url
                            else nullif(btrim(p_location_url), '') end,
    notes            = case when p_notes is null then notes
                            else nullif(btrim(p_notes), '') end,
    played_on        = coalesce(p_played_on, played_on),
    kind             = coalesce(p_kind, kind),
    stack_size       = coalesce(p_stack_size, stack_size),
    attendance_bonus = coalesce(p_attendance_bonus, attendance_bonus),
    counts_as_round  = coalesce(p_counts_as_round, counts_as_round),
    affects_points   = coalesce(p_affects_points, affects_points),
    capacity         = case when p_capacity is null then capacity
                            when p_capacity = 0    then null
                            else p_capacity end
  where id = p_night_id
  returning * into v_row;

  -- Moving the date moves the reporting deadline with it, unless it was set by
  -- hand to something other than the default for the old date.
  if p_played_on is not null and p_played_on <> v_night.played_on then
    update public.nights
       set reports_close_at = ((p_played_on + 1) + time '09:00') at time zone 'Europe/Oslo'
     where id = p_night_id
       and reports_close_at = ((v_night.played_on + 1) + time '09:00') at time zone 'Europe/Oslo'
    returning * into v_row;
  end if;

  return v_row;
end $$;

-- The 11-argument version from 0012 goes, or PostgREST has two overloads to
-- choose between and refuses the call as ambiguous.
drop function if exists public.update_night(uuid, text, text, text, text, date, public.night_kind, integer, integer, boolean, boolean);
revoke all on function public.update_night(uuid, text, text, text, text, date, public.night_kind, integer, integer, boolean, boolean, integer) from public, anon, authenticated;
grant execute on function public.update_night(uuid, text, text, text, text, date, public.night_kind, integer, integer, boolean, boolean, integer) to authenticated;

drop view if exists public.v_upcoming_nights;
create view public.v_upcoming_nights as
  select n.id as night_id, n.season_id, n.played_on, n.title, n.kind,
         n.status, n.counts_as_round, n.affects_points,
         n.stack_size, n.attendance_bonus, n.reports_close_at,
         n.location, n.location_url, n.capacity,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'going')     as going_count,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'not_going') as not_going_count
    from public.nights n
   where n.status not in ('settled','void')
     and n.deleted_at is null
     and n.played_on >= current_date;
grant select on public.v_upcoming_nights to anon, authenticated;
