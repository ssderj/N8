-- 209: audit follow-up. ALREADY APPLIED LIVE on 4 Oct 2026 (kept here so the repo matches the database).
alter function public.guard_guild_member_stats_delta() set search_path = public;

revoke execute on function public.book_has_protected_buyers(text) from public, anon;
revoke execute on function public.pack_has_protected_buyers(text) from public, anon;
grant execute on function public.book_has_protected_buyers(text) to authenticated;
grant execute on function public.pack_has_protected_buyers(text) to authenticated;
