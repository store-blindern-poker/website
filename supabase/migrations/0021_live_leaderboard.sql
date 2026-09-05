-- A leaderboard that moves as reports come in, and says so.
--
-- Until now the leaderboard only ever showed SETTLED nights. recompute_season
-- walks the settled ones and rebuilds season_scores; everything else is
-- invisible. That was fine when reporting closed at 09:00 and an organiser
-- settled over breakfast. With no deadline (0019) a night can stay open for
-- days, so the standings sat a week behind the poker.
--
-- WHAT THIS DOES NOT DO, and the distinction is the whole design:
--
--   season_scores.points stays the SETTLED truth. Nothing here writes it.
--   Settling is still the act that makes a night final, and recompute_season
--   is still the only thing that decides what final means.
--
--   Two new columns carry the provisional picture alongside it. They are
--   derived, they are labelled, and they can be thrown away and rebuilt at
--   any time without touching a single settled number.
--
-- HOW AN UNREPORTED PLAYER APPEARS. They keep the points they had, and the
-- row is flagged live_pending. Not zero, because zero is a judgement about
-- somebody who may just be asleep: on the first night six of thirty-eight
-- went home without reporting and the honest ones handed chips back. And not
-- hidden either, because a member who vanishes from the standings they were
-- in yesterday looks like a bug.
--
-- The flag is what stops the obvious trap. If reported losses moved people
-- down while silence left them where they were, the leaderboard would quietly
-- reward not reporting, which is the last thing an honour-system club should
-- build. Writing "not reported" on the row means the reason a number has not
-- moved is visible rather than flattering. Visibility, not enforcement: see
-- the club's own habit of flagging chip imbalances and never blocking on them.
--
-- Applied to production as 20260905100727_live_leaderboard.

alter table public.season_scores
  add column if not exists live_points  bigint,
  add column if not exists live_pending boolean not null default false;

comment on column public.season_scores.live_points is
  'Provisional points including REPORTED entries from nights that are open or reconciling. Null means no unsettled night touches this member, so points is already current. Never the settled truth: that is points.';
comment on column public.season_scores.live_pending is
  'This member has an entry on an unsettled night and has not reported it. Their live_points therefore does not include that night, and the leaderboard says so on the row.';

-- ---------------------------------------------------------------------------
-- The arithmetic, deliberately a copy of recompute_season's
-- ---------------------------------------------------------------------------

-- The delta and the clamp below are the same two lines recompute_season uses
-- (0002_standalone_nights_and_seasons.sql, the deltas CTE and the greatest(0,
-- ...) update). They are duplicated rather than shared because the settled
-- path must not grow a branch: a bug in the provisional view can be fixed on
-- a Tuesday, a bug in the settled one rewrites the season.
--
-- The clamp is applied PER NIGHT, in played_on order, exactly as settling
-- does. Folding it into one sum would be wrong the moment a member crosses
-- zero on the earlier of two unsettled nights, and two open nights is now the
-- normal case rather than a rare one: Round 1 stays open while Round 2 runs.
create or replace function public.recompute_live(p_season_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_night record; v_rows integer;
begin
  drop table if exists pg_temp._live;
  create temp table _live on commit drop as
    select en.member_id,
           coalesce(ss.points, en.starting_points)::bigint as bal,
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
    -- Only entries the member has actually REPORTED move anybody. An
    -- unreported entry is not a zero, it is an unknown, and it is carried by
    -- the pending flag below instead of by a number nobody has confirmed.
    -- Adjustments do count: an organiser typing one is a deliberate act.
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

    update _live b
       set pending = true
      from public.entries e
     where e.night_id = v_night.id
       and e.voided_at is null
       and not e.reported
       and e.member_id = b.member_id;
  end loop;

  -- Written only where there is something to say. A member no unsettled night
  -- touches keeps live_points null, and the view falls back to points, so the
  -- ordinary case costs nothing and reads as it always did.
  update public.season_scores s
     set live_points  = case when l.moved or l.pending then l.bal else null end,
         live_pending = l.pending
    from _live l
   where s.season_id = p_season_id and s.member_id = l.member_id;
  get diagnostics v_rows = row_count;

  -- A member whose ONLY night is unsettled has no season_scores row at all,
  -- because that table is rebuilt from settled nights. Give them one so they
  -- appear the moment they report, rather than after the night is settled.
  insert into public.season_scores
    (season_id, member_id, points, points_prev, highest_points, lowest_points,
     nights_played, had_history, updated_at, live_points, live_pending)
  select p_season_id, l.member_id, en.starting_points, en.starting_points,
         en.starting_points, en.starting_points, 0, false, now(),
         case when l.moved or l.pending then l.bal else null end, l.pending
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

-- ---------------------------------------------------------------------------
-- Keeping it current
-- ---------------------------------------------------------------------------

-- Reporting is the thing that must never fail. A member standing in a corridor
-- at 22:40 with one bar of signal is sending the only copy of a number nobody
-- else has, and the leaderboard is a convenience. So the refresh runs after
-- the row is safely written and ANY failure in it is swallowed: a stale
-- leaderboard is a nuisance, a lost report is somebody's season.
-- A STATEMENT trigger, not a row one: reporting a stack is one row, and
-- recomputing a whole season once per statement beats doing it per row when
-- an organiser fixes forty entries at once. The cost is that there is no NEW
-- or OLD to read, so the season is looked up rather than taken from the row.
-- Only nights that are still open can move live scores, so the newest open
-- night names the only season this can affect.
create or replace function public.trg_entries_live()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_season uuid;
begin
  select n.season_id into v_season
    from public.nights n
   where n.status in ('open','reconciling') and n.deleted_at is null
   order by n.played_on desc
   limit 1;
  if v_season is not null then
    begin
      perform public.recompute_live(v_season);
    exception when others then
      -- Deliberately silent. See the note above.
      null;
    end;
  end if;
  return null;
end $$;

drop trigger if exists entries_live_refresh on public.entries;
create trigger entries_live_refresh
  after insert or update or delete on public.entries
  for each statement execute function public.trg_entries_live();

-- ---------------------------------------------------------------------------
-- What the page reads
-- ---------------------------------------------------------------------------

-- security_invoker stays OFF, as on v_leaderboard: these run as owner and so
-- bypass RLS, which is how anonymous visitors see pseudonyms and points and
-- nothing else. Never set it true here, it would empty the public board.
-- Dropped rather than replaced: create or replace refuses to rename or
-- reorder an existing view's columns, and this adds three in the middle.
-- Checked first that nothing else depends on it; nothing did.
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
       s.nights_played,
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

-- The banner. One row per unsettled night that is moving the board, so the
-- page can say which night is provisional and how many people it is waiting
-- on, rather than a bare "provisional" that explains nothing.
create or replace view public.v_leaderboard_pending as
select n.season_id,
       n.id            as night_id,
       n.title,
       n.night_no,
       n.played_on,
       count(*) filter (where e.voided_at is null)                  as entries,
       count(*) filter (where e.voided_at is null and not e.reported) as unreported
  from public.nights n
  join public.entries e on e.night_id = n.id
 where n.deleted_at is null
   and n.status in ('open', 'reconciling')
   and n.affects_points
 group by n.season_id, n.id, n.title, n.night_no, n.played_on
having count(*) filter (where e.voided_at is null) > 0;
grant select on public.v_leaderboard_pending to anon, authenticated;

-- Fill it in for the season that is running, so the board is current the
-- moment this lands rather than after the next report.
select public.recompute_live(id) from public.seasons where is_current;
