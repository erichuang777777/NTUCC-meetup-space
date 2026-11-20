\set ON_ERROR_STOP on
begin;
-- d1 admin, d11-d15 verified dept 研發科 (5), d21-d22 verified dept 小科 (2), d31 unverified (research dept), d41 verified plain member
insert into auth.users(id,email)
select ('00000000-0000-4000-8000-0000000000'||n)::uuid,'dash-'||n||'@example.test' from unnest(array['d1','11','12','13','14','15','21','22','31','41']) n;
update profiles set role='admin',passcode_verified=true,department='管理' where id='00000000-0000-4000-8000-0000000000d1';
update profiles set passcode_verified=true,department='研發科' where id in ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000015');
update profiles set passcode_verified=true,department='小科' where id in ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022');
update profiles set department='研發科' where id='00000000-0000-4000-8000-000000000031';
update profiles set passcode_verified=true,department='管理' where id='00000000-0000-4000-8000-000000000041';

-- admin dept has 2 members (d1,d41) => suppressed too
insert into spaces(id,owner_id,title,summary,visibility) values
('a1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','公開展示','s','public'),
('a1000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011','私人展示','s','private'),
('a1000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000012','被隱藏展示','s','public');
insert into discussion_threads(id,space_id,author_id,title,body,is_hidden) values
('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','熱門討論','b',false),
('a2000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','隱藏討論欄位','b',true),
('a2000000-0000-4000-8000-000000000003','a1000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011','私人討論','b',false),
('a2000000-0000-4000-8000-000000000004','a1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','版務隱藏討論','b',false);
insert into discussion_replies(thread_id,author_id,body,is_hidden) values
('a2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','r',false),
('a2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000013','r',false),
('a2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000013','r',true),
('a2000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000013','r',false),
('a2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000013','r',false);
insert into content_moderation(target_type,target_id) values
('space','a1000000-0000-4000-8000-000000000003'),('thread','a2000000-0000-4000-8000-000000000004'),
('pain_point','a3000000-0000-4000-8000-000000000002');
insert into pain_points(id,proposer_id,title,scenario) values
('a3000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','熱門痛點','s'),
('a3000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011','隱藏痛點','s');
insert into user_votes(user_id,target_type,target_id) values
('00000000-0000-4000-8000-000000000012','pain_point','a3000000-0000-4000-8000-000000000001'),
('00000000-0000-4000-8000-000000000013','pain_point','a3000000-0000-4000-8000-000000000001'),
('00000000-0000-4000-8000-000000000012','pain_point','a3000000-0000-4000-8000-000000000002'),
('00000000-0000-4000-8000-000000000012','space','a1000000-0000-4000-8000-000000000001'),
('00000000-0000-4000-8000-000000000012','space','a1000000-0000-4000-8000-000000000002'),
('00000000-0000-4000-8000-000000000012','space','a1000000-0000-4000-8000-000000000003');
insert into vibe_events(space_id,user_id,kind) values('a1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000013','mindblown');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values
('a4000000-0000-4000-8000-000000000001','已舉辦',now()-interval '3 days',now()-interval '3 days'+interval '2 hours',now()-interval '4 days',50,true),
('a4000000-0000-4000-8000-000000000002','未發布',now()-interval '3 days',now()-interval '3 days'+interval '2 hours',now()-interval '4 days',50,false);
insert into event_registrations(event_id,user_id,status,checked_in_at,guest_token_hash) values
('a4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011','registered',now()-interval '3 days',null),
('a4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000012','registered',null,null),
('a4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021','registered',now()-interval '3 days',null),
('a4000000-0000-4000-8000-000000000001',null,'registered',null,'guesthash1'),
('a4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000013','cancelled',null,null);

-- flag OFF: denied for everyone
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
do $$begin
 begin perform dashboard_overview(current_date-30,current_date);raise exception 'overview while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform dashboard_department_participation(current_date-30,current_date);raise exception 'dept while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform dashboard_top_content(current_date-30,current_date);raise exception 'top while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform dashboard_timeseries('threads',current_date-30,current_date,'week');raise exception 'ts while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
select set_feature_flag('admin_dashboard',true);

-- non-admin (verified member) and unverified denied; anon cannot execute
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000041',true);
do $$begin
 begin perform dashboard_overview(current_date-30,current_date);raise exception 'member allowed';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform dashboard_top_content(current_date-30,current_date);raise exception 'member allowed';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000031',true);
do $$begin
 begin perform dashboard_department_participation(current_date-30,current_date);raise exception 'unverified allowed';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
end$$;
reset role;set local role anon;
do $$begin
 begin perform dashboard_overview(current_date-30,current_date);raise exception 'anon allowed';exception when insufficient_privilege then null;end;
end$$;
reset role;set local role authenticated;
do $$begin
 begin perform dash_guard(current_date-1,current_date);raise exception 'helper callable';exception when insufficient_privilege then null;end;
end$$;

-- admin
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
do $$begin
 -- range validation
 begin perform dashboard_overview(current_date,current_date-1);raise exception 'reversed';exception when raise_exception then if sqlerrm<>'INVALID_RANGE' then raise;end if;end;
 begin perform dashboard_overview(current_date-731,current_date);raise exception '>2y';exception when raise_exception then if sqlerrm<>'INVALID_RANGE' then raise;end if;end;
 begin perform dashboard_overview(null,current_date);raise exception 'null';exception when raise_exception then if sqlerrm<>'INVALID_RANGE' then raise;end if;end;
 perform dashboard_overview(current_date-730,current_date);
 begin perform dashboard_timeseries('bogus',current_date-30,current_date,'week');raise exception 'metric';exception when raise_exception then if sqlerrm<>'INVALID_METRIC' then raise;end if;end;
 begin perform dashboard_timeseries('threads',current_date-30,current_date,'day');raise exception 'bucket';exception when raise_exception then if sqlerrm<>'INVALID_BUCKET' then raise;end if;end;
end$$;

do $$declare o jsonb;d jsonb;t jsonb;ts jsonb;x jsonb;begin
 o:=dashboard_overview(current_date-30,current_date);
 if (o->>'verified_members')::int<>9 then raise exception 'verified members %',o;end if;
 if (o->>'new_members')::int<>9 then raise exception 'new members %',o;end if;
 if (o->>'events_held')::int<>1 then raise exception 'events held %',o;end if;
 if (o->>'registrations_member')::int<>3 or (o->>'registrations_guest')::int<>1 then raise exception 'registrations %',o;end if;
 if (o->>'held_registrations')::int<>4 or (o->>'checked_in')::int<>2 or (o->>'checkin_rate')::numeric<>0.5 then raise exception 'checkin %',o;end if;
 if (o->>'public_spaces_created')::int<>1 then raise exception 'spaces %',o;end if;
 if (o->>'threads')::int<>1 then raise exception 'threads %',o;end if;
 if (o->>'replies')::int<>2 then raise exception 'replies %',o;end if;
 if (o->>'pain_points')::int<>1 or (o->>'pain_point_votes')::int<>2 then raise exception 'pain %',o;end if;
 -- feature metrics null while their flags are off
 if o->'waitlisted'<>'null'::jsonb or o->'polls'<>'null'::jsonb or o->'feedback'<>'null'::jsonb or o->'notifications'<>'null'::jsonb
  or o->'reports'<>'null'::jsonb or o->'talk_proposals'<>'null'::jsonb or o->'hosted_event_requests'<>'null'::jsonb then raise exception 'flag-off metrics not null %',o;end if;

 -- department suppression: 研發科(5) shown; 小科(2) and 管理(2) merged
 d:=dashboard_department_participation(current_date-30,current_date);
 if jsonb_array_length(d)<>2 then raise exception 'dept rows %',d;end if;
 if d->0->>'department'<>'研發科' or (d->0->>'members')::int<>5 or (d->0->>'registrations')::int<>2 or (d->0->>'checkins')::int<>1
  or (d->0->>'spaces')::int<>1 or (d->0->>'threads')::int<>1 then raise exception 'dept A %',d;end if;
 if d->1->>'department'<>'其他（人數少於 5）' or (d->1->>'members')::int<>4 or (d->1->>'registrations')::int<>1 then raise exception 'dept other %',d;end if;
 if d::text like '%小科%' or d::text like '%管理%' then raise exception 'small dept name leaked %',d;end if;

 -- top content: hidden/private excluded
 t:=dashboard_top_content(current_date-30,current_date,10);
 if jsonb_array_length(t->'spaces')<>1 or t->'spaces'->0->>'title'<>'公開展示' or (t->'spaces'->0->>'votes')::int<>1 or (t->'spaces'->0->>'vibes')::int<>1 then raise exception 'top spaces %',t;end if;
 if jsonb_array_length(t->'pain_points')<>1 or t->'pain_points'->0->>'title'<>'熱門痛點' or (t->'pain_points'->0->>'votes')::int<>2 then raise exception 'top pain %',t;end if;
 if jsonb_array_length(t->'threads')<>1 or t->'threads'->0->>'title'<>'熱門討論' or (t->'threads'->0->>'replies')::int<>2 then raise exception 'top threads %',t;end if;
 if t::text like '%隱藏%' or t::text like '%私人%' or t::text like '%被隱藏%' then raise exception 'hidden/private leaked %',t;end if;
 if jsonb_array_length((dashboard_top_content(current_date-30,current_date,0))->'spaces')>1 then raise exception 'limit clamp';end if;

 -- timeseries: totals match overview
 ts:=dashboard_timeseries('registrations',current_date-30,current_date,'week');
 if (select sum((p->>'value')::int) from jsonb_array_elements(ts->'points') p)<>4 then raise exception 'ts reg %',ts;end if;
 ts:=dashboard_timeseries('checkins',current_date-30,current_date,'month');
 if (select sum((p->>'value')::int) from jsonb_array_elements(ts->'points') p)<>2 then raise exception 'ts checkins %',ts;end if;
 ts:=dashboard_timeseries('threads',current_date-30,current_date,'week');
 if (select sum((p->>'value')::int) from jsonb_array_elements(ts->'points') p)<>1 then raise exception 'ts threads %',ts;end if;
 ts:=dashboard_timeseries('members',current_date-30,current_date,'week');
 if (select sum((p->>'value')::int) from jsonb_array_elements(ts->'points') p)<>9 then raise exception 'ts members %',ts;end if;
 -- range excluding today yields zeros
 o:=dashboard_overview(current_date-400,current_date-300);
 if (o->>'new_members')::int<>0 or (o->>'threads')::int<>0 or o->'checkin_rate'<>'null'::jsonb then raise exception 'old range %',o;end if;
end$$;

-- enable feature flags that have no data: metrics become non-null
select set_feature_flag('notifications',true);
select set_feature_flag('polls',true);
select set_feature_flag('event_feedback',true);
select set_feature_flag('content_reports',true);
select set_feature_flag('talk_proposals',true);
select set_feature_flag('member_hosted_events',true);
select set_feature_flag('event_waitlist',true);
do $$declare o jsonb;begin
 o:=dashboard_overview(current_date-30,current_date);
 if (o->'polls'->>'created')::int<>0 or (o->'reports'->>'opened')::int<>0 or (o->>'waitlisted')::int<>0 or o->'talk_proposals'<>'{}'::jsonb
  or o->'hosted_event_requests'<>'{}'::jsonb or (o->'notifications'->>'sent')::int is null or o->'feedback'->'average_rating'<>'null'::jsonb then raise exception 'flag-on metrics %',o;end if;
end$$;
rollback;
