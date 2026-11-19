\set ON_ERROR_STOP on
begin;
-- c1 admin, c2 verified member, c3 unverified
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000c1','es-admin@example.test'),
('00000000-0000-4000-8000-0000000000c2','es-member@example.test'),
('00000000-0000-4000-8000-0000000000c3','es-unverified@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000c1';
update profiles set passcode_verified=true where id='00000000-0000-4000-8000-0000000000c2';
-- source: 2030-01-10 18:00 Taipei (10:00Z), 2h, published, with agenda, checkin window, staff, registration, form
insert into public_events(id,title,description,location,starts_at,ends_at,registration_closes_at,capacity,is_published,checkin_opens_at,checkin_closes_at,agenda)
values('e9000000-0000-4000-8000-000000000001','AI Meetup','介紹','會議室 A','2030-01-10T10:00:00Z','2030-01-10T12:00:00Z','2030-01-09T10:00:00Z',25,true,'2030-01-10T09:30:00Z','2030-01-10T11:00:00Z',
 '[{"time":"18:00","title":"開場"},{"time":"18:30","title":"分享","speaker":"小明"},{"time":"晚間","title":"交流"}]');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values('e9000000-0000-4000-8000-000000000002','草稿活動','2030-02-10T10:00:00Z','2030-02-10T12:00:00Z','2030-02-09T10:00:00Z',10,false);
insert into event_registrations(event_id,user_id,status,checked_in_at,ticket_token) values('e9000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c2','registered',now(),'ntucc_ticket_'||repeat('a',64));
insert into event_staff values('e9000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c2');
insert into event_feedback_forms(event_id,questions,opens_at,closes_at,is_anonymous,published_at) values('e9000000-0000-4000-8000-000000000001','[{"id":"q1","type":"rating","label":"滿意度"}]','2030-01-10T12:00:00Z','2030-01-17T12:00:00Z',true,now());

-- flag OFF: everything denied
set local role service_role;
do $$begin
 begin perform create_event_series('00000000-0000-4000-8000-0000000000c1','x','');raise exception 'create while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c1',true);
do $$begin
 begin perform clone_event('e9000000-0000-4000-8000-000000000001','2030-03-01T10:00:00Z','2030-03-01T12:00:00Z');raise exception 'clone while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform assign_event_series('e9000000-0000-4000-8000-000000000001',null);raise exception 'assign while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform list_event_series();raise exception 'list while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 if exists(select 1 from event_series) then raise exception 'rows while off';end if;
end$$;
reset role;
update feature_flags set enabled=true where key='event_series';

-- service_role-only create/update
set local role service_role;
do $$declare s jsonb;begin
 begin perform create_event_series('00000000-0000-4000-8000-0000000000c2','x','');raise exception 'member created';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform create_event_series('00000000-0000-4000-8000-0000000000c1',repeat('x',81),'');raise exception 'long title';exception when raise_exception then if sqlerrm<>'INVALID_SERIES' then raise;end if;end;
 begin perform create_event_series('00000000-0000-4000-8000-0000000000c1','x',repeat('x',1001));raise exception 'long desc';exception when raise_exception then if sqlerrm<>'INVALID_SERIES' then raise;end if;end;
 begin perform create_event_series('00000000-0000-4000-8000-0000000000c1','x','','Bad Slug');raise exception 'bad slug';exception when raise_exception then if sqlerrm<>'INVALID_SLUG' then raise;end if;end;
 s:=create_event_series('00000000-0000-4000-8000-0000000000c1','每月 AI Meetup','每月一場','monthly-ai');
 perform set_config('es.series',s->>'id',true);
 begin perform create_event_series('00000000-0000-4000-8000-0000000000c1','dup','','monthly-ai');raise exception 'dup slug';exception when raise_exception then if sqlerrm<>'SLUG_TAKEN' then raise;end if;end;
 if (create_event_series('00000000-0000-4000-8000-0000000000c1','auto','')->>'slug') !~ '^series-' then raise exception 'slug not generated';end if;
 perform update_event_series('00000000-0000-4000-8000-0000000000c1',(s->>'id')::uuid,'每月 AI Meetup II','',null);
 begin perform update_event_series('00000000-0000-4000-8000-0000000000c1',gen_random_uuid(),'x','',null);raise exception 'missing series';exception when raise_exception then if sqlerrm<>'SERIES_NOT_FOUND' then raise;end if;end;
end$$;
-- authenticated cannot call the service-only RPCs
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c1',true);
do $$begin
 begin perform create_event_series(auth.uid(),'x','');raise exception 'authenticated create';exception when insufficient_privilege then null;end;
 begin perform update_event_series(auth.uid(),gen_random_uuid(),'x','',null);raise exception 'authenticated update';exception when insufficient_privilege then null;end;
 begin insert into event_series(title,slug) values('x','xx');raise exception 'direct insert';exception when insufficient_privilege then null;end;
end$$;

-- admin: assign, clone (clone result is stashed in a GUC and inspected as superuser afterwards)
do $$declare sid uuid:=current_setting('es.series')::uuid;n uuid;begin
 begin perform assign_event_series('e9000000-0000-4000-8000-000000000001',gen_random_uuid());raise exception 'bad series';exception when raise_exception then if sqlerrm<>'SERIES_NOT_FOUND' then raise;end if;end;
 begin perform assign_event_series(gen_random_uuid(),sid);raise exception 'bad event';exception when raise_exception then if sqlerrm<>'EVENT_NOT_FOUND' then raise;end if;end;
 perform assign_event_series('e9000000-0000-4000-8000-000000000001',sid);
 perform assign_event_series('e9000000-0000-4000-8000-000000000002',sid);
 if jsonb_array_length(event_series_admin_events())<>2 then raise exception 'admin events';end if;
 begin perform clone_event('e9000000-0000-4000-8000-000000000001','2030-03-01T10:00:00Z','2030-03-01T09:00:00Z');raise exception 'bad window';exception when raise_exception then if sqlerrm<>'INVALID_WINDOW' then raise;end if;end;
 begin perform clone_event(gen_random_uuid(),'2030-03-01T10:00:00Z','2030-03-01T12:00:00Z');raise exception 'missing source';exception when raise_exception then if sqlerrm<>'EVENT_NOT_FOUND' then raise;end if;end;
 -- new date 2030-03-01 19:00 Taipei (11:00Z): +1h
 n:=clone_event('e9000000-0000-4000-8000-000000000001','2030-03-01T11:00:00Z','2030-03-01T14:00:00Z');
 perform set_config('es.clone',n::text,true);
 perform clone_event('e9000000-0000-4000-8000-000000000002','2030-04-01T10:00:00Z','2030-04-01T12:00:00Z');
end$$;
reset role;
do $$declare sid uuid:=current_setting('es.series')::uuid;n uuid:=current_setting('es.clone')::uuid;r public_events;f event_feedback_forms;begin
 select * into r from public_events where id=n;
 if n='e9000000-0000-4000-8000-000000000001' or r.title<>'AI Meetup' or r.description<>'介紹' or r.location<>'會議室 A' or r.capacity<>25 or r.series_id<>sid then raise exception 'config not copied';end if;
 if r.is_published or r.status<>'scheduled' or r.sequence<>0 then raise exception 'clone must be unpublished draft';end if;
 if r.starts_at<>'2030-03-01T11:00:00Z' or r.ends_at<>'2030-03-01T14:00:00Z' then raise exception 'dates';end if;
 if r.registration_closes_at<>'2030-02-28T11:00:00Z' or r.checkin_opens_at<>'2030-03-01T10:30:00Z' or r.checkin_closes_at<>'2030-03-01T12:00:00Z' then raise exception 'relative windows %',r.registration_closes_at;end if;
 if r.agenda->0->>'time'<>'19:00' or r.agenda->1->>'time'<>'19:30' or r.agenda->1->>'speaker'<>'小明' or r.agenda->2->>'time'<>'晚間' then raise exception 'agenda shift %',r.agenda;end if;
 if exists(select 1 from event_registrations where event_id=n) or exists(select 1 from event_staff where event_id=n) then raise exception 'cloned registrations/staff';end if;
 select * into f from event_feedback_forms where event_id=n;
 if not found or f.published_at is not null or f.questions<>'[{"id":"q1","type":"rating","label":"滿意度"}]' or not f.is_anonymous or f.opens_at<>'2030-03-01T14:00:00Z' or f.closes_at<>'2030-03-08T14:00:00Z' then raise exception 'form clone';end if;
 if (select count(*) from event_feedback_responses where form_id=f.id)<>0 then raise exception 'responses cloned';end if;
 if (select count(*) from event_registrations where event_id='e9000000-0000-4000-8000-000000000001')<>1 then raise exception 'source mutated';end if;
 if (select count(*) from public_events where series_id=sid)<>4 then raise exception 'clones not in series';end if;
end$$;

-- verified member: sees series and PUBLISHED events only, cannot write, cannot clone
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c2',true);
do $$declare sid uuid:=current_setting('es.series')::uuid;l jsonb;begin
 if (select count(*) from event_series)<>2 then raise exception 'member series visibility';end if;
 l:=event_series_events(sid);
 if jsonb_array_length(l)<>1 or l->0->>'id'<>'e9000000-0000-4000-8000-000000000001' then raise exception 'member must see only published: %',l;end if;
 if exists(select 1 from jsonb_array_elements(l) x where x ? 'capacity' or x ? 'agenda' or x ? 'series_id') then raise exception 'extra columns exposed';end if;
 if jsonb_array_length(list_event_series())<>2 then raise exception 'list';end if;
 begin perform 1 from public_events;raise exception 'public_events readable';exception when insufficient_privilege then null;end;
 begin perform clone_event('e9000000-0000-4000-8000-000000000001','2030-03-01T10:00:00Z','2030-03-01T12:00:00Z');raise exception 'member clone';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform assign_event_series('e9000000-0000-4000-8000-000000000001',null);raise exception 'member assign';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform event_series_admin_events();raise exception 'member admin list';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin update event_series set title='h';raise exception 'member update';exception when insufficient_privilege then null;end;
end$$;
-- archived series hidden from members, visible to admin
reset role;
update event_series set archived=true where id=current_setting('es.series')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c2',true);
do $$begin
 if (select count(*) from event_series)<>1 then raise exception 'archived visible to member';end if;
 begin perform event_series_events(current_setting('es.series')::uuid);raise exception 'archived events';exception when raise_exception then if sqlerrm<>'SERIES_NOT_FOUND' then raise;end if;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c1',true);
do $$begin
 if (select count(*) from event_series)<>2 then raise exception 'admin cannot see archived';end if;
end$$;

-- unverified denied; anon no access
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c3',true);
do $$begin
 if exists(select 1 from event_series) then raise exception 'unverified read';end if;
 begin perform list_event_series();raise exception 'unverified list';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
 begin perform clone_event('e9000000-0000-4000-8000-000000000001','2030-03-01T10:00:00Z','2030-03-01T12:00:00Z');raise exception 'unverified clone';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
end$$;
reset role;set local role anon;
do $$begin
 begin perform 1 from event_series;raise exception 'anon read';exception when insufficient_privilege then null;end;
 begin perform list_event_series();raise exception 'anon list';exception when insufficient_privilege then null;end;
end$$;
reset role;
-- turning the flag off keeps data
update feature_flags set enabled=false where key='event_series';
do $$begin if (select count(*) from event_series)<>2 or (select count(*) from public_events where series_id is not null)<3 then raise exception 'data lost';end if;end$$;
rollback;
