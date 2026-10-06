-- 211: audit #8 leftover. *** APPLIED LIVE 4 Oct 2026. *** (File was renamed from "211_STAGED_NOT_APPLIED_audit_8_admin_ids_signed_in_announcement_authors_only.sql" once applied; the SQL below is unchanged.)
-- get_platform_admin_ids() let ANYONE, even signed out, test whether any account id is a platform admin.
-- Its only caller (the Guild Notice Board, via fetchPlatformAdminIds) asks about authors of Fireside
-- 'announcement' posts and already falls back to "not admin" on any error.
-- New rule: signed-in only, and only answers for ids that have authored an announcement post.
-- Same signature and return type, so no app change is needed and this is independent of 208.
create or replace function public.get_platform_admin_ids(p_user_ids uuid[])
 returns setof uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select p.id from public.profiles p
  where auth.uid() is not null
    and p.is_platform_admin
    and p.id = any (p_user_ids[1:200])
    and exists (
      select 1 from public.fireside_posts f
      where f.author_id = p.id and f.category = 'announcement' and f.parent_id is null
    )
$function$;

revoke execute on function public.get_platform_admin_ids(uuid[]) from public, anon;
grant execute on function public.get_platform_admin_ids(uuid[]) to authenticated;
