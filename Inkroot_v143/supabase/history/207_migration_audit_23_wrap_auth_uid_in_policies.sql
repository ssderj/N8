-- 207: audit #23 (access-rules part). APPLIED to the live project on 2026-10-03.
-- The advisor flagged 181 rules that re-run auth.uid() for every row; (select auth.uid()) evaluates it once per
-- query. Same meaning, faster. Also moves the 3 storage "platform admins ..." rules onto the 206 role helpers.
-- Idempotent: already-wrapped rules (Postgres shows them as "( SELECT auth.uid() AS uid)") are left alone.
-- Result on live: 181 public rules + 10 storage rules rewritten; 0 bare auth.uid() and 0 inline role lookups left.
do $$
declare
  r record; new_qual text; new_check text; stmt text; n_pub int := 0; n_sto int := 0;
  flag_pat constant text := '\(EXISTS \( SELECT 1\s+FROM profiles p\s+WHERE \(\(p\.id = auth\.uid\(\)\) AND p\.is_(moderator|platform_admin)\)\)\)';
  uid_pat  constant text := '(?<!SELECT )auth\.uid\(\)';
begin
  for r in select schemaname, tablename, policyname, qual, with_check from pg_policies
           where schemaname in ('public', 'storage')
             and (qual ~ uid_pat or with_check ~ uid_pat or qual ~ flag_pat or with_check ~ flag_pat)
           order by schemaname, tablename, policyname
  loop
    new_qual  := regexp_replace(regexp_replace(coalesce(r.qual, ''),       flag_pat, '(select public.is_current_\1())', 'g'), uid_pat, '(select auth.uid())', 'g');
    new_check := regexp_replace(regexp_replace(coalesce(r.with_check, ''), flag_pat, '(select public.is_current_\1())', 'g'), uid_pat, '(select auth.uid())', 'g');
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.qual is not null       and new_qual  <> r.qual       then stmt := stmt || format(' using (%s)', new_qual); end if;
    if r.with_check is not null and new_check <> r.with_check then stmt := stmt || format(' with check (%s)', new_check); end if;
    execute stmt;
    if r.schemaname = 'public' then n_pub := n_pub + 1; else n_sto := n_sto + 1; end if;
  end loop;
  raise notice 'rewritten: % public rules, % storage rules', n_pub, n_sto;
end $$;
