-- 0023: the live columns have to survive recompute_season.
--
-- 0021 hung the live refresh on a statement trigger on entries, and that
-- fires at the WRONG MOMENT during a settle. recompute_season updates entries
-- first (net_points, balance_after, scored_at), which fires the refresh and
-- writes the live columns, and THEN deletes season_scores wholesale and
-- re-inserts it without them. The refresh had already run. Everything it
-- wrote was thrown away half a second later.
--
-- The symptom was a public leaderboard silently falling back to settled-only
-- points: 30 rows instead of 51, every one of Round 1's thirty-eight players
-- reading 45,000 and one night, and the provisional banner above it still
-- promising standings that could change. It looked like data loss and was
-- not; the settled numbers were never in danger, only the derived ones.
--
-- Nothing warned about it because nothing could. The wipe is a legitimate
-- write by a function that has every right to rebuild that table, and the
-- refresh had already reported success.
--
-- So the refresh is now also attached to the thing that destroys it. An
-- AFTER INSERT statement trigger on season_scores runs after recompute_season
-- has finished rebuilding the table, which is the only moment the live
-- columns can be computed from correct settled values.
--
-- DELETE IS DELIBERATELY NOT A TRIGGER EVENT. recompute_season deletes before
-- it inserts, and a refresh fired on that delete would read an empty table,
-- fall back to starting_points for everybody, and then race the insert that
-- was about to follow. Insert only, so it runs exactly once, after the
-- rebuild, with correct settled values under it.
--
-- Verified by reproducing the wipe inside a transaction and rolling it back:
-- 38 members carried live_points before a full delete-and-rebuild and 38
-- carried them after, with the leader unchanged at 72,800.
--
-- Applied to production as 20260905131233_live_survives_recompute.

create or replace function public.trg_scores_live()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_season uuid;
begin
  -- recompute_live INSERTS into this same table for members whose only night
  -- is unsettled, so without this guard it would fire itself. The setting is
  -- transaction-local, so it cannot leak into another statement.
  if coalesce(current_setting('sbp.live_refresh', true), '') = '1' then
    return null;
  end if;

  -- The season comes from the rows that were actually written, not from
  -- is_current, so recomputing a finished season refreshes that season and
  -- not this one.
  select season_id into v_season from newrows limit 1;
  if v_season is null then return null; end if;

  perform set_config('sbp.live_refresh', '1', true);
  begin
    perform public.recompute_live(v_season);
  exception when others then
    -- Same rule as the entries trigger in 0021: a stale leaderboard is a
    -- nuisance, a failed settle is somebody's season.
    null;
  end;
  perform set_config('sbp.live_refresh', '0', true);
  return null;
end $$;

drop trigger if exists scores_live_refresh on public.season_scores;
create trigger scores_live_refresh
  after insert on public.season_scores
  referencing new table as newrows
  for each statement execute function public.trg_scores_live();

-- Put right what the wipe left behind.
select public.recompute_live(id) from public.seasons where is_current;
