-- 0024: what the round did to you, on the row.
--
-- The board says where you stand. It has never said how you got there. After
-- a round you had to remember last week's number to know whether the night
-- was good, and nobody does.
--
-- Two derived columns, appended to v_leaderboard:
--
--   points_delta   points gained or lost over the round
--   places_moved   places climbed (positive) or dropped (negative)
--
-- THE BASELINE MOVES WITH THE NIGHT, and that is the whole design.
--
-- points on this board is already live: it includes reported entries from a
-- night that is still open (0021). So a delta measured against the previous
-- SETTLED night would, mid-evening, add last week's result to tonight's and
-- report the sum as one number. Nobody could read it and it would not be
-- wrong in any way you could point at, which is the worst kind of wrong.
--
-- So the baseline is whatever the round in progress started from:
--
--   A points-affecting night is open or reconciling
--     baseline = settled points, the standings as that night opened.
--     The columns read "tonight so far" and grow as people report.
--
--   No such night
--     baseline = points_prev, the balance before the most recent settled
--     night. The columns read "last round" and hold until the next one opens.
--
-- This is also where the reset comes from, and it costs nothing. The moment
-- an organiser opens a night, the first branch takes over, live_points is
-- still null for everybody, and every delta is zero. The board clears itself
-- and starts counting again. No stored snapshot, no job to run, nothing to
-- forget at the start of a season.
--
-- ZERO IS A RESULT, NULL IS NOT A QUESTION WE CAN ANSWER. places_moved is
-- null only for a member with no earlier standing to be measured against: a
-- first-timer on the last settled round, where had_history is false. Zero
-- means they held their place, which is a different sentence. The page says
-- "first round" for one and nothing at all for the other.
--
-- A member who is not playing tonight still moves. If four people pass them
-- they are down four, with a delta of zero, and the row says so. That is not
-- a bug to be smoothed over: they did drop four places. The same honesty as
-- the "not reported" tag, which stays exactly as it was.
--
-- points_delta is the change in SEASON POINTS, not the raw chip result. The
-- two differ only where the floor-at-zero rule bites: lose 3,000 from 500 and
-- the chips say -3,000 while the board moved -500. The board is what this
-- column explains, so the board's number is the one it reports.
--
-- create or replace, not drop and create, because both columns go on the end
-- and Postgres allows that. 0021 and 0022 each had to drop the view, which
-- leaves a window where the public leaderboard is a 404 for anonymous
-- readers. There is no reason to spend that window on an append.
--
-- Applied to production as 20260919101725_leaderboard_movement, an hour after
-- Round 3 settled and with Round 4 already sitting in draft. Draft is not one
-- of the statuses that counts as open, so the board correctly kept showing
-- Round 3 rather than blanking itself on a night nobody has played yet.

create or replace view public.v_leaderboard as
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
       end                                                              as previous_rank,

       -- Appended by 0024. Everything above is untouched.

       -- True while a round is in progress, so the page can label the two
       -- columns "tonight" rather than "last round" without asking a second
       -- question of the database.
       o.night_open                                                     as delta_live,

       case when o.night_open
            then coalesce(s.live_points, s.points) - s.points
            else s.points - s.points_prev
       end                                                              as points_delta,

       case when o.night_open
            then rank() over (partition by s.season_id
                              order by s.points desc, en.pseudonym_at_time)
                 - rank() over (partition by s.season_id
                                order by coalesce(s.live_points, s.points) desc,
                                         en.pseudonym_at_time)
            when s.had_history
            then rank() over (partition by s.season_id
                              order by s.points_prev desc, en.pseudonym_at_time)
                 - rank() over (partition by s.season_id
                                order by coalesce(s.live_points, s.points) desc,
                                         en.pseudonym_at_time)
            else null
       end                                                              as places_moved

  from public.season_scores s
  join public.season_enrollments en
    on en.season_id = s.season_id and en.member_id = s.member_id
  -- Per season, not per row: a lateral so it is written once and Postgres can
  -- hoist it. deleted_at and affects_points both matter here. A removed night
  -- and a stand-alone game move nobody's points, so neither should blank the
  -- board's deltas while it sits there in some other status.
  cross join lateral (
    select exists (
      select 1 from public.nights n
       where n.season_id = s.season_id
         and n.deleted_at is null
         and n.affects_points
         and n.status in ('open', 'reconciling')
    ) as night_open
  ) o
 where en.ranked
   and (s.nights_played > 0 or s.live_points is not null);

grant select on public.v_leaderboard to anon, authenticated;

comment on view public.v_leaderboard is
  'Public standings. points is live (includes reported entries on open nights); settled_points is the settled truth. points_delta and places_moved describe the round in progress while one is open, and the most recent settled round otherwise, so they reset to zero the moment a night opens.';
