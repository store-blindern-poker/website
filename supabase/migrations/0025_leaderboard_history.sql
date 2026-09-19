-- 0025: the shape of a season, one row at a time.
--
-- The board says where you stand and 0024 says what the last round did. What
-- neither says is whether you got here steadily or on one enormous Friday,
-- and that is the question people actually ask each other at the table.
--
-- One array per member: their balance after each settled night that touched
-- points, in order, with the season's starting points on the front so that a
-- member with a single night still has a line to draw rather than a dot.
--
-- WHY THE NUMBERS ARE ALREADY THERE. recompute_season writes balance_after on
-- every entry as it walks the settled nights in order (0001, the _bal loop).
-- It has been doing that since the first migration and nothing has ever read
-- it. This view is a reader, not a new calculation, which is the only reason
-- it can be this short: no clamping, no attendance bonus, no re-deriving a
-- path that the settled arithmetic already walked. If these numbers are ever
-- wrong the bug is in recompute_season and the fix belongs there.
--
-- MISSED NIGHTS ARE NOT IN THE SERIES. A member who sat one out has no entry
-- for it, so their line joins the nights they played. The alternative, a flat
-- segment carried across the gap, says "nothing happened to me" in the same
-- visual language the board uses for "I played and broke even", and those are
-- different sentences. A line between the nights somebody actually played is
-- the honest shape of their season.
--
-- WHAT THIS MAKES PUBLIC, deliberately and worth saying out loud: a
-- pseudonymous per-night trajectory, where before only the current total and
-- the last round's change were readable anonymously. Somebody can now see
-- that a given pseudonym had a bad third Friday. That is the same class of
-- thing the board has always published, under the same pseudonym, for a club
-- whose whole method is making results visible. It is not new information
-- about a person, it is the existing information with its dates attached. No
-- real name, no email and no member_id is reachable from here, and the grant
-- is select-only to anon.
--
-- Applied to production as 20260919103112_leaderboard_history.

create or replace view public.v_leaderboard_history as
select en.season_id,
       en.pseudonym_at_time as pseudonym,
       -- starting_points first, then one value per settled night played.
       (en.starting_points::bigint)
         || array_agg(e.balance_after::bigint
                      order by n.played_on, n.night_no, n.id) as series
  from public.entries e
  join public.nights n
    on n.id = e.night_id
  join public.season_enrollments en
    on en.season_id = n.season_id and en.member_id = e.member_id
  -- THE CURRENT SEASON ONLY, which is what makes the ticker reset.
  --
  -- A season is a semester and everybody starts again at 40,000, so a line
  -- carried across that boundary would draw a cliff that never happened to
  -- anybody: it would join last term's final balance to this term's opening
  -- one as though it were a night's play. Filtering here rather than in the
  -- page means the reset needs nobody to remember it. start_season() freezes
  -- the old season and sets is_current on the new one, and on the next read
  -- every line is empty and fills up again from the first settled night.
  join public.seasons se
    on se.id = en.season_id and se.is_current
 where n.status = 'settled'
   and n.affects_points
   and n.deleted_at is null
   and e.voided_at is null
   and e.balance_after is not null
   and en.ranked
 group by en.season_id, en.pseudonym_at_time, en.starting_points;

grant select on public.v_leaderboard_history to anon, authenticated;

comment on view public.v_leaderboard_history is
  'One bigint array per member: season starting points followed by their balance after each settled night they played, in night order. Read by the leaderboard to draw a per-row trend line. Pseudonyms only; derived entirely from entries.balance_after, which recompute_season owns.';
