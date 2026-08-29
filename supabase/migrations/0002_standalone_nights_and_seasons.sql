-- ============================================================================
-- 0002: stand-alone nights and season rollover from the admin panel.
--
-- Two admin-facing gaps closed:
--  * affects_points on nights. counts_as_round governs only the ROUND counter;
--    affects_points governs whether a settled night moves season balances.
--    A stand-alone special (an Omaha night) is counts_as_round=false,
--    affects_points=false: entries and chip stats are recorded, the season
--    leaderboard never moves. The Welcome Round stays affects_points=true.
--  * start_season(): freezes the current season (its leaderboard becomes a
--    permanent record) and opens the new one, without SQL-editor access.
--
-- Note for a fresh install: apply 0001 then 0002 in order. This file matches
-- what was applied to production as standalone_nights_and_start_season.
-- ============================================================================

alter table public.nights add column affects_points boolean not null default true;
comment on column public.nights.affects_points is
  'false = stand-alone night: entries and chip stats are recorded, season balances never move.';
grant select (affects_points) on public.nights to authenticated;

-- create_night gains p_affects_points. The old signature must be dropped
-- first, or Postgres keeps both and PostgREST refuses the ambiguous name.
drop function public.create_night(uuid, date, text, public.night_kind, integer, integer, boolean);
create or replace function public.create_night(
  p_season_id uuid,
  p_played_on date,
  p_title text default null,
  p_kind public.night_kind default 'tournament',
  p_stack_size integer default null,
  p_attendance_bonus integer default null,
  p_counts_as_round boolean default true,
  p_affects_points boolean default true
) returns public.nights
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.nights; v_no smallint;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select coalesce(max(night_no), 0) + 1 into v_no
    from public.nights where season_id = p_season_id;
  insert into public.nights
    (season_id, night_no, played_on, title, kind, counts_as_round, affects_points,
     stack_size, attendance_bonus)
  values
    (p_season_id, v_no, p_played_on, nullif(btrim(coalesce(p_title,'')), ''), p_kind,
     p_counts_as_round, coalesce(p_affects_points, true),
     coalesce(p_stack_size, 10000), coalesce(p_attendance_bonus, 5000))
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.create_night(uuid, date, text, public.night_kind, integer, integer, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.create_night(uuid, date, text, public.night_kind, integer, integer, boolean, boolean)
  to authenticated;

-- recompute_season: chip stats and per-entry results for EVERY settled night;
-- balance movement only for nights that affect points.
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
     and (n.status <> 'settled' or e.voided_at is not null)
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
     where season_id = p_season_id and status = 'settled'
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
      -- Stand-alone night: record the per-entry result, leave balances alone.
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
        select count(*)                                                as cnt,
               count(*) filter (where not reported)                    as unrep,
               coalesce(sum(buyin_chips + rebuy_chips), 0)::bigint     as cin,
               coalesce(sum(coalesce(final_stack, 0)), 0)::bigint      as cout
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

-- Season rollover without SQL-editor access.
create or replace function public.start_season(
  p_slug text,
  p_name text,
  p_starts_on date,
  p_starting_points integer default 40000
) returns public.seasons
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.seasons;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if coalesce(btrim(p_slug), '') = '' or coalesce(btrim(p_name), '') = '' then
    raise exception 'slug and name are required';
  end if;
  if p_starting_points is null or p_starting_points < 0 then
    raise exception 'starting points must be zero or more';
  end if;
  if exists (select 1 from public.seasons where slug = btrim(p_slug)) then
    raise exception 'a season with that slug already exists' using errcode = '23505';
  end if;

  update public.seasons
     set status = 'frozen', is_current = false,
         ends_on = coalesce(ends_on, p_starts_on - 1)
   where is_current;

  insert into public.seasons (slug, name, starts_on, starting_points, status, is_current)
  values (btrim(p_slug), btrim(p_name), p_starts_on, p_starting_points, 'active', true)
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.start_season(text, text, date, integer) from public, anon, authenticated;
grant execute on function public.start_season(text, text, date, integer) to authenticated;
