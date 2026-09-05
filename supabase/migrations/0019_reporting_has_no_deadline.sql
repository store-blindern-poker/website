-- 0019: there is no reporting deadline. Settling the night is what closes
-- reporting.
--
-- Round 1 is why. Six players of thirty-eight went home without reporting, the
-- reminder email had no sender configured so the nudge never went out, and at
-- 09:00 the next morning the deadline from 0006 locked all six out, facing
-- -44,800 points between them for chips they had actually handed back. The
-- deadline punished people for a failure that was ours.
--
-- It was also doing no work that settling was not already doing. settle_night()
-- finalises the results, and report_entry() already refuses a settled night
-- with 'night_settled' (P0003). One act, one meaning: a night is open until an
-- organiser closes it, and reporting is open for exactly as long.
--
-- Nothing here removes the ability to set a deadline. set_reports_close() is
-- untouched, and report_entry()'s check was already written to fire only when
-- the column is non-null, so a night that ran long or one an organiser wants
-- closed early still works. What changes is that no code assigns one on its
-- own any more. The column becomes opt in, and NULL is the normal state.
--
-- Applied to production as 20260905084328_reporting_has_no_deadline, by hand
-- during the live night, before this file existed. Written the same day, as
-- README.md requires.


-- The column keeps its meaning. The catalog comment claimed a default that no
-- longer exists, and the schema is the first thing the next person reads.
comment on column public.nights.reports_close_at is
  'Optional deadline for member reporting. NULL, the default, means there is none: reporting stays open until the night is settled. Only set_reports_close() writes it. Admins are never blocked by it.';


-- Back to what 0001 gave this trigger: the attendance code, and nothing else.
-- 0006 hung the deadline here so that every creation path picked one up without
-- anybody thinking about it, and that is precisely what made the deadline
-- invisible to the people it was applied to. A rule nobody chose for a given
-- night should not be assigned to it in a trigger.
create or replace function public.trg_nights_code()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := public.gen_night_code();
  else
    new.code := upper(btrim(new.code));
  end if;
  return new;
end $$;


-- Every night still in play loses its deadline, whether the trigger gave it one
-- or an organiser did. The change has to reach the nights already on the books,
-- not only the next one created: the night this was written for was already in
-- the table with 09:00 sitting on it.
--
-- Settled and void nights keep theirs. They are the record of what happened
-- under the old rule, the column gates nothing once status has moved past
-- 'reconciling', and rewriting finished history to tidy a screen is not a trade
-- this project makes.
--
-- Removed nights are cleared on purpose. remove_night() sets deleted_at and
-- leaves status alone, so a removed night is usually still 'open' and is caught
-- here. restore_night() must bring it back with no deadline rather than with a
-- resurrected one.
update public.nights
   set reports_close_at = null
 where status not in ('settled','void')
   and reports_close_at is not null;


-- update_night keeps the 12-argument signature from 0015, so CREATE OR REPLACE
-- carries the grants that migration issued and no regrant is needed here.
--
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

  -- A deadline on the row can only have been put there by hand now, so moving
  -- the date must not silently retime it. It must not silently strand it
  -- either: a deadline that would fall before the night it belongs to closes
  -- reporting for a night nobody has played, which is the exact failure this
  -- change exists to stop. Refuse instead, and let the organiser say what they
  -- meant. The freeze above means this can only ever be a night with no
  -- entries yet.
  if p_played_on is not null and p_played_on <> v_night.played_on
     and v_night.reports_close_at is not null
     and v_night.reports_close_at
         < ((p_played_on + 1) + time '00:00') at time zone 'Europe/Oslo' then
    raise exception 'this night has a reporting deadline of %. Moving the date does not move it, and it would then fall before the end of %. Ask whoever set it to clear it with set_reports_close, or to set it again for the new date',
      to_char(v_night.reports_close_at at time zone 'Europe/Oslo', 'HH24:MI on DD Mon'),
      to_char(p_played_on, 'DD Mon')
      using errcode = 'P0062';
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

  -- 0012 and 0015 ended here with a second UPDATE that moved the deadline
  -- whenever the date moved, guarded by the old value still matching the 09:00
  -- default for the old date. With a NULL default that guard is not merely dead
  -- code, which is why deleting it is the fix rather than leaving it in place:
  -- a new night never matches it, so it reads as harmless, while any night
  -- still carrying the old computed value DOES match and would be handed a
  -- fresh 09:00 deadline nobody asked for. The backfill above empties the rows
  -- that exist today, and deleting the block is what stops the resurrection for
  -- good. Nothing in this function writes reports_close_at any more, so
  -- set_reports_close() is the only writer left in the database.
  --
  -- Deleting it also fixes a bug it always carried. That second UPDATE ended in
  -- "returning * into v_row", and when the guard did not match it touched no
  -- row, which left v_row as a record of NULLs and made update_night return an
  -- empty nights row after a date change that had in fact succeeded. Rare
  -- before, because the guard usually matched. The normal case now.
  return v_row;
end $$;
