-- 200_migration_earnings_hold.sql
-- F10: a 7-day holding period on SALES AND TIPS (purchases) before they can be withdrawn, so a
-- refund or chargeback arriving after a payout can't leave a negative balance. Decisions: only
-- purchases are held (achievement/referral/guild grants are not); one balance is shown to the writer
-- and the hold appears only in the error message when a request is too large; manual review stays.
--
--   * payout_security_config.earnings_hold_days (default 7; 0 turns the hold off; max 90), editable
--     by platform admins like the existing new_account_cooldown_hours.
--   * earnings_held_kobo(user): the writer's share (author_amount_kobo) of successful purchases paid
--     within the window, for the main account and its linked profiles (same set and same anthology
--     exclusion as author_balance_kobo). Server/admin only.
--   * assert_earnings_hold_clear(user, amount): raises if amount > balance - held.
--   * create_withdrawal_locked and create_manual_withdrawal_locked: the live bodies plus one call to
--     assert_earnings_hold_clear right after the existing balance check. The manual body is
--     migration 195's (it keeps the F6 secondary-profile guard), so 195 is superseded by this file —
--     apply 195 first, then 200.
-- author_balance_kobo() is NOT changed. Safe to re-run.

alter table payout_security_config
  add column if not exists earnings_hold_days integer not null default 7
  check (earnings_hold_days between 0 and 90);

create or replace function earnings_held_kobo(p_user_id uuid)
returns bigint
language plpgsql stable security definer set search_path = public as $$
declare
  v_ids uuid[];
  v_days integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;
  select earnings_hold_days into v_days from payout_security_config;
  v_days := coalesce(v_days, 7);
  if v_days <= 0 then
    return 0;
  end if;
  select array_agg(secondary_id) into v_ids from linked_profiles where main_id = p_user_id;
  v_ids := array_append(coalesce(v_ids, array[]::uuid[]), p_user_id);
  return coalesce((
    select sum(p.author_amount_kobo) from purchases p
    where p.author_id = any(v_ids) and p.status = 'success'
      and coalesce(p.paid_at, p.created_at) > now() - make_interval(days => v_days)
      and not exists (select 1 from guild_anthologies a where a.published_book_id = p.book_id)
  ), 0);
end;
$$;
revoke all on function earnings_held_kobo(uuid) from public, anon, authenticated;

create or replace function assert_earnings_hold_clear(p_user_id uuid, p_amount_kobo bigint)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_held bigint;
  v_free bigint;
  v_days integer;
begin
  v_held := earnings_held_kobo(p_user_id);
  if v_held <= 0 then
    return;
  end if;
  v_free := greatest(author_balance_kobo(p_user_id) - v_held, 0);
  if p_amount_kobo > v_free then
    select earnings_hold_days into v_days from payout_security_config;
    raise exception 'Sales and tips from the last % day% are held for security before they can be withdrawn. You can withdraw up to ₦% right now.',
      v_days, case when v_days = 1 then '' else 's' end, to_char(v_free / 100.0, 'FM999,999,999,990.00');
  end if;
end;
$$;
revoke all on function assert_earnings_hold_clear(uuid, bigint) from public, anon, authenticated;

-- create_withdrawal_locked (Paystack path; not the active method today, kept in step)
create or replace function create_withdrawal_locked(
  p_user_id uuid, p_bank_account_id uuid, p_amount_kobo bigint
)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account_id and user_id = p_user_id) then
    raise exception 'Saved bank account not found.';
  end if;
  perform assert_bank_account_cooldown_elapsed(p_user_id, p_bank_account_id);

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  if author_balance_kobo(p_user_id) < p_amount_kobo then
    raise exception 'Amount is more than your available balance.';
  end if;
  -- F10: same hold as the manual path.
  perform assert_earnings_hold_clear(p_user_id, p_amount_kobo);

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_withdrawal_locked(uuid, uuid, bigint) from public;

-- create_manual_withdrawal_locked (the active path): 195's body + the hold
create or replace function public.create_manual_withdrawal_locked(
  p_user_id uuid, p_bank_account_id uuid, p_amount_kobo bigint, p_idempotency_key text default null)
returns withdrawals
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row withdrawals;
  v_key text := nullif(btrim(p_idempotency_key), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if v_key is not null and char_length(v_key) not between 8 and 64 then
    raise exception 'Invalid request key.';
  end if;
  if exists (select 1 from linked_profiles where secondary_id = p_user_id) then
    raise exception 'Withdrawals are made from your main account.';
  end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account_id and user_id = p_user_id) then
    raise exception 'Saved bank account not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- Replay: same user + same key. Returned before the cooldown/balance checks (see header).
  if v_key is not null then
    select * into v_row from withdrawals where user_id = p_user_id and idempotency_key = v_key;
    if found then
      if v_row.bank_account_id <> p_bank_account_id or v_row.amount_kobo <> p_amount_kobo then
        raise exception 'This request was already used for a different withdrawal — please start again.';
      end if;
      return v_row;
    end if;
  end if;

  perform assert_bank_account_cooldown_elapsed(p_user_id, p_bank_account_id);

  if author_balance_kobo(p_user_id) < p_amount_kobo then
    raise exception 'Amount is more than your available balance.';
  end if;
  -- F10: sales and tips newer than the hold window are part of the balance but not yet withdrawable.
  perform assert_earnings_hold_clear(p_user_id, p_amount_kobo);

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status, method, idempotency_key)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending', 'manual', v_key)
  returning * into v_row;
  return v_row;
end;
$function$;

revoke all on function create_manual_withdrawal_locked(uuid, uuid, bigint, text) from public;
revoke all on function create_manual_withdrawal_locked(uuid, uuid, bigint, text) from anon, authenticated;
