-- 205: audit #20 — "Delete my account" only partly deleted. APPLIED to the live project on 2026-10-03; the
-- purge was tested on fake accounts inside a rolled-back transaction (normal user, moderation-banned user,
-- bank account with and without withdrawal history, queued storage file).
--
-- Also fixes a latent bug: the old purge ran `delete from storage.objects`, which Supabase blocks (trigger
-- protect_objects_delete) unless storage.allow_delete_query is set, so the first real purge would have failed and
-- rolled back for EVERY pending user. Files are now queued and removed through the Storage API by the
-- purge-storage-queue Edge Function (deploy it, otherwise files stay queued).
--
-- Per user whose 30 days are up (each user in its own sub-transaction):
--  * profile: name, pen name, avatar, motto cleared (ban flags/reasons kept)
--  * deleted: synced data, guild memberships, follows, notifications
--  * bank accounts: deleted if never used for a withdrawal; otherwise kept for accounting but scrubbed
--  * files: queued in storage_deletion_queue
--  * login: banned and signed out; email, phone, identities and metadata wiped unless banned by moderation
--  * NOT touched (documented retention): published books, reviews, posts (show as "A writer"), payment and
--    withdrawal records, device signals (fraud prevention). The Paystack transfer recipient is not removed.
create table if not exists public.storage_deletion_queue (
  bucket_id text not null,
  name text not null,
  user_id uuid,
  queued_at timestamptz not null default now(),
  primary key (bucket_id, name)
);
alter table public.storage_deletion_queue enable row level security;
revoke all on public.storage_deletion_queue from anon, authenticated;

create or replace function public.purge_expired_account_deletions()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  rec record;
begin
  for rec in
    select user_id from account_deletions
    where status = 'pending' and scheduled_purge_at <= now()
  loop
    begin
      update profiles
      set pen_name = null, display_name = null, avatar_url = null, motto = null, updated_at = now()
      where id = rec.user_id;

      delete from kv_store where user_id = rec.user_id;
      delete from founder_guild_members where user_id = rec.user_id;
      delete from player_guild_members where user_id = rec.user_id;
      delete from follows where follower_id = rec.user_id or followee_id = rec.user_id;

      delete from bank_accounts b
      where b.user_id = rec.user_id
        and not exists (select 1 from withdrawals w where w.bank_account_id = b.id);
      update bank_accounts
      set bank_code = bank_code || ':' || left(id::text, 8),
          account_number = '000000' || right(account_number, 4),
          account_name = 'Deleted account',
          paystack_recipient_code = 'deleted:' || id::text,
          is_default = false
      where user_id = rec.user_id;

      delete from notifications where recipient_id = rec.user_id;

      insert into storage_deletion_queue (bucket_id, name, user_id)
      select o.bucket_id, o.name, rec.user_id
      from storage.objects o
      where o.bucket_id in ('media', 'media-private')
        and (storage.foldername(o.name))[2] = rec.user_id::text
      on conflict do nothing;

      update auth.users set banned_until = 'infinity' where id = rec.user_id;
      delete from auth.sessions where user_id = rec.user_id;
      delete from auth.refresh_tokens where user_id = rec.user_id::text;
      if not exists (
        select 1 from profiles where id = rec.user_id and (coalesce(banned, false) or coalesce(login_banned, false))
      ) then
        delete from auth.identities where user_id = rec.user_id;
        update auth.users
        set email = 'deleted-' || id::text || '@deleted.invalid',
            phone = null,
            raw_user_meta_data = '{}'::jsonb
        where id = rec.user_id;
      end if;

      update account_deletions set status = 'completed', updated_at = now() where user_id = rec.user_id;
    exception when others then
      raise warning 'purge_expired_account_deletions: user % failed: %', rec.user_id, sqlerrm;
    end;
  end loop;
end;
$function$;
