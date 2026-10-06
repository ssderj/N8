-- 201_migration_rate_limits_direct_writes.sql
-- F11: most client writes had no rate limit. Agreed limits (per user, per hour unless stated):
--   new book/pack/add-on/template listing 30 | new review 20 | new follow 100
--   post (discussion, fireside, platform comment) 40 | reaction 200 | report 20
--   anonymous book views, ALL books combined: 300 a minute (extra views dropped silently)
--
-- How: the existing check_and_bump_rate_limit() gets six new actions (it is migration 178's body plus
-- those cases), and one generic BEFORE INSERT trigger function, rate_limit_new_row(), calls it —
-- the same mechanism enforce_user_storage_quota() already uses for uploads, so no frontend change.
-- Two details that matter:
--   * The app saves with upsert, and an upsert fires BEFORE INSERT even when it ends up updating.
--     So for books, packs, add-ons, templates, reviews and follows the trigger first checks whether
--     the row already exists and, if so, does nothing: editing, republishing, unlisting/relisting
--     and changing a review never count — only brand-new rows do.
--   * When there is no signed-in user (service role, SQL editor, seed scripts) auth.uid() is null,
--     the limiter would raise "Not signed in", so the trigger skips those inserts entirely.
-- Existing tables, policies and data are untouched; only triggers are added. Safe to re-run.

-- ---- the limiter: 178's body + six new actions ----
create or replace function check_and_bump_rate_limit(p_action text)
returns void as $$
declare
  v_uid uuid := auth.uid();
  v_max_calls integer;
  v_window_seconds integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  -- Server-side limits. To change one, edit it here — never accept it from the caller.
  case p_action
    when 'init_purchase'        then v_max_calls := 20; v_window_seconds := 3600;
    when 'download_book'        then v_max_calls := 20; v_window_seconds := 3600;
    when 'init_event_entry'     then v_max_calls := 20; v_window_seconds := 3600;
    when 'init_hosting_fee'     then v_max_calls := 10; v_window_seconds := 3600;
    when 'list_banks'           then v_max_calls := 30; v_window_seconds := 3600;
    when 'init_pack_purchase'   then v_max_calls := 20; v_window_seconds := 3600;
    when 'resolve_bank_account' then v_max_calls := 10; v_window_seconds := 3600;
    when 'storage_upload'       then v_max_calls := 60; v_window_seconds := 3600;
    when 'join_guild'           then v_max_calls := 20; v_window_seconds := 3600;
    -- Migration 171: giveaway tickets — 10 taps a minute per person (the 100-ticket cap is separate).
    when 'giveaway_tap'         then v_max_calls := 10; v_window_seconds := 60;
    -- Migration 178: suggesting quiz questions - 20 an hour per person. The 10-waiting cap in the suggest
    -- functions is the real bound; this only stops someone scripting a flood of suggest/approve/suggest.
    when 'quiz_suggest'         then v_max_calls := 20; v_window_seconds := 3600;
    -- Migration 201 (F11): the limits for direct writes that used to have none. Fired by
    -- rate_limit_new_row() triggers, and only for genuinely NEW rows. Deliberately generous: they
    -- exist to stop scripts, not to slow a real writer down.
    when 'publish_listing'      then v_max_calls := 30;  v_window_seconds := 3600; -- new book/pack/add-on/template
    when 'review'               then v_max_calls := 20;  v_window_seconds := 3600; -- new review (editing one is free)
    when 'follow'               then v_max_calls := 100; v_window_seconds := 3600; -- new follow
    when 'post'                 then v_max_calls := 40;  v_window_seconds := 3600; -- discussion post / fireside post / platform comment
    when 'reaction'             then v_max_calls := 200; v_window_seconds := 3600; -- reaction toggles
    when 'report'               then v_max_calls := 20;  v_window_seconds := 3600; -- content reports
    else
      raise exception 'Unknown rate limit action.';
  end case;

  perform pg_advisory_xact_lock(hashtext('api_rate_limit:' || v_uid::text || ':' || p_action));

  select window_start, call_count into v_window_start, v_count
  from api_rate_limits where user_id = v_uid and action = p_action;

  if v_window_start is null or now() - v_window_start > (v_window_seconds || ' seconds')::interval then
    insert into api_rate_limits (user_id, action, window_start, call_count)
    values (v_uid, p_action, now(), 1)
    on conflict (user_id, action) do update set window_start = now(), call_count = 1;
    return;
  end if;

  if v_count >= v_max_calls then
    raise exception 'Too many requests — please slow down and try again shortly.';
  end if;

  update api_rate_limits set call_count = call_count + 1
  where user_id = v_uid and action = p_action;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function check_and_bump_rate_limit(text) to authenticated;

-- ---- the trigger function ----
create or replace function rate_limit_new_row()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_action text := TG_ARGV[0];
  v_exists boolean := false;
begin
  if auth.uid() is null then
    return new; -- server-side write: no user to limit
  end if;

  if TG_TABLE_NAME in ('published_books', 'published_packs', 'published_addons', 'published_templates') then
    execute format('select exists (select 1 from public.%I where id = $1)', TG_TABLE_NAME)
      into v_exists using new.id;
  elsif TG_TABLE_NAME = 'reviews' then
    select exists (select 1 from reviews where book_id = new.book_id and reviewer_id = new.reviewer_id) into v_exists;
  elsif TG_TABLE_NAME = 'follows' then
    select exists (select 1 from follows where follower_id = new.follower_id and followee_id = new.followee_id) into v_exists;
  end if;

  if v_exists then
    return new; -- an upsert that will update an existing row: not a new write
  end if;

  perform check_and_bump_rate_limit(v_action);
  return new;
end;
$$;
revoke all on function rate_limit_new_row() from public, anon, authenticated;

-- ---- the triggers ----
drop trigger if exists rate_limit_new_row_trg on published_books;
create trigger rate_limit_new_row_trg before insert on published_books
  for each row execute function rate_limit_new_row('publish_listing');
drop trigger if exists rate_limit_new_row_trg on published_packs;
create trigger rate_limit_new_row_trg before insert on published_packs
  for each row execute function rate_limit_new_row('publish_listing');
drop trigger if exists rate_limit_new_row_trg on published_addons;
create trigger rate_limit_new_row_trg before insert on published_addons
  for each row execute function rate_limit_new_row('publish_listing');
drop trigger if exists rate_limit_new_row_trg on published_templates;
create trigger rate_limit_new_row_trg before insert on published_templates
  for each row execute function rate_limit_new_row('publish_listing');

drop trigger if exists rate_limit_new_row_trg on reviews;
create trigger rate_limit_new_row_trg before insert on reviews
  for each row execute function rate_limit_new_row('review');

drop trigger if exists rate_limit_new_row_trg on follows;
create trigger rate_limit_new_row_trg before insert on follows
  for each row execute function rate_limit_new_row('follow');

drop trigger if exists rate_limit_new_row_trg on book_discussion_posts;
create trigger rate_limit_new_row_trg before insert on book_discussion_posts
  for each row execute function rate_limit_new_row('post');
drop trigger if exists rate_limit_new_row_trg on fireside_posts;
create trigger rate_limit_new_row_trg before insert on fireside_posts
  for each row execute function rate_limit_new_row('post');
drop trigger if exists rate_limit_new_row_trg on platform_post_comments;
create trigger rate_limit_new_row_trg before insert on platform_post_comments
  for each row execute function rate_limit_new_row('post');

drop trigger if exists rate_limit_new_row_trg on fireside_reactions;
create trigger rate_limit_new_row_trg before insert on fireside_reactions
  for each row execute function rate_limit_new_row('reaction');
drop trigger if exists rate_limit_new_row_trg on platform_post_reactions;
create trigger rate_limit_new_row_trg before insert on platform_post_reactions
  for each row execute function rate_limit_new_row('reaction');

drop trigger if exists rate_limit_new_row_trg on content_reports;
create trigger rate_limit_new_row_trg before insert on content_reports
  for each row execute function rate_limit_new_row('report');

-- ---- anonymous views: overall cap (live record_book_view + one block) ----
-- Serves the new count; partial index so it stays cheap as the table grows.
create index if not exists book_view_events_anon_created_idx
  on book_view_events (created_at desc) where viewer_id is null;

create or replace function record_book_view(p_book_id text, p_event_type text, p_source text default 'direct')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_viewer_id uuid := auth.uid(); -- null when called signed-out; never trusted from the client
  v_source text := coalesce(p_source, 'direct');
  v_viewer_hourly_limit constant int := 120;
  v_viewer_recent_count int;
  v_anon_burst_window constant interval := interval '1 minute';
  v_anon_burst_limit constant int := 30;
  v_anon_recent_count int;
  v_anon_total_limit constant int := 300;
  v_anon_total_count int;
begin
  -- Reject anything outside the approved values before any other work. Exact match only: no
  -- trimming or case-folding, so 'Detail_View' / 'detail_view ' are invalid, not aliases.
  if p_event_type is null or p_event_type not in ('detail_view', 'read_start') then
    raise exception 'Invalid book view event type.';
  end if;
  if v_source not in (
    'featured', 'new_releases', 'top_rated', 'discover', 'cart',
    'author_profile', 'guild_bookshelf', 'most_read', 'trending', 'direct'
  ) then
    raise exception 'Invalid book view source.';
  end if;

  -- Unknown book id: a no-op, not an error (a stale client shouldn't surface a failure).
  if not exists (select 1 from published_books where id = p_book_id) then
    return;
  end if;

  if v_viewer_id is not null then
    -- Serialize this viewer's own calls so concurrent identical requests can't both pass the
    -- dedupe/limit checks below before either has inserted.
    perform pg_advisory_xact_lock(hashtext('book_view:' || v_viewer_id::text));

    -- Dedupe a signed-in viewer's own rapid repeat of the same (book, event_type).
    if exists (
      select 1 from book_view_events
      where book_id = p_book_id and viewer_id = v_viewer_id and event_type = p_event_type
        and created_at > now() - interval '5 minutes'
    ) then
      return;
    end if;

    -- Per-viewer ceiling across all books.
    select count(*) into v_viewer_recent_count
    from book_view_events
    where viewer_id = v_viewer_id and created_at > now() - interval '1 hour';

    if v_viewer_recent_count >= v_viewer_hourly_limit then
      return;
    end if;
  else
    select count(*) into v_anon_recent_count
    from book_view_events
    where book_id = p_book_id
      and viewer_id is null
      and event_type = p_event_type
      and created_at > now() - v_anon_burst_window;

    if v_anon_recent_count >= v_anon_burst_limit then
      return;
    end if;

    -- Migration 201 (F11): the cap above is per book, so a script rotating through books was never
    -- limited overall. Cap ALL anonymous views at 300 a minute; extra views are dropped silently, as above.
    select count(*) into v_anon_total_count
    from book_view_events
    where viewer_id is null and created_at > now() - v_anon_burst_window;

    if v_anon_total_count >= v_anon_total_limit then
      return;
    end if;
  end if;

  insert into book_view_events (book_id, viewer_id, event_type, source)
  values (p_book_id, v_viewer_id, p_event_type, v_source);
end;
$$;

revoke all on function record_book_view(text, text, text) from public;
grant execute on function record_book_view(text, text, text) to authenticated, anon;
