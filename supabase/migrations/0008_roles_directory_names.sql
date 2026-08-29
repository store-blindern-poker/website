-- 0008: two-tier roles, the member directory, and full names.
--
-- admin: runs nights. The bank, the organiser console, proxy entries, settling.
-- super admin: additionally grants and revokes admin from the console.
-- Super admin status itself is SQL-editor only, so the ladder has a hard top:
-- no RPC can mint or remove a super admin, and nobody can lock the club out by
-- revoking the last person standing.
--
-- Applied to production as: roles_directory_and_names

alter table public.admins add column if not exists is_super boolean not null default false;
comment on column public.admins.is_super is
  'Super admins manage who is admin. This flag is set only in the SQL editor, never by an RPC.';

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.admins a
    join public.members m on m.id = a.member_id
    where m.auth_user_id = auth.uid() and a.is_super
  );
$$;
revoke all on function public.is_super_admin() from public, anon, authenticated;
grant execute on function public.is_super_admin() to authenticated;

-- Full name, supplied by the member. Stored in member_private, so it is
-- admin-only like the email. Collected for membership records: grant
-- applications are judged on real, countable members.
create or replace function public.set_my_name(p_real_name text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_self uuid := public.current_member_id(); v_name text;
begin
  if v_self is null then raise exception 'not signed in' using errcode = '28000'; end if;
  v_name := nullif(btrim(coalesce(p_real_name, '')), '');
  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'name is too long';
  end if;
  insert into public.member_private (member_id, real_name)
  values (v_self, v_name)
  on conflict (member_id) do update set real_name = excluded.real_name, updated_at = now();
  return v_name;
end $$;
revoke all on function public.set_my_name(text) from public, anon, authenticated;
grant execute on function public.set_my_name(text) to authenticated;

-- The directory. A definer view that gates itself: admins get every member with
-- name, email and role flags; everyone else gets zero rows. This is the ONLY
-- place pseudonym and real name appear side by side, and it exists for the
-- people who already may read member_private.
create or replace view public.v_member_directory as
  select m.id as member_id,
         m.pseudonym,
         mp.real_name,
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

-- Grant admin. Super admins only. The target must have a real account:
-- an unclaimed roster row cannot act, so admin on it would be a dead flag.
create or replace function public.grant_admin(p_member_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_super_admin() then
    raise exception 'super admins only' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.members
     where id = p_member_id and auth_user_id is not null and is_active
  ) then
    raise exception 'that member has not created an account yet';
  end if;
  insert into public.admins (member_id, granted_by)
  values (p_member_id, public.current_member_id())
  on conflict do nothing;
end $$;
revoke all on function public.grant_admin(uuid) from public, anon, authenticated;
grant execute on function public.grant_admin(uuid) to authenticated;

-- Revoke admin. Super admins only, and never against a super admin.
create or replace function public.revoke_admin(p_member_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_super_admin() then
    raise exception 'super admins only' using errcode = '42501';
  end if;
  if exists (select 1 from public.admins where member_id = p_member_id and is_super) then
    raise exception 'super admins are managed in the SQL editor, not here';
  end if;
  delete from public.admins where member_id = p_member_id;
end $$;
revoke all on function public.revoke_admin(uuid) from public, anon, authenticated;
grant execute on function public.revoke_admin(uuid) to authenticated;

-- The two super admins: the CTO (Walrus) and the chair (Will Ivey).
update public.admins a
   set is_super = true
  from public.members m
 where m.id = a.member_id
   and m.pseudonym_key in ('walrus', 'willivey');

-- Admins may record or correct a member's name and email. They can already read
-- both; recording them is the same job (door signups on paper, accounts created
-- before the name field existed).
-- Applied to production as: admin_set_name
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
  insert into public.member_private (member_id, real_name, email)
  values (p_member_id, v_name, nullif(btrim(coalesce(p_email, '')), ''))
  on conflict (member_id) do update
    set real_name = excluded.real_name,
        email     = coalesce(excluded.email, public.member_private.email),
        updated_at = now();
end $$;
revoke all on function public.admin_set_member_details(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_member_details(uuid, text, text) to authenticated;
