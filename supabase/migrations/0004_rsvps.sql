-- 0004: RSVP for upcoming nights.
--
-- The privacy split is deliberate and load bearing: the PUBLIC sees a count,
-- SIGNED-IN MEMBERS see pseudonyms. A public list of who will be in a named
-- room at a stated time discloses more than the leaderboard does. Aggregate is
-- fine, identities are not. Do not widen v_night_rsvps to anon.
--
-- Applied to production as: rsvps

create table public.rsvps (
  night_id     uuid not null,
  season_id    uuid not null,
  member_id    uuid not null references public.members(id) on delete cascade,
  response     text not null check (response in ('going','not_going')),
  responded_at timestamptz not null default now(),
  primary key (night_id, member_id),
  foreign key (night_id, season_id) references public.nights(id, season_id) on delete cascade
);
create index rsvps_night_idx on public.rsvps (night_id);
comment on table public.rsvps is
  'Intent to attend. Never gates check-in: you can turn up without an RSVP, and an RSVP is not attendance.';

alter table public.rsvps enable row level security;

-- Members read RSVPs (that is the point: seeing who is coming). Writes go
-- through set_rsvp() only, so nobody can answer on somebody else's behalf.
create policy rsvps_read on public.rsvps for select to authenticated using (true);
grant select on public.rsvps to authenticated;

-- Upcoming nights must be visible to members before they are opened, or there
-- is nothing to RSVP to: nights are created as drafts and only opened on the
-- night itself. The code column is excluded from the column grant, so a draft
-- night being readable leaks nothing.
drop policy nights_read on public.nights;
create policy nights_read on public.nights for select to authenticated
  using (status <> 'draft' or played_on >= current_date or public.is_admin());

-- Set or clear your own RSVP. p_response null clears it.
create or replace function public.set_rsvp(p_night_id uuid, p_response text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_self uuid := public.current_member_id(); v_night public.nights;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into strict v_night from public.nights where id = p_night_id;

  if v_night.status in ('settled','void') then
    raise exception 'that night is finished' using errcode = 'P0020';
  end if;

  if p_response is null then
    delete from public.rsvps where night_id = p_night_id and member_id = v_self;
    return null;
  end if;
  if p_response not in ('going','not_going') then
    raise exception 'response must be going or not_going';
  end if;

  insert into public.rsvps (night_id, season_id, member_id, response, responded_at)
  values (p_night_id, v_night.season_id, v_self, p_response, now())
  on conflict (night_id, member_id)
    do update set response = excluded.response, responded_at = now();
  return p_response;
end $$;
revoke all on function public.set_rsvp(uuid, text) from public, anon, authenticated;
grant execute on function public.set_rsvp(uuid, text) to authenticated;

-- Who is coming, by pseudonym. AUTHENTICATED ONLY, never anon.
create or replace view public.v_night_rsvps as
  select r.night_id, m.pseudonym, r.response, r.responded_at
    from public.rsvps r
    join public.members m on m.id = r.member_id
   where m.pseudonym is not null;
grant select on public.v_night_rsvps to authenticated;

-- Upcoming nights with a headcount. Anon-safe: aggregate only, no pseudonyms,
-- and the attendance code is never selected.
-- NOTE: recreated in 0006 to add reports_close_at.
create or replace view public.v_upcoming_nights as
  select n.id as night_id, n.season_id, n.played_on, n.title, n.kind,
         n.status, n.counts_as_round, n.affects_points,
         n.stack_size, n.attendance_bonus,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'going')     as going_count,
         (select count(*) from public.rsvps r
           where r.night_id = n.id and r.response = 'not_going') as not_going_count
    from public.nights n
   where n.status not in ('settled','void')
     and n.played_on >= current_date;
grant select on public.v_upcoming_nights to anon, authenticated;
