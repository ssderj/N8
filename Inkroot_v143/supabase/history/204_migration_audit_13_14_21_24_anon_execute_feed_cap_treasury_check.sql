-- 204: audit #13, #14, #21, #24. APPLIED to the live project on 2026-10-03 and verified.
--  #13 revoke anon/public execute on 8 money/moderation functions (authenticated keeps it)
--  #24 revoke is_guild_book_member from public/anon/authenticated (only download-book uses it, via the service key;
--      no policy and no database function calls it)
--  #21 list_living_universe_feed capped to 1..100 rows (access unchanged; decide separately whether signed-out
--      visitors should see follow / guild-join names)
--  #14 is_guild_treasury_authorized only answers for the caller's own id (service_role / no-JWT calls unchanged;
--      every caller in the database uses the one-argument form)
revoke execute on function
  public.cancel_guild_event(uuid,uuid), public.contribute_to_guild_event_escrow(uuid,uuid,bigint,text),
  public.deposit_guild_event_prize_escrow(uuid,uuid), public.pay_guild_event_escrow_contributors(uuid,uuid,bigint),
  public.reverse_achievement_grant(uuid,text), public.submit_guild_event_judge_score(uuid,uuid,text,numeric),
  public.unpublish_book(text), public.unpublish_pack(text)
from public, anon;
grant execute on function
  public.cancel_guild_event(uuid,uuid), public.contribute_to_guild_event_escrow(uuid,uuid,bigint,text),
  public.deposit_guild_event_prize_escrow(uuid,uuid), public.pay_guild_event_escrow_contributors(uuid,uuid,bigint),
  public.reverse_achievement_grant(uuid,text), public.submit_guild_event_judge_score(uuid,uuid,text,numeric),
  public.unpublish_book(text), public.unpublish_pack(text)
to authenticated;

revoke execute on function public.is_guild_book_member(text, uuid) from public, anon, authenticated;

create or replace function public.list_living_universe_feed(p_result_limit integer default null)
 returns table(id uuid, kind text, created_at timestamptz, payload jsonb)
 language plpgsql stable security definer
 set search_path to 'public'
as $function$
begin
  return query
  select u.id, u.kind, u.created_at, u.payload from (
    select
      md5('release:' || e.book_id)::uuid as id,
      'release'::text as kind,
      e.first_published_at as created_at,
      jsonb_build_object(
        'book_id', e.book_id, 'title', b.title, 'genre', b.genre,
        'author_name', coalesce(p.display_name, p.pen_name, 'A writer')
      ) as payload
    from book_publish_events e
    -- destination = 'inkroot' only: this function is SECURITY DEFINER and bypasses
    -- published_books' guild-membership RLS.
    join published_books b on b.id = e.book_id and b.destination = 'inkroot'
    left join profiles p on p.id = e.author_id

    union all

    select
      md5('follow:' || fe.id::text)::uuid,
      'follow'::text,
      fe.created_at,
      jsonb_build_object(
        'follower_name', coalesce(pf.display_name, pf.pen_name, 'A writer'),
        'followee_name', coalesce(pe.display_name, pe.pen_name, 'a writer')
      )
    from follow_events fe
    left join profiles pf on pf.id = fe.follower_id
    left join profiles pe on pe.id = fe.followee_id

    union all

    select
      md5('review:' || r.id::text)::uuid,
      'review'::text,
      r.created_at,
      jsonb_build_object(
        'book_id', r.book_id, 'title', b.title, 'rating', r.rating,
        'reviewer_name', coalesce(p.display_name, p.pen_name, 'A reader')
      )
    from reviews r
    -- destination = 'inkroot' only — same reasoning as the release branch above.
    join published_books b on b.id = r.book_id and b.destination = 'inkroot'
    left join profiles p on p.id = r.reviewer_id

    union all

    select
      md5('guildjoin:' || ge.id::text)::uuid,
      'guild'::text,
      ge.created_at,
      jsonb_build_object(
        'guild_id', ge.guild_id, 'guild_name', g.name,
        'user_name', coalesce(p.display_name, p.pen_name, 'A writer')
      )
    from guild_join_events ge
    join player_guilds g on g.id = ge.guild_id
    left join profiles p on p.id = ge.user_id
  ) u
  order by u.created_at desc
  limit greatest(1, least(100, coalesce(p_result_limit, 60)));
end;
$function$;

create or replace function public.is_guild_treasury_authorized(p_guild_id uuid, p_user_id uuid default auth.uid())
 returns boolean
 language sql stable security definer
 set search_path to 'public'
as $function$
  -- NULL-safe (migration 157): coalesce forces the no-role / no-caller case to false.
  -- Migration 204: a signed-in caller can only ask about themselves.
  select case
    when p_user_id is not distinct from auth.uid()
      or coalesce(auth.role(), '') in ('service_role', '')
    then coalesce(guild_treasury_role(p_guild_id, p_user_id) in ('leader', 'treasurer', 'officer'), false)
    else false
  end;
$function$;
