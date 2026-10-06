-- F2: a manuscript link submitted to a guild event was stored unchecked and rendered as an <a href> in the
-- judge panel, so a "javascript:" link could run in a judge's (possibly admin) session. Only http:// and
-- https:// links are accepted now, trimmed and capped at 2000 characters. submit_guild_event_submission is
-- the only writer of user-supplied submission content (the table has no client INSERT/UPDATE policy; the quiz
-- path builds its own content server-side). Body below is the live function plus the link check.
create or replace function public.submit_guild_event_submission(
  p_event_id uuid, p_title text, p_word_count integer, p_content jsonb)
returns guild_event_submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_event guild_events%rowtype;
  v_row guild_event_submissions%rowtype;
  v_word_count integer;
  v_text text;
  v_link text;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  -- Manuscript link: http(s) only. Checked first so a bad link is always reported as such.
  if p_content is not null and jsonb_typeof(p_content) = 'object' and p_content ? 'link' then
    if jsonb_typeof(p_content->'link') <> 'string' then
      raise exception 'That manuscript link is not valid.';
    end if;
    v_link := btrim(p_content->>'link');
    if char_length(v_link) > 2000 or v_link !~* '^https?://[a-z0-9][^[:space:][:cntrl:]]*$' then
      raise exception 'The manuscript link must start with http:// or https:// and contain no spaces.';
    end if;
    p_content := jsonb_set(p_content, '{link}', to_jsonb(v_link));
  end if;

  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events do not take submissions here.';
  end if;
  if v_event.event_type = 'reading_challenge' and v_event.quiz_time_limit_seconds is not null then
    raise exception 'Quiz answers are submitted through the quiz itself.';
  end if;
  if v_event.event_type = 'tournament' then
    raise exception 'Tournament matches are played through the tournament itself.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'This event is not currently accepting submissions.';
  end if;
  if not exists (
    select 1 from guild_event_entries
    where event_id = p_event_id and entrant_id = auth.uid() and status = 'success'
  ) then
    raise exception 'Enter this event before submitting your work.';
  end if;
  if p_content is not null and octet_length(p_content::text) > 20971520 then
    raise exception 'Submission is too large (20MB limit).';
  end if;

  v_text := case when p_content is not null and jsonb_typeof(p_content) = 'object'
                  and jsonb_typeof(p_content->'text') = 'string' then p_content->>'text' end;
  if v_text is not null then
    if char_length(v_text) > 1000000 then
      raise exception 'This entry is too long to submit.';
    end if;
    v_word_count := guild_event_count_words(v_text);
    if octet_length(p_content::text) > 5000000 then
      raise exception 'This entry is too large to submit.';
    end if;
    if jsonb_typeof(p_content->'projectId') is not null
       and (jsonb_typeof(p_content->'projectId') <> 'string' or char_length(p_content->>'projectId') > 100) then
      raise exception 'The linked project''s id is not valid.';
    end if;
    if jsonb_typeof(p_content->'projectTitle') is not null
       and (jsonb_typeof(p_content->'projectTitle') <> 'string' or char_length(p_content->>'projectTitle') > 200) then
      raise exception 'The linked project''s title is too long (200 characters at most).';
    end if;
  else
    if v_event.min_word_count is not null or v_event.max_word_count is not null then
      raise exception 'This event has a word range, so your entry needs written text.';
    end if;
    v_word_count := 0;
  end if;

  if v_event.min_word_count is not null and v_word_count < v_event.min_word_count then
    raise exception 'This entry needs at least % words.', v_event.min_word_count;
  end if;
  if v_event.max_word_count is not null and v_word_count > v_event.max_word_count then
    raise exception 'This entry needs to stay under % words.', v_event.max_word_count;
  end if;

  insert into guild_event_submissions (event_id, entrant_id, title, word_count, content, submitted_at, updated_at)
  values (p_event_id, auth.uid(), nullif(p_title, ''), v_word_count, p_content, now(), now())
  on conflict (event_id, entrant_id) do update set
    title = excluded.title, word_count = excluded.word_count, content = excluded.content, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$function$;
