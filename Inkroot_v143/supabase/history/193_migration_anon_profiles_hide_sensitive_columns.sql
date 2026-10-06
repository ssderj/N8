-- F5: logged-out visitors must not read ban reasons, login-ban state, referral codes or the
-- founder-guild-treasurer flag. is_moderator / is_platform_admin stay readable for now because ~37 RLS
-- policies evaluate them as the querying role (moving those to helper functions is a later change).
-- Signed-in (authenticated) access is intentionally unchanged.
revoke select on public.profiles from anon;
grant select (id, pen_name, display_name, avatar_url, verified, banned, motto, updated_at, is_moderator, is_platform_admin)
  on public.profiles to anon;
