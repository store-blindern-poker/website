-- Telling this semester's players that the next round is open.
--
-- When an organiser adds a night to the tournament series they can send one
-- email to everybody who has already played this semester. The list is
-- derived from entries in the CURRENT SEASON, so it resets itself every
-- semester with nobody having to remember to clear anything.
--
-- This mail is different in kind from the reminder in 0018. That one is
-- transactional: it tells one person a fact about their own night that only
-- they can fix. This one is an announcement to the whole room. Announcements
-- need a way out, so this migration adds one, and both mail paths respect it.
--
-- Applied to production as 20260905082646_round_announcements.

-- ---------------------------------------------------------------------------
-- Opting out
-- ---------------------------------------------------------------------------

alter table public.member_private
  add column if not exists email_opt_out boolean not null default false;
comment on column public.member_private.email_opt_out is
  'Member asked to stop receiving club announcements. Announcements skip them. The unreported reminder does NOT, because it is transactional: it tells somebody their own night is about to be recorded as a loss, and going quiet on that would cost them points.';

-- A capability, not an identifier. It goes in a link in an email, so it must
-- not be guessable from anything public and must not be the member id: that
-- id appears in other places, and a link that leaks it would let a stranger
-- correlate an address with a pseudonym.
alter table public.member_private
  add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists member_private_unsub_token_idx
  on public.member_private (unsubscribe_token);
comment on column public.member_private.unsubscribe_token is
  'Bearer token for the unsubscribe link. Random, stable per member, never exposed to any client except inside that member''s own email.';

-- Nobody reads these two from a browser. The service role bypasses grants and
-- is the only thing that touches them, from the edge functions.
revoke select (email_opt_out, unsubscribe_token) on public.member_private from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Which nights have been announced
-- ---------------------------------------------------------------------------

alter table public.nights
  add column if not exists announced_at timestamptz;
comment on column public.nights.announced_at is
  'When the "registration is open" mail went out for this night. Set only after mail actually left, so a failed send is retried by the next press rather than being silently treated as done.';
grant select (announced_at) on public.nights to authenticated;

-- ---------------------------------------------------------------------------
-- What the console is allowed to know
-- ---------------------------------------------------------------------------

-- Deliberately NO email column, and no per-person rows at all. The console
-- needs a number to put on a button and nothing else. Addresses stay on the
-- server, which is the same rule the reminder follows in 0018.
create or replace function public.announce_audience(p_night_id uuid)
returns table (
  season_name   text,
  will_email    integer,
  opted_out     integer,
  no_address    integer,
  already_sent  timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_season uuid; v_name text; v_sent timestamptz;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select n.season_id, n.announced_at into v_season, v_sent
    from public.nights n where n.id = p_night_id and n.deleted_at is null;
  if v_season is null then raise exception 'night not found'; end if;
  select s.name into v_name from public.seasons s where s.id = v_season;

  return query
  with played as (
    -- Anyone who turned up to ANY night this season, including the Welcome
    -- Round and one-off side events. Somebody whose only night was the
    -- welcome is exactly the person worth inviting back.
    select distinct e.member_id
      from public.entries e
      join public.nights n2 on n2.id = e.night_id
     where n2.season_id = v_season
       and n2.deleted_at is null
       and e.voided_at is null
  )
  select v_name,
         count(*) filter (
           where mp.email is not null and mp.email <> '' and not mp.email_opt_out
         )::integer,
         count(*) filter (where mp.email_opt_out)::integer,
         count(*) filter (where mp.email is null or mp.email = '')::integer,
         v_sent
    from played p
    join public.members m on m.id = p.member_id and m.deleted_at is null
    left join public.member_private mp on mp.member_id = p.member_id;
end $$;
revoke all on function public.announce_audience(uuid) from public, anon, authenticated;
grant execute on function public.announce_audience(uuid) to authenticated;

-- Called by the edge function with the service role AFTER a send, so the
-- stamp only ever reflects mail that actually left. Granted to nobody: no
-- browser should be able to mark a night announced without announcing it.
create or replace function public.mark_announced(p_night_id uuid)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_at timestamptz;
begin
  update public.nights set announced_at = now()
   where id = p_night_id returning announced_at into v_at;
  return v_at;
end $$;
revoke all on function public.mark_announced(uuid) from public, anon, authenticated;
