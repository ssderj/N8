-- 216 (APPLIED live 5 Oct 2026): guild treasury idempotency keys must belong to the guild being acted on.
--
-- Problem: propose_guild_treasury_spend() and spend_from_guild_treasury() looked up an existing row by
-- idempotency_key BEFORE checking the caller's role, and with no guild_id match. A signed-in user who
-- supplied another guild's key got that guild's spend request / treasury transaction row back. Keys are
-- client-generated random strings, so this is hard to exploit, but the lookup should never cross guilds.
--
-- Change (nothing else is touched; signatures, grants, limits and messages are unchanged):
--   1. Every idempotency lookup also requires guild_id = p_guild_id.
--   2. A replayed request still returns the original row, but only after the caller passes the
--      treasury-authorized check.
--   3. If the key is already used by a DIFFERENT guild, the call raises 'That idempotency key is already
--      in use.' instead of returning that row (this also covers the post-insert conflict fallback).
--
-- Rollback: re-run the function definitions from migrations 157/158 (previous versions).
-- After applying: mirror both functions into supabase/schema.sql so a fresh install matches.

create or replace function public.propose_guild_treasury_spend(
  p_guild_id uuid, p_amount_kobo bigint, p_title text, p_idempotency_key text default null::text)
 returns guild_treasury_spend_requests
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row guild_treasury_spend_requests;
begin
  if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
    raise exception 'Founder Guilds do not have a treasury — there is nothing to spend here.';
  end if;

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_spend_requests
    where idempotency_key = p_idempotency_key and guild_id = p_guild_id;
    if found then
      if not is_guild_treasury_authorized(p_guild_id) then
        raise exception 'Only the guild leader, treasurer, or an officer can propose a treasury spend.';
      end if;
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'A spend request needs a title.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can propose a treasury spend.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_spend_requests
    where idempotency_key = p_idempotency_key and guild_id = p_guild_id;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo < guild_treasury_multi_approval_threshold_kobo()
     and guild_treasury_direct_spent_24h_kobo(p_guild_id) + p_amount_kobo <= guild_treasury_direct_spend_cap_kobo() then
    raise exception 'Amounts under the multi-approval threshold can be authorized directly with spend_from_guild_treasury.';
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'spend_from_guild_treasury');

  if guild_treasury_available_kobo(p_guild_id) - guild_treasury_reserved_by_other_requests_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance once pending proposals are accounted for.';
  end if;

  insert into guild_treasury_spend_requests (guild_id, amount_kobo, title, requested_by, idempotency_key)
  values (p_guild_id, p_amount_kobo, trim(p_title), auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_spend_requests
    where idempotency_key = p_idempotency_key and guild_id = p_guild_id;
    if not found then
      raise exception 'That idempotency key is already in use.';
    end if;
    return v_row;
  end if;

  insert into guild_treasury_spend_approvals (request_id, approver_id) values (v_row.id, auth.uid());
  return v_row;
end;
$function$;

create or replace function public.spend_from_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_title text, p_idempotency_key text default null::text,
  p_project_event_id uuid default null::uuid)
 returns guild_treasury_transactions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row guild_treasury_transactions;
  v_cap bigint;
begin
  if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
    raise exception 'Founder Guilds do not have a treasury — there is nothing to spend here.';
  end if;

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions
    where idempotency_key = p_idempotency_key and guild_id = p_guild_id;
    if found then
      if not is_guild_treasury_authorized(p_guild_id) then
        raise exception 'Only the guild leader, treasurer, or an officer can authorize a treasury spend.';
      end if;
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can authorize a treasury spend.';
  end if;
  if p_amount_kobo >= guild_treasury_multi_approval_threshold_kobo() then
    raise exception 'Withdrawals of this size require multiple approvals — use propose_guild_treasury_spend instead.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions
    where idempotency_key = p_idempotency_key and guild_id = p_guild_id;
    if found then
      return v_row;
    end if;
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'spend_from_guild_treasury');

  v_cap := guild_treasury_direct_spend_cap_kobo();
  if guild_treasury_direct_spent_24h_kobo(p_guild_id) + p_amount_kobo > v_cap then
    raise exception 'This guild has reached its direct-spend limit of ₦% for a rolling 24 hours. Propose the spend for multi-approval, or try again later.',
      to_char(v_cap / 100, 'FM999,999,999');
  end if;

  if guild_treasury_available_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'debit', 'spend', p_amount_kobo, 'NGN', 'guild_treasury',
     'external', p_project_event_id, 'success', p_title, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions
    where idempotency_key = p_idempotency_key and guild_id = p_guild_id;
    if not found then
      raise exception 'That idempotency key is already in use.';
    end if;
  end if;
  return v_row;
end;
$function$;
