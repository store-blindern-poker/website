-- Two fixes, both found after 0015 shipped.
--
-- 1. take_rebuy's "one per night" guard tested rebuy_at, which only the bank
--    sets. An organiser recording a top-up by hand through the console sets
--    rebuy_chips and leaves rebuy_at NULL, so the member could then walk to
--    the bank and take a SECOND top-up, and the update overwrote the
--    organiser's number on the way past. Chips twice, and the record of the
--    first handover gone. The guard now tests both, and says which kind of
--    top-up already happened.
--
-- 2. set_rsvp raised P0022 for a full night. take_rebuy already uses P0022
--    for "check in first", and js/report.js branches on it. Different
--    screens, so nothing was broken in practice, but two meanings for one
--    code is a trap for whoever adds the third. The full-night refusal moves
--    to P0030, and js/sb.js follows it.
--
-- take_rebuy also picks up the removed-night guard that 0014 gave check_in
-- and report_entry.
--
-- Applied to production as 20260902094014_topup_guard_and_full_night_code.

create or replace function public.take_rebuy(p_night_id uuid, p_current_stack integer, p_amount integer)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self uuid := public.current_member_id();
  v_night public.nights; v_entry public.entries;
  v_max integer; v_row public.entries;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_current_stack is null or p_current_stack < 0 then
    raise exception 'tell us how many chips are in front of you';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'choose how much to take';
  end if;

  select * into strict v_night from public.nights where id = p_night_id;
  if v_night.deleted_at is not null then
    raise exception 'that night has been removed' using errcode = 'P0070';
  end if;
  if v_night.status <> 'open' then
    raise exception 'the night is not open' using errcode = 'P0001';
  end if;

  -- Lock the row: two taps on a flaky connection must not issue two top-ups.
  select * into v_entry from public.entries
   where night_id = p_night_id and member_id = v_self and voided_at is null
   for update;

  if v_entry.id is null then
    raise exception 'check in first' using errcode = 'P0022';
  end if;

  -- One top-up a night, however it was recorded. rebuy_at means the bank
  -- issued it; rebuy_chips without rebuy_at means an organiser handed the
  -- chips over and typed it in. Either way the night's top-up is spent.
  if v_entry.rebuy_at is not null then
    raise exception 'you have already topped up tonight. One per night'
      using errcode = 'P0023';
  end if;
  if coalesce(v_entry.rebuy_chips, 0) > 0 then
    raise exception 'an organiser already recorded a top-up of % for you tonight. One per night',
      v_entry.rebuy_chips using errcode = 'P0023';
  end if;

  v_max := least(greatest(v_night.stack_size - p_current_stack, 0), v_entry.rebuy_cap_chips);
  if v_max <= 0 then
    raise exception 'no top-up available: you are holding % of tonight''s % stack',
      p_current_stack, v_night.stack_size using errcode = 'P0024';
  end if;
  if p_amount > v_max then
    raise exception 'the most you can take now is %' , v_max using errcode = 'P0025';
  end if;

  update public.entries
     set rebuy_chips        = p_amount,
         rebuy_stack_before = p_current_stack,
         rebuy_at           = now(),
         updated_at         = now()
   where id = v_entry.id
  returning * into v_row;

  return v_row;
end $$;

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
        v_going, v_night.capacity using errcode = 'P0030';
    end if;
  end if;

  insert into public.rsvps (night_id, season_id, member_id, response, responded_at)
  values (p_night_id, v_night.season_id, v_self, p_response, now())
  on conflict (night_id, member_id)
    do update set response = excluded.response, responded_at = now();
  return p_response;
end $$;
