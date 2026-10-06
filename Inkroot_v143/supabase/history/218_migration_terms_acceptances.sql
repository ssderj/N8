-- 218 (APPLIED live 5 Oct 2026): record who accepted which version of the Terms & Privacy Policy, and when.
-- Client: src/lib/terms.js + the checkbox in src/shell/account-sync-control.jsx. The server stamps accepted_at
-- itself (default now()); the client only says which version. One row per (account, version), so bumping
-- TERMS_VERSION in terms.js later makes everyone re-accept without losing the earlier records.
-- Writes only through record_terms_acceptance(); people can read their own rows (RLS), nobody can edit or delete.
-- After applying: append this file to supabase/schema.sql and run the schema tests.

create table if not exists public.terms_acceptances (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  version     text        not null check (length(version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);

alter table public.terms_acceptances enable row level security;

revoke all on public.terms_acceptances from anon, authenticated;
grant select on public.terms_acceptances to authenticated;

drop policy if exists "Users read their own terms acceptances" on public.terms_acceptances;
create policy "Users read their own terms acceptances" on public.terms_acceptances
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.record_terms_acceptance(p_version text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if p_version is null or length(trim(p_version)) = 0 or length(p_version) > 40 then
    raise exception 'Invalid terms version.';
  end if;
  insert into terms_acceptances (user_id, version) values (auth.uid(), trim(p_version))
  on conflict (user_id, version) do nothing;
end;
$function$;

revoke all on function public.record_terms_acceptance(text) from public, anon;
grant execute on function public.record_terms_acceptance(text) to authenticated;
