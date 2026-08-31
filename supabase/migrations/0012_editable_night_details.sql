-- 0012: the venue moves into the database, and a night becomes editable
-- from the console.
--
-- 0001 put this on the record: "times and places live in site copy /
-- data/events.json, not in the database". That was wrong in the one way that
-- costs an evening. A room is confirmed late, swapped at short notice, and
-- sometimes changed on the day; with the venue in a JSON file, changing it
-- means a git commit and a deploy, which a non-technical successor cannot do
-- and nobody can do from a corridor at 17:40. So nights gains location,
-- location_url and notes, v_upcoming_nights carries them (anon can read that
-- view, which is how the public events page gets the room), and update_night()
-- lets an organiser change a night without SQL.
--
-- THE FREEZE, and why it is not negotiable:
-- once anybody has checked in, an entry has already been booked against this
-- night's numbers. check_in() reads stack_size to size the buy-in and the
-- rebuy cap from the member's balance at that moment, and recompute_season()
-- scores the night from those booked rows plus attendance_bonus. Editing
-- stack_size, attendance_bonus, played_on, counts_as_round or affects_points
-- after the first check-in would leave the earlier players scored on one set
-- of rules and the later ones on another, silently. So those five freeze and
-- update_night() refuses them (P0061) rather than accepting a change that
-- would quietly rewrite what people already played for. The title, the venue,
-- the map link and the notes carry no arithmetic, so they stay editable for
-- the whole life of the night: they are exactly what changes late.
--
-- Error codes the console handles by name:
--   42501  admin only
--   P0060  'that night is finished. Reopen it for corrections first'
--   P0061  '% player(s) have already checked in, so the stack, bonus, date
--          and scoring flags are locked. The title, venue and notes can
--          still be changed'. The message names how many players, so the
--          organiser can see it is real and not a stuck flag. js/sb.js
--          passes both through verbatim, so do not reword them without
--          reading what the console shows.
--
-- create_night's 8-argument signature is DROPPED here, not left beside the
-- new one: two overloads of the same name make PostgREST refuse the call as
-- ambiguous. Any old 8-argument call site is a live bug after this file.
--
-- Applied to production as: editable_night_details. The bodies below were
-- read back out of production with pg_get_functiondef and are byte for byte
-- what the live database runs, so applying this file to a fresh environment
-- reproduces production rather than a paraphrase of it. If you change a
-- function here, change it there in the same sitting.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.nights add column if not exists location text;
alter table public.nights add column if not exists location_url text;
alter table public.nights add column if not exists notes text;

comment on column public.nights.location is
  'Where the night is played, as a human reads it ("Nils Henrik Abels hus, Abelstua"). Null or "TBD" means not confirmed yet, and the public events page says so rather than showing a stale room.';
comment on column public.nights.location_url is
  'Optional map link for the room (MazeMap). Shown as "Find the room" on the events page.';
comment on column public.nights.notes is
  'Free note for the night: beginner table, a different start time, whatever the organisers need on the row.';

-- The nights grant is column-level on purpose (code is excluded from it), so
-- new columns get no access until they are named here.
grant select (location, location_url, notes) on public.nights to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: the Welcome Round was played at Abelstua, the club's usual room.
-- Only fills a night that has no venue yet, so re-running this file can never
-- overwrite something an organiser has since set. Round 1 is deliberately left
-- alone: its room is not confirmed, and an invented venue is worse than none.
-- ---------------------------------------------------------------------------
update public.nights
   set location = 'Blindern Campus, Nils Henrik Abels Hus, Abelstua',
       location_url = 'https://link.mazemap.com/BgdNsCdA'
 where title = 'Welcome Round'
   and kind = 'welcome'
   and location is null;

-- ---------------------------------------------------------------------------
-- update_night: one RPC for every editable field on a night.
--
-- NULL means "leave this alone", so a caller sends only what changed. An
-- empty string CLEARS a text field (nullif on btrim), which is the only way
-- to unset a venue once it is set.
--
-- The frozen fields are compared before they are refused: sending a value
-- that is already on the row is not a change, so an idempotent resend does
-- not earn an error.
--
-- Two things this function does that are easy to miss:
--   1. Moving played_on moves reports_close_at with it, but only when the
--      deadline still sits on the default 09:00 the morning after the old
--      date. A deadline somebody set by hand is left alone.
--   2. A negative stack size or attendance bonus is rejected outright.
-- ---------------------------------------------------------------------------
create or replace function public.update_night(
  p_night_id uuid,
  p_title text default null,
  p_location text default null,
  p_location_url text default null,
  p_notes text default null,
  p_played_on date default null,
  p_kind public.night_kind default null,
  p_stack_size integer default null,
  p_attendance_bonus integer default null,
  p_counts_as_round boolean default null,
  p_affects_points boolean default null
) returns public.nights
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

  -- Scoring fields are frozen once anyone has checked in.
  if v_entries > 0 and (
       (p_stack_size       is not null and p_stack_size       <> v_night.stack_size)
    or (p_attendance_bonus is not null and p_attendance_bonus <> v_night.attendance_bonus)
    or (p_counts_as_round  is not null and p_counts_as_round  <> v_night.counts_as_round)
    or (p_affects_points   is not null and p_affects_points   <> v_night.affects_points)
    or (p_played_on        is not null and p_played_on        <> v_night.played_on)
  ) then
    raise exception '% player(s) have already checked in, so the stack, bonus, date and scoring flags are locked. The title, venue and notes can still be changed',
      v_entries using errcode = 'P0061';
  end if;

  if p_stack_size is not null and p_stack_size < 0 then
    raise exception 'stack size cannot be negative';
  end if;
  if p_attendance_bonus is not null and p_attendance_bonus < 0 then
    raise exception 'attendance bonus cannot be negative';
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
    affects_points   = coalesce(p_affects_points, affects_points)
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

revoke all on function public.update_night(uuid, text, text, text, text, date,
  public.night_kind, integer, integer, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.update_night(uuid, text, text, text, text, date,
  public.night_kind, integer, integer, boolean, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- create_night: the venue is set when the night is created, so the common
-- case never needs the edit form at all. The 8-argument version is dropped:
-- keeping both would make the name ambiguous over PostgREST.
-- ---------------------------------------------------------------------------
drop function if exists public.create_night(uuid, date, text, public.night_kind,
  integer, integer, boolean, boolean);

create or replace function public.create_night(
  p_season_id uuid,
  p_played_on date,
  p_title text default null,
  p_kind public.night_kind default 'tournament',
  p_stack_size integer default null,
  p_attendance_bonus integer default null,
  p_counts_as_round boolean default true,
  p_affects_points boolean default true,
  p_location text default null,
  p_location_url text default null
) returns public.nights
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.nights; v_no smallint;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select coalesce(max(night_no), 0) + 1 into v_no
    from public.nights where season_id = p_season_id;
  insert into public.nights
    (season_id, night_no, played_on, title, kind, counts_as_round, affects_points,
     stack_size, attendance_bonus, location, location_url)
  values
    (p_season_id, v_no, p_played_on, nullif(btrim(coalesce(p_title,'')), ''), p_kind,
     p_counts_as_round, coalesce(p_affects_points, true),
     coalesce(p_stack_size, 10000), coalesce(p_attendance_bonus, 5000),
     nullif(btrim(coalesce(p_location,'')), ''),
     nullif(btrim(coalesce(p_location_url,'')), ''))
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.create_night(uuid, date, text, public.night_kind,
  integer, integer, boolean, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.create_night(uuid, date, text, public.night_kind,
  integer, integer, boolean, boolean, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- v_upcoming_nights carries the venue. anon can read this view, and that is
-- the whole point: the public events page reads the room from here instead of
-- from data/events.json, so confirming a room is a form on admin.html rather
-- than a commit. Dropped and recreated: column order changes.
-- ---------------------------------------------------------------------------
drop view if exists public.v_upcoming_nights;
create view public.v_upcoming_nights as
  select n.id as night_id, n.season_id, n.played_on, n.title, n.kind,
         n.status, n.counts_as_round, n.affects_points,
         n.stack_size, n.attendance_bonus, n.reports_close_at,
         n.location, n.location_url, n.notes,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'going')     as going_count,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'not_going') as not_going_count
    from public.nights n
   where n.status not in ('settled','void')
     and n.played_on >= current_date;
grant select on public.v_upcoming_nights to anon, authenticated;
