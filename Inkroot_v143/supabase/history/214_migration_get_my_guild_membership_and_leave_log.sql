-- 214: guild membership comes from the server (fix 2). *** APPLIED LIVE 4 Oct 2026 (version 20261004215835). ***
--  * guild_leave_log      — one row per account: when it last left a guild. Written ONLY by the trigger below, so the
--                           leave cooldown no longer lives only in the device's local record.
--  * get_my_guild_membership() — the caller's own seat(s), returned in the shape the app already uses
--                           (guildType, founderGuildId, founderJoinedDate, playerGuild, joinedGuild, leftAt).
-- Caller's own rows only; no anon access. Founder Guilds also exist as system rows in player_guilds
-- (is_founder_guild) and are excluded from the player-guild half.

create table if not exists public.guild_leave_log (
  user_id uuid primary key references auth.users(id) on delete cascade,
  left_at timestamptz not null default now()
);
alter table public.guild_leave_log enable row level security;
revoke all on public.guild_leave_log from anon, authenticated;
grant select on public.guild_leave_log to authenticated;
create policy "read own leave log" on public.guild_leave_log
  for select using ((select auth.uid()) = user_id);

create or replace function public.log_guild_leave()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Skip when the whole account is being deleted (the seat row is going away because the user row is).
  if exists (select 1 from auth.users u where u.id = old.user_id) then
    insert into public.guild_leave_log (user_id, left_at) values (old.user_id, now())
    on conflict (user_id) do update set left_at = excluded.left_at;
  end if;
  return old;
end;
$function$;
revoke all on function public.log_guild_leave() from public, anon, authenticated;

drop trigger if exists founder_guild_members_log_leave on public.founder_guild_members;
create trigger founder_guild_members_log_leave
  after delete on public.founder_guild_members
  for each row execute function public.log_guild_leave();

drop trigger if exists player_guild_members_log_leave on public.player_guild_members;
create trigger player_guild_members_log_leave
  after delete on public.player_guild_members
  for each row execute function public.log_guild_leave();

create or replace function public.get_my_guild_membership()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_f record; v_p record; v_o record;
  v_left timestamptz;
  v_type text;
begin
  if v_uid is null then return null; end if;

  select guild_id, joined_at into v_f
    from public.founder_guild_members where user_id = v_uid order by joined_at limit 1;

  select g.id, g.name, g.motto, g.crest_url, g.owner_id, m.joined_at into v_p
    from public.player_guild_members m
    join public.player_guilds g on g.id = m.guild_id
    where m.user_id = v_uid and not g.is_founder_guild
    order by m.joined_at limit 1;

  select id, name, motto, crest_url, invite_code, created_at into v_o
    from public.player_guilds where owner_id = v_uid and not is_founder_guild limit 1;

  select left_at into v_left from public.guild_leave_log where user_id = v_uid;

  v_type := case
    when v_f.guild_id is not null then 'founder'
    when v_p.id is not null and v_p.owner_id = v_uid then 'player'
    when v_p.id is not null then 'joined'
    else null end;

  return jsonb_build_object(
    'guildType', v_type,
    'founderGuildId', v_f.guild_id,
    'founderJoinedDate', v_f.joined_at,
    'playerGuild', case when v_o.id is not null then jsonb_build_object(
        'id', v_o.id, 'name', v_o.name, 'motto', coalesce(v_o.motto, ''), 'crest', v_o.crest_url,
        'inviteCode', v_o.invite_code, 'createdDate', v_o.created_at, 'synced', true) end,
    'joinedGuild', case when v_p.id is not null and v_p.owner_id <> v_uid then jsonb_build_object(
        'id', v_p.id, 'name', v_p.name, 'motto', v_p.motto, 'crest', v_p.crest_url,
        'ownerId', v_p.owner_id, 'joinedDate', v_p.joined_at) end,
    'leftAt', v_left
  );
end;
$function$;
revoke all on function public.get_my_guild_membership() from public, anon;
grant execute on function public.get_my_guild_membership() to authenticated;
