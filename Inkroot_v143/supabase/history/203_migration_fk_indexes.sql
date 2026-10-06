-- 203_migration_fk_indexes.sql
-- F17: 15 foreign keys had no index (found with a live query on Oct 3, 2026, project cfabvlgpsemixhbedvzt).
-- Two real costs: (1) reads by that column scan the whole table — guild_quiz_questions.anthology_id is how
-- an event's quiz is loaded, and guild_event_tickets.user_id / guild_quiz_attempts.user_id are "my tickets /
-- my attempts"; (2) every foreign key to auth.users makes Postgres scan the referencing table whenever an
-- account is deleted (cascade or set-null), so account deletion gets slower as these tables grow.
-- The tables are tiny today, so each index builds in milliseconds; plain CREATE INDEX is fine (it takes a
-- brief write lock on a tiny table). Additive only, safe to re-run. No behaviour change.
--
-- To re-check afterwards, this should return no rows:
--   select c.conrelid::regclass, c.conname from pg_constraint c
--   where c.contype = 'f' and c.connamespace = 'public'::regnamespace
--     and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid
--                     and (i.indkey::int2[])[0:array_length(c.conkey,1)-1] = c.conkey);

-- Read paths
create index if not exists guild_quiz_questions_anthology_id_idx   on guild_quiz_questions (anthology_id);
create index if not exists guild_event_tickets_user_id_idx         on guild_event_tickets (user_id);
create index if not exists guild_quiz_attempts_user_id_idx         on guild_quiz_attempts (user_id);
create index if not exists guild_events_quiz_anthology_id_idx      on guild_events (quiz_anthology_id);
create index if not exists guild_event_tournaments_anthology_id_idx on guild_event_tournaments (anthology_id);
create index if not exists guild_event_tournament_matches_winner_id_idx on guild_event_tournament_matches (winner_id);

-- Mostly "who did this" columns that only matter when an account or anthology is deleted
create index if not exists guild_event_entries_refunded_by_idx          on guild_event_entries (refunded_by);
create index if not exists guild_event_giveaway_draws_winner_id_idx     on guild_event_giveaway_draws (winner_id);
create index if not exists guild_event_giveaway_ties_chosen_by_idx      on guild_event_giveaway_ties (chosen_by);
create index if not exists guild_event_judging_settings_updated_by_idx  on guild_event_judging_settings (updated_by);
create index if not exists guild_event_tournaments_champion_id_idx      on guild_event_tournaments (champion_id);
create index if not exists guild_event_tournaments_runner_up_id_idx     on guild_event_tournaments (runner_up_id);
create index if not exists guild_event_tournaments_third_id_idx         on guild_event_tournaments (third_id);
create index if not exists guild_quiz_questions_reviewed_by_idx         on guild_quiz_questions (reviewed_by);
create index if not exists linked_profiles_created_by_idx               on linked_profiles (created_by);
