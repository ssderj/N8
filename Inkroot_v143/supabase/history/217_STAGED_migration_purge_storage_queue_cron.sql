-- 217 (STAGED, not applied): daily schedule for the purge-storage-queue Edge Function.
-- purge_expired_account_deletions() runs at 03:00 and queues the deleted accounts' files; this calls
-- purge-storage-queue at 03:30 to remove them through the Storage API (100 files per call, so a large
-- backlog drains over several days; raise the frequency later if the queue grows).
-- Same pattern as 199 (reconcile). Safe to re-run: cron.schedule with an existing name replaces it.
--
-- BEFORE running this, do these once (the job is skipped with a NOTICE if a secret is missing):
--   1. Supabase, Edge Functions, Secrets: PURGE_STORAGE_SECRET = <long random string>
--   2. Deploy purge-storage-queue with --no-verify-jwt (the deploy-remaining workflow does this)
--   3. In the SQL editor (only the project-url secret is shared with the reconcile job):
--        select vault.create_secret('https://<project-ref>.supabase.co', 'inkroot_project_url');  -- skip if already created for 199
--        select vault.create_secret('<the same random string as PURGE_STORAGE_SECRET>', 'purge_storage_secret');
-- Never paste the secret into chat or a repo file.

create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'inkroot_project_url')
     and exists (select 1 from vault.decrypted_secrets where name = 'purge_storage_secret') then
    perform cron.schedule('purge-storage-queue', '30 3 * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'inkroot_project_url')
               || '/functions/v1/purge-storage-queue',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-purge-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'purge_storage_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000);
    $job$);
  else
    raise notice 'purge-storage-queue NOT scheduled: create the Vault secrets inkroot_project_url and purge_storage_secret, then re-run this file.';
  end if;
end $$;
