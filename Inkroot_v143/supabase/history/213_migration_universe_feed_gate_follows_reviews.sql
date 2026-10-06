-- 213: Living Universe — follows and reviews are no longer public. *** NOT YET APPLIED — run in the SQL editor. ***
--
-- Until now list_living_universe_feed() handed every signed-in user a line for every follow ("A started following B")
-- and every review ("A reviewed <book>") on the platform, with both people's names resolved. Those are personal to the
-- person they happen to: a writer's new followers and the reviews on a writer's own books.
--
--  * list_living_universe_feed()  — same signature, same 1..100 cap, but now returns ONLY 'release' and 'guild' rows.
--  * list_my_universe_activity()  — NEW, owner-scoped. Returns 'follow' rows where the caller is the person being
--    followed and 'review' rows on books the caller authored. Nothing for a signed-out caller. Reviews a moderator
--    removed are left out.
--
-- Deliberately NOT changed: the `follows` and `reviews` tables keep their public-read policies, because follower counts
-- and the per-book review lists in the Library read them directly. This migration only stops the Universe feed from
-- broadcasting them as a stream of named events.
-- Guild joins stay in the public feed (decided separately — see migration 204, finding #21).

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

create or replace function public.list_my_universe_activity(p_result_limit integer default null)
 returns table(id uuid, kind text, created_at timestamptz, payload jsonb)
 language plpgsql stable security definer
 set search_path to 'public'
as $function$
begin
  -- Signed-out (or no JWT): nothing. The caller's own id is read here, never taken from the client.
  if auth.uid() is null then
    return;
  end if;

  return query
  select u.id, u.kind, u.created_at, u.payload from (
    -- Someone started following ME.
    select
      md5('follow:' || fe.id::text)::uuid as id,
      'follow'::text as kind,
      fe.created_at as created_at,
      jsonb_build_object(
        'follower_name', coalesce(pf.display_name, pf.pen_name, 'A reader')
      ) as payload
    from follow_events fe
    left join profiles pf on pf.id = fe.follower_id
    where fe.followee_id = auth.uid()

    union all

    -- Someone reviewed a book I wrote (any destination: it is my own book).
    select
      md5('review:' || r.id::text)::uuid,
      'review'::text,
      r.created_at,
      jsonb_build_object(
        'book_id', r.book_id, 'title', b.title, 'rating', r.rating,
        'reviewer_name', coalesce(p.display_name, p.pen_name, 'A reader')
      )
    from reviews r
    join published_books b on b.id = r.book_id and b.author_id = auth.uid()
    left join profiles p on p.id = r.reviewer_id
    where not coalesce(r.removed_by_moderator, false)
  ) u
  order by u.created_at desc
  limit greatest(1, least(100, coalesce(p_result_limit, 30)));
end;
$function$;

revoke all on function public.list_my_universe_activity(integer) from public, anon;
grant execute on function public.list_my_universe_activity(integer) to authenticated;
