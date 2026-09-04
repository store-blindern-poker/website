-- Nudging the people who have not reported.
--
-- An organiser presses one button and everybody who still owes a number
-- gets an email with their own figures in it. Round 1 proved the need: six
-- players out of thirty-eight walked off without reporting, and chasing
-- them meant naming people in a public Discord channel from memory, which
-- named one person who had already reported an hour earlier.
--
-- Two rules shape this, and the Edge Function in
-- supabase/functions/notify-unreported enforces them:
--   1. The console never sees an email address. It shows pseudonyms and
--      counts; the function does the addressing with the service role.
--      Admin-only should mean the server, not a laptop open on a table in
--      a room of thirty-eight people.
--   2. The recipient list is derived from the night id, server side, every
--      time. Nothing accepts a list of people to email from a client, so a
--      tampered request cannot become a way to mail the whole club.
--
-- Applied to production as 20260904xxxxxx_unreported_reminders.

alter table public.entries add column if not exists reminder_sent_at timestamptz;
comment on column public.entries.reminder_sent_at is
  'When this member was last emailed about not having reported. Used to stop a second press of the button mailing everybody twice.';

-- What the console shows. Deliberately no email column: the button needs a
-- count and a list of pseudonyms, and nothing else.
create or replace function public.unreported_roster(p_night_id uuid)
returns table (
  member_id        uuid,
  pseudonym        text,
  chips_taken      integer,
  points_if_silent integer,
  has_email        boolean,
  reminder_sent_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select e.member_id,
           m.pseudonym,
           (e.buyin_chips + e.rebuy_chips)::integer,
           (0 - (e.buyin_chips + e.rebuy_chips) + n.attendance_bonus)::integer,
           (mp.email is not null and mp.email <> ''),
           e.reminder_sent_at
      from public.entries e
      join public.members m  on m.id = e.member_id
      join public.nights  n  on n.id = e.night_id
      left join public.member_private mp on mp.member_id = m.id
     where e.night_id = p_night_id
       and e.voided_at is null
       and not e.reported
     order by m.pseudonym;
end $$;
revoke all on function public.unreported_roster(uuid) from public, anon, authenticated;
grant execute on function public.unreported_roster(uuid) to authenticated;

-- Called by the Edge Function AFTER a send, with the service role, so the
-- stamp only ever reflects mail that actually left. Deliberately granted to
-- nobody: the service role bypasses grants, and no browser should be able
-- to mark somebody as chased without chasing them.
create or replace function public.mark_reminded(p_night_id uuid, p_member_ids uuid[])
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  update public.entries
     set reminder_sent_at = now()
   where night_id = p_night_id
     and member_id = any(p_member_ids)
     and voided_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.mark_reminded(uuid, uuid[]) from public, anon, authenticated;

grant select (reminder_sent_at) on public.entries to authenticated;
