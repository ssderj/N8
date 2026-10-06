-- 210: audit #9 (last gap), kv_store sync. *** APPLIED LIVE 4 Oct 2026. *** (File was renamed from "210_STAGED_NOT_APPLIED_audit_9_kv_store_new_key_cap.sql" once applied; the SQL below is unchanged.)
-- Why a cap on NEW keys and not a per-hour rate limit: the app autosaves into existing kv_store rows all
-- the time, so limiting writes would throw errors at real writers mid-session. Only brand-new keys are
-- counted here; updating an existing row (every autosave) never touches this trigger's limit.
-- Limit: 300 keys per user. Live today: the busiest user has 38.
-- Not covered: total size. Each row is already capped at 20 MB; this bounds the worst case at roughly
-- 6 GB per user instead of unlimited. A total-size cap is a separate decision.
-- Server-side writes (service role, SQL editor) have no auth.uid() and are skipped.
create or replace function public.enforce_kv_store_key_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max constant int := 300;
  v_count int;
begin
  if auth.uid() is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('kv_key_cap:' || new.user_id::text));
  select count(*) into v_count from public.kv_store where user_id = new.user_id;
  if v_count >= v_max then
    raise exception 'You have reached the limit of saved items for this account.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_kv_store_key_cap() from public, anon, authenticated;

drop trigger if exists kv_store_key_cap_trg on public.kv_store;
create trigger kv_store_key_cap_trg before insert on public.kv_store
  for each row execute function public.enforce_kv_store_key_cap();
-- Caveat: an upsert fires BEFORE INSERT even when it ends up updating, so a user already AT 300 keys
-- would see an error on autosave of an existing key. Fine at today's numbers (max 38); raise v_max if
-- real users ever approach it.
