-- 0005: members may change pseudonym until the season locks.
--
-- The rule was always "only at season start". This makes it real instead of a
-- convention, and gives people a self-serve path so nobody resorts to creating
-- a second account, which orphans their history. (That happened once before
-- this shipped, which is why it exists.)
--
-- Applied to production as: pseudonym_change_with_deadline

alter table public.seasons add column if not exists pseudonym_locks_at timestamptz;
comment on column public.seasons.pseudonym_locks_at is
  'After this moment, pseudonyms are frozen for the season. Null means never locks.';

-- Fall 2026 locks when the first round starts: Friday 4 September 2026, 18:00 Oslo.
update public.seasons
   set pseudonym_locks_at = (date '2026-09-04' + time '18:00') at time zone 'Europe/Oslo'
 where slug = 'fall-2026';

-- New seasons default to locking at 18:00 on the first night.
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

  insert into public.seasons
    (slug, name, starts_on, starting_points, status, is_current, pseudonym_locks_at)
  values
    (btrim(p_slug), btrim(p_name), p_starts_on, p_starting_points, 'active', true,
     (p_starts_on + time '18:00') at time zone 'Europe/Oslo')
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.start_season(text, text, date, integer) from public, anon, authenticated;
grant execute on function public.start_season(text, text, date, integer) to authenticated;

-- Change your own pseudonym. Self only, always. Releases the old name, which is
-- exactly the documented rule: a pseudonym is reserved to its holder until that
-- holder changes it.
create or replace function public.change_pseudonym(p_pseudonym text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self uuid := public.current_member_id();
  v_key text; v_season public.seasons;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;

  select * into v_season from public.seasons where is_current;
  if v_season.pseudonym_locks_at is not null and now() >= v_season.pseudonym_locks_at then
    raise exception 'pseudonyms are locked for this season. Ask an organiser, or change it when the next season opens'
      using errcode = 'P0030';
  end if;

  p_pseudonym := btrim(coalesce(p_pseudonym, ''));
  v_key := public.norm_pseudonym(p_pseudonym);
  if char_length(p_pseudonym) not between 2 and 32 or v_key = '' then
    raise exception 'a pseudonym is 2 to 32 characters';
  end if;

  -- Somebody else holding it blocks the change. Re-casing your own is fine.
  if exists (
    select 1 from public.members
     where pseudonym_key = v_key and is_active and id <> v_self
  ) then
    raise exception 'that pseudonym is taken' using errcode = '23505';
  end if;

  update public.members set pseudonym = p_pseudonym where id = v_self;

  -- The current season shows the new name. Past seasons keep the name as it was:
  -- the hall of fame is a historical record, not a live index.
  update public.season_enrollments
     set pseudonym_at_time = p_pseudonym
   where member_id = v_self and season_id = v_season.id;

  return p_pseudonym;
end $$;
revoke all on function public.change_pseudonym(text) from public, anon, authenticated;
grant execute on function public.change_pseudonym(text) to authenticated;

-- Surface the deadline so the UI can show it and count down to it.
-- Dropped and recreated because column order changes.
drop view if exists public.v_seasons;
create view public.v_seasons as
  select s.id as season_id, s.slug, s.name, s.starts_on, s.ends_on,
         s.status, s.is_current, s.starting_points, s.pseudonym_locks_at,
         (select count(*) from public.nights n
           where n.season_id = s.id and n.status = 'settled' and n.counts_as_round)
           as rounds
    from public.seasons s;
grant select on public.v_seasons to anon, authenticated;
