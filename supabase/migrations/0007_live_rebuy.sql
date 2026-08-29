-- 0007: top-ups become a live transaction at the bank.
--
-- The player declares the stack in front of them, the server works out what
-- they are allowed to take, they choose an amount, and the app produces a slip
-- to show the organiser at the bank. The organiser reads one number and counts
-- out chips.
--
-- This is the first point where the server learns a mid-game chip count, so the
-- real rule ("a top-up may only bring you back to tonight's stack, and you may
-- not top up while holding more than that") becomes enforceable rather than
-- social. Before this, the end-of-night report just asked people to remember.
--
-- Applied to production as: live_rebuy_at_the_bank

alter table public.entries add column if not exists rebuy_stack_before integer
  check (rebuy_stack_before is null or rebuy_stack_before >= 0);
alter table public.entries add column if not exists rebuy_at timestamptz;
comment on column public.entries.rebuy_stack_before is
  'Chips the player declared holding when they asked for a top-up. Null if they never topped up.';
comment on column public.entries.rebuy_at is
  'When the top-up was issued. Non-null means the live bank flow was used.';

-- What may this member take right now? Returns the ceiling, or an error naming
-- the reason there is none.
create or replace function public.rebuy_quote(p_night_id uuid, p_current_stack integer)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_self uuid := public.current_member_id();
  v_night public.nights; v_entry public.entries;
  v_chip_room integer; v_max integer;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_current_stack is null or p_current_stack < 0 then
    raise exception 'tell us how many chips are in front of you';
  end if;

  select * into strict v_night from public.nights where id = p_night_id;
  select * into v_entry from public.entries
   where night_id = p_night_id and member_id = v_self and voided_at is null;

  if v_entry.id is null then
    raise exception 'check in first' using errcode = 'P0022';
  end if;
  if v_entry.rebuy_at is not null then
    raise exception 'you have already topped up tonight. One per night'
      using errcode = 'P0023';
  end if;
  if v_night.status <> 'open' then
    raise exception 'the night is not open' using errcode = 'P0001';
  end if;

  -- The chip rule and the points rule, whichever binds first.
  v_chip_room := greatest(v_night.stack_size - p_current_stack, 0);
  v_max := least(v_chip_room, v_entry.rebuy_cap_chips);

  return jsonb_build_object(
    'stack_size',      v_night.stack_size,
    'current_stack',   p_current_stack,
    'chip_room',       v_chip_room,
    'points_ceiling',  v_entry.rebuy_cap_chips,
    'max_topup',       v_max,
    'eligible',        v_max > 0,
    'reason',          case
                         when v_chip_room = 0 then 'holding_full_stack'
                         when v_entry.rebuy_cap_chips = 0 then 'no_points_left'
                         else null end
  );
end $$;
revoke all on function public.rebuy_quote(uuid, integer) from public, anon, authenticated;
grant execute on function public.rebuy_quote(uuid, integer) to authenticated;

-- Take the top-up. Records the declared stack, the amount, and the moment.
create or replace function public.take_rebuy(
  p_night_id uuid,
  p_current_stack integer,
  p_amount integer
) returns public.entries
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
  if v_entry.rebuy_at is not null then
    raise exception 'you have already topped up tonight. One per night'
      using errcode = 'P0023';
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
revoke all on function public.take_rebuy(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.take_rebuy(uuid, integer, integer) to authenticated;

-- An organiser can undo a top-up that was recorded but never handed over.
create or replace function public.void_rebuy(p_night_id uuid, p_member_id uuid)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.entries;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.entries
     set rebuy_chips = 0, rebuy_stack_before = null, rebuy_at = null, updated_at = now()
   where night_id = p_night_id and member_id = p_member_id and voided_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'no entry for that member tonight'; end if;
  return v_row;
end $$;
revoke all on function public.void_rebuy(uuid, uuid) from public, anon, authenticated;
grant execute on function public.void_rebuy(uuid, uuid) to authenticated;

-- Final form of report_entry: the reporting deadline from 0006, plus the rule
-- that a member cannot overwrite a top-up the bank flow already recorded.
-- Admins still can, for the paper fallback and corrections.
create or replace function public.report_entry(
  p_night_id uuid,
  p_final_stack integer,
  p_rebuy_chips integer default 0,
  p_member_id uuid default null,
  p_note text default null
) returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self uuid := public.current_member_id();
  v_member uuid; v_night public.nights; v_row public.entries; v_via text;
  v_admin boolean := public.is_admin(); v_existing public.entries;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_final_stack is null or p_final_stack < 0 then
    raise exception 'final stack must be zero or more';
  end if;
  v_member := coalesce(p_member_id, v_self);
  if v_member <> v_self and not v_admin then
    raise exception 'admin only' using errcode = '42501';
  end if;
  v_via := case when v_member = v_self then 'self' else 'admin' end;

  select * into strict v_night from public.nights where id = p_night_id;
  if v_night.status = 'settled' and not v_admin then
    raise exception 'night_settled' using errcode = 'P0003';
  end if;
  if v_night.status not in ('open','reconciling') and not v_admin then
    raise exception 'night is not open' using errcode = 'P0001';
  end if;
  if v_night.reports_close_at is not null
     and now() >= v_night.reports_close_at
     and not v_admin then
    raise exception 'reporting for that night closed at %. Ask an organiser to enter it for you',
      to_char(v_night.reports_close_at at time zone 'Europe/Oslo', 'HH24:MI on DD Mon')
      using errcode = 'P0021';
  end if;

  perform public.check_in(p_night_id, null::text, v_member);

  select * into v_existing from public.entries
   where night_id = p_night_id and member_id = v_member and voided_at is null;

  update public.entries set
    rebuy_chips  = case
                     when v_existing.rebuy_at is not null and not v_admin
                       then v_existing.rebuy_chips
                     else least(greatest(coalesce(p_rebuy_chips, 0), 0), rebuy_cap_chips)
                   end,
    final_stack  = p_final_stack,
    reported     = true,
    reported_by  = v_self,
    reported_via = v_via,
    note         = coalesce(p_note, note),
    updated_at   = now()
  where night_id = p_night_id and member_id = v_member and voided_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'this entry was voided; ask an organiser';
  end if;

  return v_row;
end $$;
