-- 206: audit #8, step 1 of 2. APPLIED to the live project on 2026-10-03 (safe with the existing app build).
-- Stops the database itself from depending on profiles.is_moderator / is_platform_admin being publicly readable,
-- and adds private ways to read them. Step 2 (208_STAGED...) removes the public read; apply it only after the app
-- build that uses these functions (v125+) is deployed.
create or replace function public.is_current_moderator()
 returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce((select p.is_moderator from public.profiles p where p.id = auth.uid()), false) $$;

create or replace function public.is_current_platform_admin()
 returns boolean language sql stable security definer set search_path to 'public'
as $$ select coalesce((select p.is_platform_admin from public.profiles p where p.id = auth.uid()), false) $$;

-- Executable by signed-out visitors too, because access rules for the public role call these; they return false.
grant execute on function public.is_current_moderator(), public.is_current_platform_admin() to anon, authenticated;

create or replace function public.get_my_roles()
 returns table(is_moderator boolean, is_platform_admin boolean)
 language sql stable security definer set search_path to 'public'
as $$ select public.is_current_moderator(), public.is_current_platform_admin() $$;

-- Reasons are returned only to the account itself or to a moderator.
create or replace function public.get_account_status(p_user_id uuid)
 returns table(banned boolean, ban_reason text, login_banned boolean, login_ban_reason text, verified boolean)
 language plpgsql stable security definer set search_path to 'public'
as $$
declare see_reasons boolean := (p_user_id is not distinct from auth.uid()) or public.is_current_moderator();
begin
  return query
  select coalesce(p.banned, false),
         case when see_reasons then p.ban_reason end,
         coalesce(p.login_banned, false),
         case when see_reasons then p.login_ban_reason end,
         coalesce(p.verified, false)
  from public.profiles p where p.id = p_user_id;
end $$;

-- Which of these (at most 200) accounts are platform admins — for the Guild Notice Board badge.
create or replace function public.get_platform_admin_ids(p_user_ids uuid[])
 returns setof uuid
 language sql stable security definer set search_path to 'public'
as $$
  select p.id from public.profiles p
  where p.is_platform_admin and p.id = any (p_user_ids[1:200])
$$;

create or replace function public.list_platform_role_holders()
 returns table(id uuid, pen_name text, display_name text, is_moderator boolean, is_platform_admin boolean)
 language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not (public.is_current_moderator() or public.is_current_platform_admin()) then
    raise exception 'Not authorized.';
  end if;
  return query
  select p.id, p.pen_name, p.display_name, p.is_moderator, p.is_platform_admin
  from public.profiles p
  where p.is_moderator or p.is_platform_admin
  order by p.display_name;
end $$;

revoke execute on function public.get_my_roles(), public.get_account_status(uuid), public.list_platform_role_holders() from public, anon;
grant execute on function public.get_my_roles(), public.get_account_status(uuid), public.list_platform_role_holders() to authenticated;
revoke execute on function public.get_platform_admin_ids(uuid[]) from public;
grant execute on function public.get_platform_admin_ids(uuid[]) to anon, authenticated;

-- The one SECURITY INVOKER trigger function that read profiles.is_moderator itself.
do $$
declare
  src text := pg_get_functiondef('public.protect_content_from_moderator_edits'::regproc);
  fixed text;
begin
  fixed := replace(src,
    'select p.is_moderator into acting_is_moderator from profiles p where p.id = auth.uid();',
    'acting_is_moderator := public.is_current_moderator();');
  if fixed = src then raise exception 'protect_content_from_moderator_edits: expected text not found'; end if;
  execute fixed;
end $$;

-- Every access rule that looked the role up with an inline subquery on profiles now calls the helper.
do $$
declare
  r record; new_qual text; new_check text; n int := 0; stmt text;
  pat constant text := '\(EXISTS \( SELECT 1\s+FROM profiles p\s+WHERE \(\(p\.id = auth\.uid\(\)\) AND p\.is_(moderator|platform_admin)\)\)\)';
begin
  for r in select schemaname, tablename, policyname, qual, with_check from pg_policies
           where schemaname = 'public' and (qual ~ pat or with_check ~ pat)
  loop
    new_qual  := regexp_replace(coalesce(r.qual, ''),       pat, '(select public.is_current_\1())', 'g');
    new_check := regexp_replace(coalesce(r.with_check, ''), pat, '(select public.is_current_\1())', 'g');
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.qual is not null       and new_qual  <> r.qual       then stmt := stmt || format(' using (%s)', new_qual); end if;
    if r.with_check is not null and new_check <> r.with_check then stmt := stmt || format(' with check (%s)', new_check); end if;
    execute stmt;
    n := n + 1;
  end loop;
  raise notice 'role-lookup policies rewritten: %', n;
end $$;
