-- 208: audit #8, step 2 of 2.  *** APPLIED LIVE 4 Oct 2026. *** (File was renamed from "208_STAGED_NOT_APPLIED_audit_8_hide_ban_reasons_and_role_flags.sql" once applied; the SQL below is unchanged.)
-- (Applied after the app build with the new src/lib/moderation.js (v125+) was deployed and 206 was live.)
-- Applying it earlier breaks the current build's moderator button, ban banner and manage-admins screen
-- (they read these columns directly).
--
-- Effect: signed-in users and signed-out visitors can no longer read profiles.ban_reason, login_ban_reason,
-- is_moderator or is_platform_admin. Everything else on profiles stays readable. Moderators/admins and the
-- account owner get what they need through get_account_status(), get_my_roles(), list_platform_role_holders().
-- Tested on live inside a rolled-back transaction: public profile reads, own-profile update, moderator ban update,
-- all moderator-only and admin-only tables, uploads and the new functions behave correctly with this applied.
--
-- Side effects to know:
--  * `select *` on public.profiles from the app (anon / signed-in) now fails. The app never does this.
--  * A column added to profiles LATER is not readable by the app until you `grant select (new_col) on public.profiles
--    to anon, authenticated;`.
--  * Edge Functions use the service key and are unaffected.
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name not in ('ban_reason', 'login_ban_reason', 'is_moderator', 'is_platform_admin');
  execute 'revoke select on public.profiles from anon, authenticated';
  execute format('grant select (%s) on public.profiles to anon, authenticated', cols);
end $$;
