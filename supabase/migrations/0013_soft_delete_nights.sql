-- Remove a night, draft or settled, without destroying anything.
--
-- Same shape as removing a member: deleted_at marks it, every entry and
-- adjustment stays exactly where it is, and restoring puts the night and its
-- results back. Settling a test night by mistake should not be permanent.
--
-- Removing a SETTLED night changes the leaderboard, so both operations
-- recompute the season immediately rather than leaving standings that quietly
-- disagree with the nights list.
--
-- Applied to production as 20260902090643_soft_delete_nights.
-- 0014 fixes two holes this left, on the same day. Read them together.

alter table public.nights add column if not exists deleted_at timestamptz;
comment on column public.nights.deleted_at is
  'Soft delete. Non-null means removed: excluded from scoring, the nights list and the events page. Entries are untouched; restore_night() reverses it.';

-- recompute_season must ignore removed nights, or their results keep counting.
create or replace function public.recompute_season(p_season_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_night   public.nights;
  v_touched integer := 0;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if (select status from public.seasons where id = p_season_id) = 'frozen' then
    raise exception 'season is frozen' using errcode = '55006';
  end if;

  update public.entries e
     set attendance_bonus_awarded = null, net_points = null,
         balance_after = null, scored_at = null
    from public.nights n
   where n.id = e.night_id and n.season_id = p_season_id
     and (n.status <> 'settled' or n.deleted_at is not null or e.voided_at is not null)
     and e.scored_at is not null;

  drop table if exists pg_temp._bal;
  create temp table _bal (
    member_id   uuid primary key,
    bal         bigint  not null,
    prev_bal    bigint  not null,
    high        bigint  not null,
    low         bigint  not null,
    played      integer not null default 0,
    prev_played integer not null default 0
  );
  insert into pg_temp._bal (member_id, bal, prev_bal, high, low)
  select member_id, starting_points, starting_points, starting_points, starting_points
    from public.season_enrollments
   where season_id = p_season_id;

  for v_night in
    select * from public.nights
     where season_id = p_season_id and status = 'settled' and deleted_at is null
     order by played_on, night_no, id
  loop
    if v_night.affects_points then
      update pg_temp._bal set prev_bal = bal, prev_played = played where true;

      with deltas as (
        select x.member_id, sum(x.d)::bigint as d, bool_or(x.is_entry) as attended
          from (
            select e.member_id,
                   (coalesce(e.final_stack, 0)::bigint
                    - (e.buyin_chips + e.rebuy_chips)
                    + v_night.attendance_bonus) as d,
                   true as is_entry
              from public.entries e
             where e.night_id = v_night.id and e.voided_at is null
            union all
            select a.member_id, a.delta_points::bigint, false
              from public.adjustments a
             where a.night_id = v_night.id and a.member_id is not null
          ) x
         group by x.member_id
      )
      update pg_temp._bal b
         set bal    = greatest(0, b.bal + d.d),
             played = b.played + case when d.attended then 1 else 0 end
        from deltas d
       where d.member_id = b.member_id;

      update pg_temp._bal set high = greatest(high, bal), low = least(low, bal) where true;

      update public.entries e
         set attendance_bonus_awarded = v_night.attendance_bonus,
             net_points    = coalesce(e.final_stack, 0)
                             - (e.buyin_chips + e.rebuy_chips)
                             + v_night.attendance_bonus,
             balance_after = b.bal,
             scored_at     = now()
        from pg_temp._bal b
       where e.night_id = v_night.id and e.voided_at is null
         and b.member_id = e.member_id;
    else
      update public.entries e
         set attendance_bonus_awarded = v_night.attendance_bonus,
             net_points    = coalesce(e.final_stack, 0)
                             - (e.buyin_chips + e.rebuy_chips)
                             + v_night.attendance_bonus,
             balance_after = null,
             scored_at     = now()
       where e.night_id = v_night.id and e.voided_at is null;
    end if;

    update public.nights n
       set entry_count      = t.cnt,
           unreported_count = t.unrep,
           chips_in         = t.cin,
           chips_out        = t.cout,
           chip_balance     = t.cout - t.cin
      from (
        select count(*)                                            as cnt,
               count(*) filter (where not reported)                as unrep,
               coalesce(sum(buyin_chips + rebuy_chips), 0)::bigint as cin,
               coalesce(sum(coalesce(final_stack, 0)), 0)::bigint  as cout
          from public.entries
         where night_id = v_night.id and voided_at is null
      ) t
     where n.id = v_night.id;

    v_touched := v_touched + 1;
  end loop;

  delete from public.season_scores where season_id = p_season_id;
  insert into public.season_scores
    (season_id, member_id, points, points_prev, highest_points, lowest_points,
     nights_played, had_history, updated_at)
  select p_season_id, member_id, bal, prev_bal, high, low,
         played, prev_played > 0, now()
    from pg_temp._bal;

  drop table if exists pg_temp._bal;
  return v_touched;
end $$;

create or replace function public.delete_night(p_night_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_night public.nights;
begin
  if not public.is_super_admin() then
    raise exception 'only a super admin can remove a night' using errcode = '42501';
  end if;
  select * into v_night from public.nights where id = p_night_id;
  if not found then raise exception 'no such night'; end if;

  update public.nights set deleted_at = now()
   where id = p_night_id and deleted_at is null;

  -- A removed settled night was contributing points until a moment ago.
  perform public.recompute_season(v_night.season_id);
end $$;
revoke all on function public.delete_night(uuid) from public, anon, authenticated;
grant execute on function public.delete_night(uuid) to authenticated;

create or replace function public.restore_night(p_night_id uuid)
returns public.nights
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.nights;
begin
  if not public.is_super_admin() then
    raise exception 'only a super admin can restore a night' using errcode = '42501';
  end if;
  update public.nights set deleted_at = null
   where id = p_night_id returning * into v_row;
  if v_row.id is null then raise exception 'no such night'; end if;
  perform public.recompute_season(v_row.season_id);
  return v_row;
end $$;
revoke all on function public.restore_night(uuid) from public, anon, authenticated;
grant execute on function public.restore_night(uuid) to authenticated;

-- NOTE: this policy is replaced in 0014. As written here it hid removed
-- nights from organisers too, which made restoring impossible.
drop policy nights_read on public.nights;
create policy nights_read on public.nights for select to authenticated
  using (deleted_at is null
         and (status <> 'draft' or played_on >= current_date or public.is_admin()));

grant select (deleted_at) on public.nights to authenticated;

drop view if exists public.v_upcoming_nights;
create view public.v_upcoming_nights as
  select n.id as night_id, n.season_id, n.played_on, n.title, n.kind,
         n.status, n.counts_as_round, n.affects_points,
         n.stack_size, n.attendance_bonus, n.reports_close_at,
         n.location, n.location_url,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'going')     as going_count,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'not_going') as not_going_count
    from public.nights n
   where n.status not in ('settled','void')
     and n.deleted_at is null
     and n.played_on >= current_date;
grant select on public.v_upcoming_nights to anon, authenticated;

-- Rounds counter ignores removed nights too.
drop view if exists public.v_seasons;
create view public.v_seasons as
  select s.id as season_id, s.slug, s.name, s.starts_on, s.ends_on,
         s.status, s.is_current, s.starting_points, s.pseudonym_locks_at,
         (select count(*) from public.nights n
           where n.season_id = s.id and n.status = 'settled'
             and n.counts_as_round and n.deleted_at is null) as rounds
    from public.seasons s;
grant select on public.v_seasons to anon, authenticated;
