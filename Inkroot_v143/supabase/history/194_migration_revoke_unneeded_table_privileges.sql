-- F14: client roles never need TRUNCATE / REFERENCES / TRIGGER. SELECT/INSERT/UPDATE/DELETE (gated by RLS) are untouched.
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
-- Keep new tables from getting them back.
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;
