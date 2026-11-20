-- clone_event must keep audience and waitlist settings (023 redefinition of 022's clone_event).
begin;
insert into auth.users(id,email) values('00000000-0000-4000-8000-00000000c1a0','clone-admin@example.test');
update public.profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-00000000c1a0';
insert into public.profiles(id,email,display_name,department,role,passcode_verified)
select '00000000-0000-4000-8000-00000000c1a0','clone-admin@example.test','複製管理員','資訊室','admin',true
where not exists(select 1 from public.profiles where id='00000000-0000-4000-8000-00000000c1a0');
update public.feature_flags set enabled=true where key='event_series';
insert into public.public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,waitlist_enabled,audience,is_published)
values('e9c10000-0000-4000-8000-000000000001','院內小聚','2030-03-10T10:00:00Z','2030-03-10T12:00:00Z','2030-03-09T10:00:00Z',12,true,'members',true);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000c1a0',true);
select set_config('test.clone_id',public.clone_event('e9c10000-0000-4000-8000-000000000001','2030-04-10T10:00:00Z','2030-04-10T12:00:00Z')::text,true);
reset role;
do $$declare r public.public_events;begin
 select * into r from public.public_events where id=current_setting('test.clone_id')::uuid;
 if r.id is null then raise exception 'clone missing';end if;
 if r.audience<>'members' then raise exception 'audience not copied: %',r.audience;end if;
 if not r.waitlist_enabled then raise exception 'waitlist_enabled not copied';end if;
 if r.is_published then raise exception 'clone must start unpublished';end if;
end$$;
rollback;
