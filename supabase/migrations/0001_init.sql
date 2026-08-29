-- ============================================================================
-- Store Blindern Poker - migration 0001_init.sql
-- One coherent file: privileges, types, tables, functions, views, RLS,
-- policies, grants, RPCs, seed. Apply once to a fresh Supabase project.
--
-- POINTS ONLY. This system tracks points and chips. No money is ever
-- wagered, staked, exchanged or represented anywhere in this schema.
--
-- Scoring model (the whole game, in five lines):
--   * A season = a semester. Everyone starts a season at 40,000 points,
--     including mid-season joiners.
--   * Per night, a flat attendance bonus (default 5,000, admin-overridable
--     per night) is credited FIRST.
--   * Buy-in = min(stack_size tonight, the player's points incl. the bonus).
--     stack_size is a per-night admin setting, default 10,000.
--   * One rebuy per night max, 1:1 points-for-chips, capped at stack_size
--     and at the player's remaining points.
--   * net for the night = final_stack - (buy-in + rebuy) + attendance bonus.
--     A season balance can NEVER go below zero (clamped in recompute).
--
-- Deviations from IMPLEMENTATION_PLAN.md section 4, all forced by the
-- hard facts that supersede it:
--   * entries stores ONE typed final_stack total. The six denomination
--     columns (c25..c5000) are gone: denominations vary night to night and
--     members report a typed total.
--   * nights.buyin_chips/assembly_base/assembly_increment/max_rebuy_chips
--     are replaced by nights.stack_size + nights.attendance_bonus (flat).
--   * check_in books buyin = min(stack_size, balance + bonus), not a flat
--     amount, and books the rebuy cap from remaining points.
--   * Floor-at-zero is path-dependent, so the leaderboard cannot be a
--     window-sum view. recompute_season() walks settled nights in order,
--     clamps at zero, and persists results into season_scores; the
--     v_leaderboard view reads season_scores.
--   * add_adjustment() and create_night() RPCs added (admin corrections and
--     weekly night creation without SQL-editor access).
--   * nights.code added (post-plan decision): a per-night 5-character
--     attendance code, generated server-side when the night row is created,
--     required by check_in() for member self check-in (admins exempt), shown
--     to admins via get_night_code(), and never readable by plain members.
-- ============================================================================


-- ============================================================================
-- 1. DENY BY DEFAULT
-- The single most important block in this file: if a future migration forgets
-- RLS or a grant, anon and authenticated still see nothing. Everything below
-- grants access back, narrowly. service_role is deliberately untouched.
-- NOTE: functions get EXECUTE for PUBLIC by default in Postgres, so PUBLIC
-- must be revoked here too (the plan's version missed this for new functions).
-- ============================================================================

alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
revoke all on all sequences in schema public from anon, authenticated;

-- No extensions needed: gen_random_uuid() is core since Postgres 13, and
-- member_private.email is plain text (admin-only column, no unique index,
-- so citext buys nothing). pgcrypto/citext from the plan are dropped so the
-- blanket function revokes above cannot break extension internals.


-- ============================================================================
-- 2. TYPES AND HELPERS
-- ============================================================================

create type public.night_status  as enum ('draft','open','reconciling','settled','void');
create type public.night_kind    as enum ('tournament','welcome','special','bonus_only');
create type public.season_status as enum ('active','frozen');

-- Reproduces the legacy comparator exactly: lowercase, all whitespace removed.
-- Must stay IMMUTABLE: it backs a generated column.
create or replace function public.norm_pseudonym(p text)
returns text language sql immutable parallel safe as $$
  select regexp_replace(lower(btrim(coalesce(p,''))), '\s+', '', 'g');
$$;


-- ============================================================================
-- 3. IDENTITY
-- ============================================================================

create table public.members (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique references auth.users(id) on delete set null,
  pseudonym      text check (char_length(pseudonym) between 2 and 32),
  pseudonym_key  text generated always as (public.norm_pseudonym(pseudonym)) stored,
  joined_on      date not null default current_date,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
comment on table public.members is
  'Pseudonym is the ONLY public identity. Never add a name/email column here.';

-- A pseudonym is reserved to its holder for as long as they hold it.
create unique index members_pseudonym_uidx
  on public.members (pseudonym_key) where pseudonym is not null and is_active;
-- (no separate index on auth_user_id: the UNIQUE constraint already made one)

-- The ONLY place a legal name or email is stored. Never reachable by anon,
-- never exported, never committed to git.
create table public.member_private (
  member_id  uuid primary key references public.members(id) on delete cascade,
  real_name  text,
  email      text,
  updated_at timestamptz not null default now()
);
comment on table public.member_private is
  'Admin-only PII. RLS: admins may SELECT; there is no client write path.';

-- Admin roles. There is deliberately NO client write path to this table:
-- the only way to become an admin is a SQL-editor INSERT by a human.
create table public.admins (
  member_id  uuid primary key references public.members(id) on delete cascade,
  granted_by uuid references public.members(id),
  granted_at timestamptz not null default now()
);

create or replace function public.current_member_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.members where auth_user_id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.admins a
    join public.members m on m.id = a.member_id
    where m.auth_user_id = auth.uid()
  );
$$;


-- ============================================================================
-- 4. SEASONS, NIGHTS, ENTRIES, ADJUSTMENTS, SCORES
-- ============================================================================

create table public.seasons (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  name            text not null,
  starts_on       date not null,
  ends_on         date,
  starting_points integer not null default 40000
                  check (starting_points >= 0),
  status          public.season_status not null default 'active',
  is_current      boolean not null default false
);
create unique index seasons_one_current on public.seasons (is_current) where is_current;

create table public.season_enrollments (
  season_id         uuid not null references public.seasons(id) on delete cascade,
  member_id         uuid not null references public.members(id) on delete cascade,
  -- Frozen at enrolment: history keeps the pseudonym as it was.
  pseudonym_at_time text not null,
  -- Everyone starts at the season default (40,000), mid-season joiners included.
  starting_points   integer not null default 40000 check (starting_points >= 0),
  ranked            boolean not null default true,
  enrolled_at       timestamptz not null default now(),
  primary key (season_id, member_id)
);
create index season_enrollments_member_idx on public.season_enrollments (member_id);

create table public.nights (
  id              uuid primary key default gen_random_uuid(),
  season_id       uuid not null references public.seasons(id) on delete restrict,
  night_no        smallint not null,
  played_on       date not null,   -- Europe/Oslo calendar date, set explicitly, never from now()
  title           text,
  kind            public.night_kind not null default 'tournament',
  status          public.night_status not null default 'draft',
  counts_as_round boolean not null default true,

  -- Per-night attendance code: 5 characters from an unambiguous alphabet
  -- (no 0/O, 1/I/L). Shown as a QR + giant text on the venue TV; check_in()
  -- demands it from members checking themselves in (admins are exempt).
  -- Assigned by the nights_code_before_insert trigger below on EVERY
  -- creation path (create_night(), the seed, a SQL-editor insert), so no
  -- open-time backfill is ever needed. Stored uppercase, compared
  -- case-insensitively. Deliberately absent from the authenticated column
  -- grant in section 8: members never read it -- they get it from the TV.
  code text not null
       check (code ~ '^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{5}$'),

  -- The per-night knobs live HERE. Editing them affects this night only.
  -- stack_size: chips handed out per buy-in (chip shortage can lower it,
  -- e.g. 9,700 has happened). attendance_bonus: flat, credited FIRST.
  stack_size       integer not null default 10000 check (stack_size >= 0),
  attendance_bonus integer not null default 5000  check (attendance_bonus >= 0),

  -- Written by recompute_season(); never by a client.
  entry_count      integer not null default 0,
  unreported_count integer not null default 0,
  chips_in         bigint  not null default 0,
  chips_out        bigint  not null default 0,
  chip_balance     bigint  not null default 0,   -- flagged, never blocks settle

  opened_at    timestamptz,
  closed_at    timestamptz,
  settled_at   timestamptz,
  settled_by   uuid references public.members(id),
  revision     integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (season_id, night_no),
  unique (season_id, played_on),
  unique (id, season_id)                          -- composite FK target for entries
);
create index nights_order_idx on public.nights (season_id, played_on, night_no);
comment on column public.nights.chip_balance is
  'chips_out - chips_in for the night. Imbalance is recorded and shown, never a blocker.';
comment on column public.nights.code is
  'Per-night attendance code. Admin-only read (get_night_code); validated server-side in check_in.';

-- The rule: a code is unique among non-settled nights, so the code on the TV
-- can only ever mean one live night. gen_night_code() is stricter still --
-- it never reuses a code across ANY existing night -- so reopening a settled
-- night for corrections can never collide with a newer night's code.
create unique index nights_code_live_uidx on public.nights (code)
  where status <> 'settled';

-- 5 random characters from the 31-char unambiguous alphabet (0/O, 1/I/L
-- removed). 31^5 ~ 28.6 million codes against ~30 nights a year: the retry
-- loop is theory, not practice. Internal: no EXECUTE grant (section 10
-- strips it); runs inside the insert trigger under a definer/owner context.
create or replace function public.gen_night_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text;
begin
  loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * 31)::int, 1), '')
      into v_code
      from generate_series(1, 5);
    exit when not exists (select 1 from public.nights where code = v_code);
  end loop;
  return v_code;
end $$;

-- Server-side generation at creation time, on every path a night row can be
-- born (create_night(), the seed below, a SQL-editor insert). A hand-given
-- code is kept but normalised to uppercase; the table CHECK then enforces
-- the alphabet.
create or replace function public.trg_nights_code()
returns trigger language plpgsql as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := public.gen_night_code();
  else
    new.code := upper(btrim(new.code));
  end if;
  return new;
end $$;

create trigger nights_code_before_insert
  before insert on public.nights
  for each row execute function public.trg_nights_code();

create table public.entries (
  id        uuid primary key default gen_random_uuid(),
  night_id  uuid not null,
  season_id uuid not null,
  member_id uuid not null,

  -- Booked at check-in by the server from the member''s balance and the
  -- night''s stack_size. Members have no write path to these.
  buyin_chips     integer not null check (buyin_chips >= 0),
  rebuy_cap_chips integer not null check (rebuy_cap_chips >= 0),

  rebuy_chips integer not null default 0,
  reported    boolean not null default false,

  -- HARD FACT: one TYPED total, no per-denomination counting
  -- (denominations vary night to night). NULL until reported; an
  -- unreported entry scores as a zero final stack.
  final_stack integer check (final_stack is null or final_stack >= 0),

  -- Written by recompute_season(); never by a client.
  attendance_bonus_awarded integer,
  net_points               integer,   -- final_stack - (buyin + rebuy) + bonus
  balance_after            bigint,    -- season balance after this night (>= 0, clamped)
  scored_at                timestamptz,

  checked_in_by uuid references public.members(id),
  reported_by   uuid references public.members(id),
  reported_via  text not null default 'self'
                check (reported_via in ('self','admin','paper','import')),
  note          text,
  voided_at     timestamptz,
  voided_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- ONE ROW PER MEMBER PER NIGHT. This *is* the one-rebuy-per-night rule:
  -- there is nowhere to put a second rebuy.
  unique (night_id, member_id),
  foreign key (night_id, season_id)  references public.nights(id, season_id) on delete cascade,
  foreign key (season_id, member_id) references public.season_enrollments(season_id, member_id)
    on delete restrict,

  constraint entries_rebuy_nonneg check (rebuy_chips >= 0),
  constraint entries_rebuy_cap    check (rebuy_chips <= rebuy_cap_chips)
);
create index entries_night_idx  on public.entries (night_id);
create index entries_member_idx on public.entries (season_id, member_id);

-- Admin corrections and imbalance notes, visible in history. The UI is
-- deferred; the add_adjustment() RPC exists now so corrections are recorded,
-- not improvised. member_id NULL = night-level note (carries no points).
create table public.adjustments (
  id           uuid primary key default gen_random_uuid(),
  night_id     uuid not null,
  season_id    uuid not null,
  member_id    uuid references public.members(id),
  delta_points integer not null default 0,
  kind         text not null check (kind in ('imbalance','correction','manual')),
  reason       text not null,
  created_by   uuid references public.members(id),
  created_at   timestamptz not null default now(),
  foreign key (night_id, season_id) references public.nights(id, season_id) on delete cascade,
  constraint adjustments_memberless_zero check (member_id is not null or delta_points = 0)
);
create index adjustments_night_idx on public.adjustments (night_id);

-- Season standings, persisted by recompute_season(). This is a table (not a
-- window-sum view) because the floor-at-zero rule makes balances
-- path-dependent: they must be rebuilt night by night, in order.
create table public.season_scores (
  season_id      uuid not null references public.seasons(id) on delete cascade,
  member_id      uuid not null references public.members(id) on delete cascade,
  points         bigint not null,
  points_prev    bigint not null,   -- balance before the most recent settled night
  highest_points bigint not null,
  lowest_points  bigint not null,
  nights_played  integer not null default 0,
  had_history    boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (season_id, member_id)
);
comment on table public.season_scores is
  'Output of recompute_season(). Never written by a client; read via v_leaderboard.';


-- ============================================================================
-- 5. SCORING
-- ============================================================================

-- Current settled balance for a member in a season. Internal helper: no
-- EXECUTE grant; called from SECURITY DEFINER RPCs only.
create or replace function public.member_balance(p_season_id uuid, p_member_id uuid)
returns bigint language sql stable as $$
  select coalesce(
    (select points          from public.season_scores
      where season_id = p_season_id and member_id = p_member_id),
    (select starting_points::bigint from public.season_enrollments
      where season_id = p_season_id and member_id = p_member_id),
    (select starting_points::bigint from public.seasons where id = p_season_id),
    40000
  );
$$;

-- ===========================================================================
-- THE SCORING RULE, in one place.
--   net = final_stack - (buyin + rebuy) + attendance_bonus   (flat, per night)
--   balance = greatest(0, previous balance + net + adjustments)  <- HARD FACT:
--   a season balance can NEVER go below zero.
-- The NUMBERS live on the nights row. Do not put numbers in this function.
-- Fully idempotent: rebuilds every settled night from raw entries, in order,
-- every time, and persists the result into season_scores. At ~1,300 rows a
-- season this is milliseconds. There is no incremental path to get subtly
-- wrong.
-- ===========================================================================
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

  -- Clear stale scores on nights that are no longer settled (e.g. a night
  -- reopened for correction) and on entries voided since they were scored,
  -- so nothing displays half-truths meanwhile.
  update public.entries e
     set attendance_bonus_awarded = null, net_points = null,
         balance_after = null, scored_at = null
    from public.nights n
   where n.id = e.night_id and n.season_id = p_season_id
     and (n.status <> 'settled' or e.voided_at is not null)
     and e.scored_at is not null;

  -- Running balances, walked night by night. pg_temp is schema-qualified
  -- everywhere so nothing in public can ever shadow it.
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
    -- Snapshot "before this night" for everyone: after the loop these hold
    -- the state before the most recent settled night (drives previous_rank).
    update pg_temp._bal set prev_bal = bal, prev_played = played;

    -- Entry deltas and same-night adjustments, applied together, clamped
    -- at zero as one step. (Points can never go below zero.)
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

    update pg_temp._bal set high = greatest(high, bal), low = least(low, bal);

    -- Write the per-entry audit trail.
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

    -- Chip conservation, computed across the NIGHT, never per table:
    -- players switch tables, so chips are conserved only night-wide.
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


-- ============================================================================
-- 6. PUBLIC VIEWS
-- security_invoker is OFF (the default): these views run as their owner and
-- so bypass RLS on the base tables. That is DELIBERATE and is how column-
-- level privacy is achieved -- anon has no grant on any base table, and
-- these views expose only pseudonym and points. Supabase's linter will flag
-- them; that is expected. Never set security_invoker = true here: it would
-- empty the public leaderboard.
-- ============================================================================

create or replace view public.v_leaderboard as
select s.season_id,
       en.pseudonym_at_time as pseudonym,
       s.points,
       s.highest_points,
       s.lowest_points,
       s.nights_played,
       rank() over (partition by s.season_id
                    order by s.points desc, en.pseudonym_at_time)      as rank,
       case when s.had_history
            then rank() over (partition by s.season_id
                              order by s.points_prev desc, en.pseudonym_at_time)
            else rank() over (partition by s.season_id
                              order by s.points desc, en.pseudonym_at_time)
       end                                                             as previous_rank
  from public.season_scores s
  join public.season_enrollments en
    on en.season_id = s.season_id and en.member_id = s.member_id
 where en.ranked
   and s.nights_played > 0;   -- WHERE runs before window functions, so ranks
                              -- are computed only among people who played.

create or replace view public.v_seasons as
  select s.id as season_id, s.slug, s.name, s.starts_on, s.ends_on,
         s.status, s.is_current,
         (select count(*) from public.nights n
           where n.season_id = s.id and n.status = 'settled' and n.counts_as_round)
           as rounds
    from public.seasons s;

-- Unclaimed pseudonyms, for the claim screen. Pseudonym only. No dates, no
-- names, and signed-in users only.
create or replace view public.v_unclaimed_pseudonyms as
  select pseudonym from public.members
   where auth_user_id is null and pseudonym is not null and is_active;


-- ============================================================================
-- 7. RLS -- enabled on every table, no exceptions. All policies are
-- SELECT-only: every write goes through a SECURITY DEFINER RPC.
-- ============================================================================

alter table public.members            enable row level security;
alter table public.member_private     enable row level security;
alter table public.admins             enable row level security;
alter table public.seasons            enable row level security;
alter table public.season_enrollments enable row level security;
alter table public.nights             enable row level security;
alter table public.entries            enable row level security;
alter table public.adjustments        enable row level security;
alter table public.season_scores      enable row level security;

-- members: you can read your own row; admins read all. No client writes.
create policy members_self  on public.members for select to authenticated
  using (auth_user_id = auth.uid());
create policy members_admin on public.members for select to authenticated
  using (public.is_admin());

-- member_private: admins only, and only via SELECT. No anon policy of any kind.
create policy mp_admin on public.member_private for select to authenticated
  using (public.is_admin());

-- admins: readable by admins. There is NO insert/update/delete policy, so the
-- ONLY way to become an admin is a SQL-editor INSERT by a human with the
-- service key. This closes the self-promotion hole.
create policy admins_read on public.admins for select to authenticated
  using (public.is_admin());

create policy seasons_read on public.seasons for select to authenticated
  using (true);

create policy enroll_read on public.season_enrollments for select to authenticated
  using (member_id = public.current_member_id() or public.is_admin());

create policy nights_read on public.nights for select to authenticated
  using (status <> 'draft' or public.is_admin());

-- entries: a member may read their own; admins read all.
create policy entries_own   on public.entries for select to authenticated
  using (member_id = public.current_member_id());
create policy entries_admin on public.entries for select to authenticated
  using (public.is_admin());

create policy adj_read on public.adjustments for select to authenticated
  using (public.is_admin());

create policy scores_read on public.season_scores for select to authenticated
  using (member_id = public.current_member_id() or public.is_admin());


-- ============================================================================
-- 8. TABLE AND VIEW GRANTS
-- anon gets TWO VIEWS and nothing else, ever.
-- ============================================================================

grant usage on schema public to anon, authenticated;

-- Belt and braces: whatever any project-level default privilege may have
-- granted while the tables and views above were being created, strip it now,
-- then grant back exactly the intended surface.
revoke all on all tables in schema public from anon, authenticated;

grant select on public.v_leaderboard, public.v_seasons to anon, authenticated;
grant select on public.v_unclaimed_pseudonyms to authenticated;

-- Base tables: authenticated only; rows still filtered by the policies above.
grant select on public.members, public.member_private, public.admins,
                public.seasons, public.season_enrollments,
                public.entries, public.adjustments,
                public.season_scores
  to authenticated;

-- nights gets a COLUMN-LEVEL grant: every column EXCEPT code. RLS narrows
-- rows (no drafts for non-admins) but cannot hide a column, and the open
-- night is exactly the row members can read -- a table-level grant would
-- hand every member tonight's code from their sofa. Admins read the code
-- via get_night_code() (RPC, section 9) instead.
-- CLIENT CONSEQUENCE: select('*') on nights now fails with 42501 for
-- authenticated (PostgREST expands * to all columns, code included). Every
-- client read of nights must name its columns.
grant select (id, season_id, night_no, played_on, title, kind, status,
              counts_as_round, stack_size, attendance_bonus,
              entry_count, unreported_count, chips_in, chips_out,
              chip_balance, opened_at, closed_at, settled_at, settled_by,
              revision, created_at)
  on public.nights to authenticated;


-- ============================================================================
-- 9. RPCs -- every write path, plus one privileged read (get_night_code).
-- Every write is a SECURITY DEFINER function whose member identity is derived
-- from auth.uid(), never trusted from the client. p_member_id parameters are
-- honoured only for admins (proxy actions).
-- ============================================================================

-- Sign in, then claim a pseudonym. Links or creates the member row and enrols
-- them in the current season. This is the ONLY way a member row gets an auth
-- user. Reversible by an admin (SQL: set auth_user_id = null).
create or replace function public.claim_pseudonym(p_pseudonym text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_key text; v_member uuid; v_existing uuid; v_season uuid; v_email text;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  p_pseudonym := btrim(coalesce(p_pseudonym, ''));
  v_key := public.norm_pseudonym(p_pseudonym);
  if char_length(p_pseudonym) not between 2 and 32 or v_key = '' then
    raise exception 'pseudonym must be 2-32 characters';
  end if;

  select id into v_member from public.members where auth_user_id = auth.uid();
  if v_member is not null then
    return v_member;                      -- already claimed; idempotent
  end if;

  select email into v_email from auth.users where id = auth.uid();

  select id into v_existing from public.members
   where pseudonym_key = v_key and is_active;

  if v_existing is not null then
    -- Guarded against two people racing for the same legacy pseudonym.
    update public.members set auth_user_id = auth.uid()
     where id = v_existing and auth_user_id is null;
    if not found then
      raise exception 'that pseudonym is already taken' using errcode = '23505';
    end if;
    v_member := v_existing;
  else
    insert into public.members (auth_user_id, pseudonym)
    values (auth.uid(), p_pseudonym)
    returning id into v_member;
  end if;

  insert into public.member_private (member_id, email)
  values (v_member, v_email)
  on conflict (member_id) do update set email = excluded.email, updated_at = now();

  select id into v_season from public.seasons where is_current;
  if v_season is not null then
    insert into public.season_enrollments
      (season_id, member_id, pseudonym_at_time, starting_points)
    select v_season, v_member, m.pseudonym, s.starting_points
      from public.members m, public.seasons s
     where m.id = v_member and s.id = v_season
    on conflict do nothing;
  end if;

  return v_member;
end $$;

-- Check in (self, or any member if the caller is an admin). Enrols if needed,
-- then books the buy-in and the rebuy cap server-side. Idempotent: a second
-- check-in never rebooks or changes the numbers.
-- HARD FACTS applied here: the attendance bonus is credited FIRST; the buy-in
-- is min(stack_size tonight, points incl. the bonus); the rebuy cap is
-- min(stack_size, points remaining after the buy-in). Nobody can go below
-- zero and nobody is excluded for lack of points.
-- THE NIGHT CODE GATE: a member's FIRST check-in must carry tonight's code
-- (from the TV / the QR's ?n=). Validation is case-insensitive and forgiving
-- about spaces and dashes. Distinct SQLSTATEs so the client can show honest
-- copy: P0010 = code missing, P0011 = wrong code. The gate applies exactly
-- once -- a member who already has an entry re-checks-in freely (that is
-- what report_entry's implicit call does, including during 'reconciling') --
-- and NEVER applies to admins: the organiser proxy path and admin self
-- check-in skip the code entirely, on any night status (retro entry of the
-- Welcome Round on a draft night depends on that).
create or replace function public.check_in(
  p_night_id uuid,
  p_code text default null,
  p_member_id uuid default null
) returns public.entries
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

  select exists (
    select 1 from public.entries
     where night_id = p_night_id and member_id = v_member
  ) into v_has_entry;

  if not v_admin then
    if v_has_entry then
      -- Idempotent re-check-in (the path report_entry takes): allowed while
      -- reporting is possible at all, i.e. open or reconciling. No code.
      if v_night.status not in ('open', 'reconciling') then
        raise exception 'night is not open' using errcode = 'P0001';
      end if;
    else
      -- First check-in: doors must be open and the code must match.
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

  -- Enrol on first contact. Mid-season joiners start at the season default.
  insert into public.season_enrollments
    (season_id, member_id, pseudonym_at_time, starting_points)
  select v_night.season_id, v_member, m.pseudonym, s.starting_points
    from public.members m, public.seasons s
   where m.id = v_member and s.id = v_night.season_id
  on conflict do nothing;

  v_avail := public.member_balance(v_night.season_id, v_member)
             + v_night.attendance_bonus;                     -- bonus FIRST
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

-- Report rebuy + final stack, as TYPED TOTALS. Self, or proxy if admin
-- (reported_via records which). Idempotent upsert: replaying the same payload
-- is a no-op, which is what makes the phone's retry queue safe on flaky wifi.
-- The rebuy is clamped to the cap booked at check-in (never an error: the
-- clamp means a retried report can't fail after an admin lowered a cap).
-- The one-rebuy rule is structural: there is one rebuy_chips per entry.
-- "Holding more than stack_size chips means no rebuy" is a table rule the
-- client warns about; the server cannot see chip stacks mid-game.
create or replace function public.report_entry(
  p_night_id uuid,
  p_final_stack integer,
  p_rebuy_chips integer default 0,
  p_member_id uuid default null,
  p_note text default null
) returns public.entries
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self uuid := public.current_member_id();
  v_member uuid; v_night public.nights; v_row public.entries; v_via text;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_final_stack is null or p_final_stack < 0 then
    raise exception 'final stack must be zero or more';
  end if;
  v_member := coalesce(p_member_id, v_self);
  if v_member <> v_self and not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  v_via := case when v_member = v_self then 'self' else 'admin' end;

  select * into strict v_night from public.nights where id = p_night_id;
  if v_night.status = 'settled' and not public.is_admin() then
    raise exception 'night_settled' using errcode = 'P0003';
  end if;
  if v_night.status not in ('open','reconciling') and not public.is_admin() then
    raise exception 'night is not open' using errcode = 'P0001';
  end if;

  -- Implicit check-in, idempotent, WITHOUT a code: for a member who already
  -- checked in (report.html forces check-in first) this is a no-op touch;
  -- for an admin proxy report it creates the entry. A member who never
  -- checked in gets check_in's P0010 ("code required") -- reporting cannot
  -- be used to slip past the night-code gate.
  perform public.check_in(p_night_id, null::text, v_member);

  update public.entries set
    rebuy_chips  = least(greatest(coalesce(p_rebuy_chips, 0), 0), rebuy_cap_chips),
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

-- Open a night for check-in and reporting. Also the correction path: reopen a
-- settled night, fix entries via report_entry, settle again. Reopening a
-- settled night recomputes at once so the leaderboard never shows a night
-- that is back under revision.
create or replace function public.open_night(p_night_id uuid)
returns public.nights language plpgsql security definer
set search_path = public, pg_temp as $$
declare n public.nights; v_old public.night_status;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select status into strict v_old from public.nights where id = p_night_id;
  if v_old = 'void' then raise exception 'night is void'; end if;
  update public.nights set status = 'open', opened_at = coalesce(opened_at, now())
   where id = p_night_id returning * into n;
  if v_old = 'settled' then
    perform public.recompute_season(n.season_id);
  end if;
  return n;
end $$;

-- Close reporting: the "chase the not-reported list" phase.
create or replace function public.close_reporting(p_night_id uuid)
returns public.nights language plpgsql security definer
set search_path = public, pg_temp as $$
declare n public.nights;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.nights set status = 'reconciling', closed_at = now()
   where id = p_night_id and status = 'open' returning * into n;
  if n.id is null then raise exception 'night not found or not open'; end if;
  return n;
end $$;

-- Settle. Deliberately does NOT look at chip_balance: an imbalance must never
-- block the leaderboard. Unreported entries score as a zero final stack and
-- are counted in nights.unreported_count for later correction.
create or replace function public.settle_night(p_night_id uuid)
returns public.nights language plpgsql security definer
set search_path = public, pg_temp as $$
declare n public.nights;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.nights
     set status = 'settled', settled_at = coalesce(settled_at, now()),
         settled_by = public.current_member_id(), revision = revision + 1
   where id = p_night_id and status <> 'void'
  returning * into n;
  if n.id is null then raise exception 'night not found or void'; end if;
  perform public.recompute_season(n.season_id);
  select * into n from public.nights where id = p_night_id;
  return n;
end $$;

-- Record an admin correction / imbalance note, visibly and with a reason.
-- member_id NULL = night-level note, delta must be 0 (documentation only).
-- Takes effect at the night's position in season order; if the night is
-- already settled the season recomputes immediately.
create or replace function public.add_adjustment(
  p_night_id uuid,
  p_member_id uuid,
  p_delta_points integer,
  p_kind text,
  p_reason text
) returns public.adjustments
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_night public.nights; v_row public.adjustments;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required';
  end if;
  select * into strict v_night from public.nights where id = p_night_id;
  if p_member_id is null and coalesce(p_delta_points, 0) <> 0 then
    raise exception 'a night-level note carries no points; name a member for a points delta';
  end if;
  if p_member_id is not null and not exists (
       select 1 from public.season_enrollments
        where season_id = v_night.season_id and member_id = p_member_id) then
    raise exception 'member is not enrolled in this season';
  end if;

  insert into public.adjustments
    (night_id, season_id, member_id, delta_points, kind, reason, created_by)
  values
    (p_night_id, v_night.season_id, p_member_id, coalesce(p_delta_points, 0),
     p_kind, p_reason, public.current_member_id())
  returning * into v_row;

  if v_night.status = 'settled' then
    perform public.recompute_season(v_night.season_id);
  end if;
  return v_row;
end $$;

-- Create next week's night without SQL-editor access (Fridays all semester).
-- night_no is assigned automatically; the new night starts as 'draft'.
create or replace function public.create_night(
  p_season_id uuid,
  p_played_on date,
  p_title text default null,
  p_kind public.night_kind default 'tournament',
  p_stack_size integer default null,
  p_attendance_bonus integer default null,
  p_counts_as_round boolean default true
) returns public.nights
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_row public.nights; v_no smallint;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select coalesce(max(night_no), 0) + 1 into v_no
    from public.nights where season_id = p_season_id;
  insert into public.nights
    (season_id, night_no, played_on, title, kind, counts_as_round,
     stack_size, attendance_bonus)
  values
    (p_season_id, v_no, p_played_on, nullif(btrim(coalesce(p_title,'')), ''), p_kind,
     p_counts_as_round, coalesce(p_stack_size, 10000), coalesce(p_attendance_bonus, 5000))
  returning * into v_row;
  return v_row;
end $$;

-- The ONE read path for a night's attendance code: admins only, for the TV
-- takeover on admin.html (QR + giant code). DECISION, on the record: plain
-- authenticated members can NOT read the code of the open night -- not here,
-- not via the nights column grant (section 8), not via any view. They do
-- not need to: the code reaches them through the room (TV screen / QR), and
-- letting the API hand it out would reduce the check-in gate to a no-op for
-- anyone checking in from home. report.html therefore never reads the code;
-- it only submits what the member typed (or the QR pre-filled) to check_in().
create or replace function public.get_night_code(p_night_id uuid)
returns text language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare v_code text;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select code into strict v_code from public.nights where id = p_night_id;
  return v_code;
end $$;


-- ============================================================================
-- 10. FUNCTION EXECUTE LOCKDOWN + GRANTS
-- Belt and braces: strip EXECUTE from everything created above (PUBLIC gets
-- it by default), then grant back exactly the client-callable surface.
-- anon can call NOTHING. Admin RPCs self-check with is_admin().
-- member_balance(), norm_pseudonym(), gen_night_code() and trg_nights_code()
-- stay internal: no grant at all (the trigger and the SECURITY DEFINER RPCs
-- run them in owner context, which needs no grant).
-- ============================================================================

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.claim_pseudonym(text)                to authenticated;
grant execute on function public.check_in(uuid, text, uuid)           to authenticated;
grant execute on function public.report_entry(uuid, integer, integer, uuid, text)
                                                                      to authenticated;
grant execute on function public.get_night_code(uuid)                 to authenticated;
grant execute on function public.open_night(uuid)                     to authenticated;
grant execute on function public.close_reporting(uuid)                to authenticated;
grant execute on function public.settle_night(uuid)                   to authenticated;
grant execute on function public.recompute_season(uuid)               to authenticated;
grant execute on function public.add_adjustment(uuid, uuid, integer, text, text)
                                                                      to authenticated;
grant execute on function public.create_night(uuid, date, text, public.night_kind,
                                              integer, integer, boolean)
                                                                      to authenticated;
-- Needed by the RLS policies (which run as the querying role) and by the UI
-- to decide whether to show admin controls:
grant execute on function public.is_admin()                           to authenticated;
grant execute on function public.current_member_id()                  to authenticated;


-- ============================================================================
-- 11. SEED
-- ============================================================================

-- Season: everyone starts at 40,000 points. Points only -- no money, ever.
insert into public.seasons (slug, name, starts_on, starting_points, is_current)
values ('fall-2026', 'Fall 2026', date '2026-08-28', 40000, true);

-- Night 0: the 28 August Welcome Round, already played. Attendance was
-- publicly promised 5,000 points, so it must be in the season before Friday.
-- Admins enter attendees retroactively (check_in + report_entry with final
-- stack 0), then settle. stack_size 0 = no chips, bonus only.
insert into public.nights
  (season_id, night_no, played_on, title, kind, status, counts_as_round,
   stack_size, attendance_bonus)
select id, 0, date '2026-08-28', 'Welcome Round', 'welcome', 'draft', false, 0, 5000
  from public.seasons where slug = 'fall-2026';

-- Night 1: the first tournament night, Friday 4 September 2026 (18:00,
-- Blindern Campus, Nils Henrik Abels Hus, Abelstua -- times and places live
-- in site copy / data/events.json, not in the database).
insert into public.nights
  (season_id, night_no, played_on, title, kind, status, counts_as_round,
   stack_size, attendance_bonus)
select id, 1, date '2026-09-04', 'Round 1', 'tournament', 'draft', true, 10000, 5000
  from public.seasons where slug = 'fall-2026';

-- Roster seed: pseudonym ONLY. No real names are imported, ever.
-- Skip the 7 legacy rows whose pseudonym is literally 'DEFAULT'; dedupe
-- the one pair that collides on the normalised key. 96 rows survive.
-- Loaded by an admin from a local CSV via the Table Editor (service role);
-- the CSV is never committed to git. Shape:
--   insert into public.members (pseudonym) values ('...'), ('...');

-- Admin bootstrap (run BY HAND in the SQL editor after both admins have
-- signed in once and claimed their pseudonyms -- there is deliberately no
-- other way to become an admin):
--   insert into public.admins (member_id)
--   select id from public.members where pseudonym in ('AdminOne', 'AdminTwo');
