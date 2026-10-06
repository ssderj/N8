-- 199_migration_payment_reconcile_cron.sql
-- F3 (part 2 of 2): every 15 minutes, call the paystack-reconcile Edge Function, which asks Paystack
-- about payments still 'pending' after 5 minutes and applies any that actually succeeded (a missed
-- webhook). Needs pg_cron (already on) and pg_net.
--
-- BEFORE running this, do these once (the job is skipped with a NOTICE if the secrets are missing):
--   1. supabase secrets set RECONCILE_SECRET=<long random string>
--   2. supabase functions deploy paystack-reconcile --no-verify-jwt
--   3. In the SQL editor:
--        select vault.create_secret('https://<project-ref>.supabase.co', 'inkroot_project_url');
--        select vault.create_secret('<the same random string>', 'reconcile_secret');
-- Safe to re-run (cron.schedule with an existing job name replaces it).

create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'inkroot_project_url')
     and exists (select 1 from vault.decrypted_secrets where name = 'reconcile_secret') then
    perform cron.schedule('reconcile-paystack-payments', '*/15 * * * *', $job$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'inkroot_project_url')
               || '/functions/v1/paystack-reconcile',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-reconcile-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reconcile_secret')),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000);
    $job$);
  else
    raise notice 'reconcile-paystack-payments NOT scheduled: create the Vault secrets inkroot_project_url and reconcile_secret, then re-run this file.';
  end if;
end $$;
