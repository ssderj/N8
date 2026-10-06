-- 212: server-side backstop for the sign-out/sign-in data-loss bug (v133 front-end fix is the main fix).
-- A device with nothing saved locally used to create a BLANK writer profile / guild record and push it over
-- the account's real one as a normal update. This trigger refuses exactly that, and nothing else:
--   * inkroot:writer:profile  -> refused when the new value is empty (no name, pen name, motto, avatar) AND has a
--     different joinDate than the stored one AND the stored one had content. (Clearing your own fields keeps the
--     same joinDate, so a deliberate edit still goes through.)
--   * inkroot:writer:guild    -> refused when the new value has every field null while the stored one had a guild
--     seat. (Leaving a guild keeps founderGuildId and sets leftAt, so it is not blocked.)
-- Error code IK001. The v133 syncEngine.js treats it as "the server copy wins": it pulls the real record back
-- instead of leaving the blank one queued. Anything that fails to parse is allowed through unchanged.
create or replace function public.enforce_kv_store_no_blank_overwrite()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  o jsonb; n jsonb;
begin
  if new.deleted or old.deleted or new.value is null or old.value is null then
    return new;
  end if;
  if new.key not in ('inkroot:writer:profile', 'inkroot:writer:guild') then
    return new;
  end if;
  begin
    o := (old.value #>> '{}')::jsonb;
    n := (new.value #>> '{}')::jsonb;
  exception when others then
    return new;
  end;
  if new.key = 'inkroot:writer:profile' then
    if coalesce(n->>'name','') = '' and coalesce(n->>'penName','') = '' and coalesce(n->>'motto','') = ''
       and (n->'avatar' is null or jsonb_typeof(n->'avatar') = 'null')
       and (coalesce(o->>'name','') <> '' or coalesce(o->>'penName','') <> '' or coalesce(o->>'motto','') <> ''
            or (o->'avatar' is not null and jsonb_typeof(o->'avatar') <> 'null'))
       and coalesce(n->>'joinDate','') <> coalesce(o->>'joinDate','') then
      raise exception 'blank writer profile refused: it would overwrite a saved one' using errcode = 'IK001';
    end if;
  else
    if jsonb_typeof(n->'guildType') is not distinct from 'null' or n->'guildType' is null then
      if (n->'founderGuildId' is null or jsonb_typeof(n->'founderGuildId') = 'null')
         and (n->'playerGuild' is null or jsonb_typeof(n->'playerGuild') = 'null')
         and (n->'joinedGuild' is null or jsonb_typeof(n->'joinedGuild') = 'null')
         and (n->'leftAt' is null or jsonb_typeof(n->'leftAt') = 'null')
         and ((o->'guildType' is not null and jsonb_typeof(o->'guildType') <> 'null')
              or (o->'founderGuildId' is not null and jsonb_typeof(o->'founderGuildId') <> 'null')
              or (o->'playerGuild' is not null and jsonb_typeof(o->'playerGuild') <> 'null')
              or (o->'joinedGuild' is not null and jsonb_typeof(o->'joinedGuild') <> 'null')) then
        raise exception 'blank guild record refused: it would overwrite a saved one' using errcode = 'IK001';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.enforce_kv_store_no_blank_overwrite() from public, anon, authenticated;

-- Sorts before kv_store_stamp, so it sees the value exactly as the client sent it.
drop trigger if exists kv_store_block_blank_trg on public.kv_store;
create trigger kv_store_block_blank_trg
  before update on public.kv_store
  for each row execute function public.enforce_kv_store_no_blank_overwrite();
