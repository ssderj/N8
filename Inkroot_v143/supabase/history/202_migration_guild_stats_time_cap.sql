-- 202_migration_guild_stats_time_cap.sql
-- F19: guard_guild_member_stats_delta() capped how much ONE write could add, but nothing limited how
-- many writes a member could make, so a script could loop up to the table ceilings (100,000 quest XP,
-- 200,000 fireside posts, 20,000 writing days). These totals feed Guild Level and "Guilds on the Rise".
--
-- Fix: a cumulative, time-based cap. Each stats row records when it was created. A stat can never
-- exceed   starting allowance + daily rate x days since the row was created.   Looping writes gains
-- nothing, because only the passage of time raises the cap:
--
--   stat                 starting allowance   per day
--   published_count             50               30
--   quests_completed            10                1
--   quest_guild_xp          22,500            4,500
--   writing_day_count          365                1
--   fireside_post_count        500              300
--
-- The starting allowances match or exceed the old first-write caps, so a member joining with real
-- progress is not penalised. The old per-write caps and the "never decreases" clamp are kept.
-- Existing rows get created_at = now() when this runs (harmless: values already stored are never
-- lowered). created_at is forced to now() on insert and made immutable on update, so a client cannot
-- backdate it. Leaving and rejoining deletes and recreates the row, so it restarts from zero with the
-- starting allowance and gains nothing. To change a number, edit it in the function below.
-- Both stats tables share this one function. Safe to re-run.

alter table guild_member_stats
  add column if not exists created_at timestamptz not null default now();
alter table founder_guild_member_stats
  add column if not exists created_at timestamptz not null default now();

create or replace function guard_guild_member_stats_delta()
returns trigger
language plpgsql
as $$
declare
  old_published integer := 0;
  old_quests integer := 0;
  old_xp integer := 0;
  old_writing_days integer := 0;
  old_fireside integer := 0;
  v_days numeric := 0;
begin
  if tg_op = 'UPDATE' then
    old_published := old.published_count;
    old_quests := old.quests_completed;
    old_xp := old.quest_guild_xp;
    old_writing_days := old.writing_day_count;
    old_fireside := old.fireside_post_count;
    new.created_at := old.created_at;  -- immutable: the time cap's clock cannot be reset or backdated
    v_days := greatest(extract(epoch from (now() - old.created_at)) / 86400.0, 0);
  else
    new.created_at := now();           -- never trust a client-supplied value
  end if;

  -- Each line: never below what is stored, never more than the per-write cap, never more than the
  -- time cap (starting allowance + daily rate x days since this row was created).
  new.published_count := greatest(old_published, least(new.published_count, old_published + 50,
    (50 + floor(30 * v_days))::bigint));
  -- quests_completed: 5 Guild Quests exist today (GUILD_QUEST_DEFS in guild-hall.jsx); 10 leaves
  -- headroom for quests added later without a migration.
  new.quests_completed := greatest(old_quests, least(new.quests_completed, old_quests + 10,
    (10 + floor(1 * v_days))::bigint));
  -- quest_guild_xp: today's 5 quests sum to 22,500 at most.
  new.quest_guild_xp := greatest(old_xp, least(new.quest_guild_xp, old_xp + 22500,
    (22500 + floor(4500 * v_days))::bigint));
  -- writing_day_count: a day counter cannot rise faster than one a day; 365 covers prior local history.
  new.writing_day_count := greatest(old_writing_days, least(new.writing_day_count, old_writing_days + 60,
    (365 + floor(1 * v_days))::bigint));
  -- fireside_post_count: the 'post' rate limit (migration 201) already holds real posting to 40 an hour.
  new.fireside_post_count := greatest(old_fireside, least(new.fireside_post_count, old_fireside + 500,
    (500 + floor(300 * v_days))::bigint));

  return new;
end;
$$;
