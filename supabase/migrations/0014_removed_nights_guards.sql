-- Follow-up to 0013, two holes in it.
--
-- 1. The read policy hid removed nights from EVERYONE, organisers included,
--    so nothing could ever be restored. Admins must still see them.
-- 2. check_in / report_entry read the night as owner inside a SECURITY
--    DEFINER, which bypasses RLS entirely. A phone that still had a removed
--    night's id in localStorage would have kept writing to it.
--
-- Applied to production as 20260902091004_removed_nights_guards.

drop policy nights_read on public.nights;
create policy nights_read on public.nights for select to authenticated
  using (public.is_admin()
         or (deleted_at is null
             and (status <> 'draft' or played_on >= current_date)));

create or replace function public.check_in(p_night_id uuid, p_code text default null, p_member_id uuid default null)
returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self uuid := public.current_member_id();
  v_member uuid; v_night public.nights; v_row public.entries;
  v_avail bigint; v_buyin integer; v_cap integer;
  v_admin boolean := public.is_admin();
  v_has_entry boolean; v_code text;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  v_member := coalesce(p_member_id, v_self);
  if v_member <> v_self and not v_admin then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select * into strict v_night from public.nights where id = p_night_id;
  if v_night.deleted_at is not null then
    raise exception 'that night has been removed' using errcode = 'P0070';
  end if;

  select exists (
    select 1 from public.entries
     where night_id = p_night_id and member_id = v_member
  ) into v_has_entry;

  if not v_admin then
    if v_has_entry then
      if v_night.status not in ('open', 'reconciling') then
        raise exception 'night is not open' using errcode = 'P0001';
      end if;
    else
      if v_night.status <> 'open' then
        raise exception 'night is not open' using errcode = 'P0001';
      end if;
      v_code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
      if v_code = '' then
        raise exception 'tonight''s check-in code is required. It is on the screen at the front'
          using errcode = 'P0010';
      end if;
      if v_code <> v_night.code then
        raise exception 'that code does not match tonight. Check the screen at the front, or ask an organiser to check you in'
          using errcode = 'P0011';
      end if;
    end if;
  end if;

  insert into public.season_enrollments
    (season_id, member_id, pseudonym_at_time, starting_points)
  select v_night.season_id, v_member, m.pseudonym, s.starting_points
    from public.members m, public.seasons s
   where m.id = v_member and s.id = v_night.season_id
  on conflict do nothing;

  v_avail := public.member_balance(v_night.season_id, v_member)
             + v_night.attendance_bonus;
  v_buyin := least(v_night.stack_size::bigint, greatest(v_avail, 0))::integer;
  v_cap   := least(v_night.stack_size::bigint, greatest(v_avail - v_buyin, 0))::integer;

  insert into public.entries
    (night_id, season_id, member_id, buyin_chips, rebuy_cap_chips, checked_in_by)
  values
    (v_night.id, v_night.season_id, v_member, v_buyin, v_cap, v_self)
  on conflict (night_id, member_id) do update set updated_at = now()
  returning * into v_row;

  return v_row;
end $$;

create or replace function public.report_entry(p_night_id uuid, p_final_stack integer, p_rebuy_chips integer default 0, p_member_id uuid default null, p_note text default null)
returns public.entries
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
  if v_night.deleted_at is not null then
    raise exception 'that night has been removed' using errcode = 'P0070';
  end if;
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
