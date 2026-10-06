# F19 checklist — run on a Supabase BRANCH first (migration 202 was never executed)
Use a signed-in test member of a Player Guild (RLS applies; the SQL editor bypasses nothing here but has no auth.uid()).
1. Apply 202. `select created_at from guild_member_stats limit 3;` is populated; existing numbers are unchanged.
2. Normal sync still works: write quests_completed=3, quest_guild_xp=13500 in one upsert -> stored as written.
3. Loop: in 50 consecutive upserts set quest_guild_xp = 100000 -> the stored value stops at 22,500 (plus a few hundred at most from elapsed minutes), never reaches 100,000.
4. Same for fireside_post_count = 200000 -> stops near 500; writing_day_count = 20000 -> stops near 365.
5. Time passes: `update guild_member_stats set created_at = now() - interval '10 days' where ...` (as postgres) then upsert quest_guild_xp = 100000 -> stored becomes 22,500 + 4,500x10 = 67,500.
6. Backdating: upsert with created_at = '2000-01-01' in the payload -> created_at is unchanged on update, and is now() on a fresh insert.
7. Leave and rejoin the guild -> the row is recreated at zero, with a new created_at.
8. Never decreases: write a lower value -> stored value stays.
9. Repeat 2-3 on a Founder Guild (founder_guild_member_stats).
