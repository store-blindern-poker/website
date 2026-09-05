-- 0022: the nights count has to follow the points.
--
-- 0021 made points provisional and left nights_played behind. That column is
-- only ever written by recompute_season, from SETTLED nights, so a member
-- whose only night is still open read "0 nights" next to a number that had
-- plainly moved. cherry, whose result an organiser typed in by hand after she
-- went home, showed 27,500 points and 0 nights on the same row, and an
-- organiser who knew perfectly well she had been there reasonably read that
-- as the system losing her night.
--
-- ATTENDANCE COUNTS WHETHER OR NOT SOMEBODY REPORTED. That is the same rule
-- settling uses: recompute_season takes bool_or over every non-voided entry,
-- reported or not (0002_standalone_nights_and_seasons.sql, the deltas CTE).
-- Matching it here is what stops the number jumping the moment a night is
-- settled.
--
-- It also happens to be the honest split. Turning up is a fact we already
-- have: somebody checked in, took chips, and sat down. What their chips did
-- at the end is the part we are still waiting on. So a member who has not
-- reported reads one night played with their points unmoved, and the "not
-- reported" tag on the row is what explains why those two things sit
-- together.
--
-- Applied to production as 20260905xxxxxx_live_nights_played.

alter table public.season_scores
  add column if not exists live_nights integer;
comment on column public.season_scores.live_nights is
  'Provisional nights played, including unsettled nights the member turned up to. Null when no unsettled night touches them, so the view falls back to nights_played.';

-- Same function as 0021 with the attendance count added. Repeated in full
-- rather than patched, because this file is the record of what the function
-- became and a reader should not have to hold two versions in their head.
create or replace function public.recompute_live(p_season_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_night record; v_rows integer;
begin
  drop table if exists pg_temp._live;
  create temp table _live on commit drop as
    select en.member_id,
           coalesce(ss.points, en.starting_points)::bigint as bal,
           coalesce(ss.nights_played, 0)                   as played,
           false as pending,
           false as moved
      from public.season_enrollments en
      left join public.season_scores ss
             on ss.season_id = en.season_id and ss.member_id = en.member_id
     where en.season_id = p_season_id;

  for v_night in
    select * from public.nights
     where season_id = p_season_id
       and deleted_at is null
       and status in ('open', 'reconciling')
       and affects_points
     order by played_on, night_no, id
  loop
    with deltas as (
      select x.member_id, sum(x.d)::bigint as d
        from (
          select e.member_id,
                 (coalesce(e.final_stack, 0)::bigint
                  - (e.buyin_chips + e.rebuy_chips)
                  + v_night.attendance_bonus) as d
            from public.entries e
           where e.night_id = v_night.id
             and e.voided_at is null
             and e.reported
          union all
          select a.member_id, a.delta_points::bigint
            from public.adjustments a
           where a.night_id = v_night.id and a.member_id is not null
        ) x
       group by x.member_id
    )
    update _live b
       set bal = greatest(0, b.bal + d.d),
           moved = true
      from deltas d
     where d.member_id = b.member_id;

    -- Attendance, counted for everybody with a live entry on the night,
    -- reported or not. See the note at the top: this is settling's own rule,
    -- so the number does not move when the night is finally settled.
    update _live b
       set played = b.played + 1,
           moved  = true
      from public.entries e
     where e.night_id = v_night.id
       and e.voided_at is null
       and e.member_id = b.member_id;

    update _live b
       set pending = true
      from public.entries e
     where e.night_id = v_night.id
       and e.voided_at is null
       and not e.reported
       and e.member_id = b.member_id;
  end loop;

  update public.season_scores s
     set live_points  = case when l.moved or l.pending then l.bal else null end,
         live_nights  = case when l.moved or l.pending then l.played else null end,
         live_pending = l.pending
    from _live l
   where s.season_id = p_season_id and s.member_id = l.member_id;
  get diagnostics v_rows = row_count;

  insert into public.season_scores
    (season_id, member_id, points, points_prev, highest_points, lowest_points,
     nights_played, had_history, updated_at, live_points, live_nights, live_pending)
  select p_season_id, l.member_id, en.starting_points, en.starting_points,
         en.starting_points, en.starting_points, 0, false, now(),
         case when l.moved or l.pending then l.bal else null end,
         case when l.moved or l.pending then l.played else null end, l.pending
    from _live l
    join public.season_enrollments en
      on en.season_id = p_season_id and en.member_id = l.member_id
   where (l.moved or l.pending)
     and not exists (select 1 from public.season_scores s2
                      where s2.season_id = p_season_id and s2.member_id = l.member_id);

  drop table if exists pg_temp._live;
  return v_rows;
end $$;
revoke all on function public.recompute_live(uuid) from public, anon, authenticated;

-- Dropped rather than replaced: nights_played changes from a column to a
-- coalesce, and create or replace will not redefine an existing view column.
drop view if exists public.v_leaderboard;
create view public.v_leaderboard as
select s.season_id,
       en.pseudonym_at_time as pseudonym,
       coalesce(s.live_points, s.points)                                as points,
       s.points                                                        as settled_points,
       s.live_pending                                                  as pending,
       (s.live_points is not null and s.live_points <> s.points)        as provisional,
       s.highest_points,
       s.lowest_points,
       coalesce(s.live_nights, s.nights_played)                         as nights_played,
       rank() over (partition by s.season_id
                    order by coalesce(s.live_points, s.points) desc,
                             en.pseudonym_at_time)                      as rank,
       case when s.had_history
            then rank() over (partition by s.season_id
                              order by s.points_prev desc, en.pseudonym_at_time)
            else rank() over (partition by s.season_id
                              order by coalesce(s.live_points, s.points) desc,
                                       en.pseudonym_at_time)
       end                                                              as previous_rank
  from public.season_scores s
  join public.season_enrollments en
    on en.season_id = s.season_id and en.member_id = s.member_id
 where en.ranked
   and (s.nights_played > 0 or s.live_points is not null);
grant select on public.v_leaderboard to anon, authenticated;

select public.recompute_live(id) from public.seasons where is_current;
