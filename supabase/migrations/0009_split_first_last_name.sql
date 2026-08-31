-- 0009: the name is asked for on its own step, as two fields.
--
-- A member typed their PSEUDONYM into the "Full name" box at signup. The two
-- boxes sat next to each other and both asked for a name, so the form was the
-- thing at fault. The fix: the name is collected on a step of its own, AFTER
-- the pseudonym is claimed, as "First name" and "Last name". The database
-- stores the two parts and refuses the mistake outright.
--
-- Error codes raised here:
--   P0041  a name field was left blank (both are required)
--   P0040  the name given is the member's own pseudonym
-- js/sb.js friendlyError maps both to member-facing copy.
--
-- Applied to production as: split_first_last_name

alter table public.member_private add column if not exists first_name text;
alter table public.member_private add column if not exists last_name  text;

comment on column public.member_private.first_name is
  'Given name, from the member''s own name step. Null for names an admin typed in as one string.';
comment on column public.member_private.last_name is
  'Family name, from the member''s own name step. Null for names an admin typed in as one string.';
comment on column public.member_private.real_name is
  'The full name, always populated: "First Last" when the member gave the two parts, otherwise the single string an admin recorded.';

-- The old single-argument version is dropped, not left beside the new one.
-- Two functions with the same name would let a stale call site keep writing a
-- pseudonym into the name field, which is the bug this migration exists to end.
drop function if exists public.set_my_name(text);

-- The member's own name. Both parts required, and neither may be their
-- pseudonym. Returns the composed full name so the client can show it back.
create or replace function public.set_my_name(p_first_name text, p_last_name text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_self  uuid := public.current_member_id();
  v_first text;
  v_last  text;
  v_full  text;
  v_key   text;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;

  v_first := nullif(btrim(coalesce(p_first_name, '')), '');
  v_last  := nullif(btrim(coalesce(p_last_name,  '')), '');
  if v_first is null or v_last is null then
    raise exception 'we need both a first and a last name' using errcode = 'P0041';
  end if;
  if char_length(v_first) > 40 or char_length(v_last) > 40 then
    raise exception 'name is too long';
  end if;

  v_full := v_first || ' ' || v_last;

  -- The slip this whole change is about: the pseudonym typed into a name box.
  -- Checked against the composed name AND each field on its own, because
  -- "Kingpin Kingpin" and "Kingpin Berg" are the same mistake.
  select pseudonym_key into v_key from public.members where id = v_self;
  if v_key is not null and v_key <> '' and (
       public.norm_pseudonym(v_full)  = v_key or
       public.norm_pseudonym(v_first) = v_key or
       public.norm_pseudonym(v_last)  = v_key
     ) then
    raise exception 'that is your pseudonym, not your name' using errcode = 'P0040';
  end if;

  insert into public.member_private (member_id, real_name, first_name, last_name)
  values (v_self, v_full, v_first, v_last)
  on conflict (member_id) do update
    set real_name   = excluded.real_name,
        first_name  = excluded.first_name,
        last_name   = excluded.last_name,
        updated_at  = now();
  return v_full;
end $$;
revoke all on function public.set_my_name(text, text) from public, anon, authenticated;
grant execute on function public.set_my_name(text, text) to authenticated;

-- Admins record or correct a name as one string (door signups on paper, a
-- member who asked for a fix). Same shape as before. It clears first_name and
-- last_name: a hand-entered name supersedes a split, and leaving the old parts
-- behind would show the corrected name next to the wrong halves.
create or replace function public.admin_set_member_details(
  p_member_id uuid,
  p_real_name text,
  p_email text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text;
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if not exists (select 1 from public.members where id = p_member_id) then
    raise exception 'no such member';
  end if;
  v_name := nullif(btrim(coalesce(p_real_name, '')), '');
  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'name is too long';
  end if;
  insert into public.member_private (member_id, real_name, email, first_name, last_name)
  values (p_member_id, v_name, nullif(btrim(coalesce(p_email, '')), ''), null, null)
  on conflict (member_id) do update
    set real_name   = excluded.real_name,
        email       = coalesce(excluded.email, public.member_private.email),
        first_name  = null,
        last_name   = null,
        updated_at  = now();
end $$;
revoke all on function public.admin_set_member_details(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_member_details(uuid, text, text) to authenticated;

-- The directory, recreated rather than replaced: the column list changes, and
-- create or replace view cannot reorder or insert columns.
--
-- name_looks_like_pseudonym flags the rows stored before the split step
-- existed, where the "name" is really the pseudonym again. Organisers see the
-- flag and can fix those with admin_set_member_details.
drop view if exists public.v_member_directory;
create view public.v_member_directory as
  select m.id as member_id,
         m.pseudonym,
         mp.real_name,
         mp.first_name,
         mp.last_name,
         coalesce(
           m.pseudonym_key is not null and m.pseudonym_key <> '' and (
             public.norm_pseudonym(mp.real_name)  = m.pseudonym_key or
             public.norm_pseudonym(mp.first_name) = m.pseudonym_key or
             public.norm_pseudonym(mp.last_name)  = m.pseudonym_key
           ), false)             as name_looks_like_pseudonym,
         mp.email,
         m.joined_on,
         m.is_active,
         (m.auth_user_id is not null)  as claimed,
         (a.member_id is not null)     as is_admin,
         coalesce(a.is_super, false)   as is_super
    from public.members m
    left join public.member_private mp on mp.member_id = m.id
    left join public.admins a on a.member_id = m.id
   where public.is_admin();
grant select on public.v_member_directory to authenticated;
