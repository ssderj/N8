-- F15: record_profile_switch() let any signed-in user write arbitrary 'profile_switch' rows into the admin
-- audit log. It is only called by the switch-profile edge function, as the real caller, after that function
-- has already run can_switch_to_linked_profile(). Re-check the same link here so the log only records real switches.
create or replace function public.record_profile_switch(target_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null or target_id is null or not can_switch_to_linked_profile(target_id) then
    raise exception 'That profile isn''t linked to your account.';
  end if;
  perform record_admin_action('profile_switch', 'profiles', target_id, null, null, null, null);
end;
$function$;
