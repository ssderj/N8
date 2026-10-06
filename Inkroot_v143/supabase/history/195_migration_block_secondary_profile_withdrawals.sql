-- F6: a linked secondary profile must not withdraw. author_balance_kobo() credits a secondary's sales to
-- its MAIN account (migration 164) but does not remove them from the secondary's own balance, so both
-- accounts could withdraw the same earnings. Withdrawals are made from the main account only.
-- Body below is the live function with one added guard (after input validation, before any lookup).
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

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status, method, idempotency_key)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending', 'manual', v_key)
  returning * into v_row;
  return v_row;
end;
$function$;
