\set ON_ERROR_STOP on
begin;
-- b1 admin, b2/b6 checked-in members, b3 registered but not checked in, b4 unverified, b5 event staff, b7 outsider member
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000b1','fb-admin@example.test'),
('00000000-0000-4000-8000-0000000000b2','fb-in@example.test'),
('00000000-0000-4000-8000-0000000000b3','fb-notin@example.test'),
('00000000-0000-4000-8000-0000000000b4','fb-unverified@example.test'),
('00000000-0000-4000-8000-0000000000b5','fb-staff@example.test'),
('00000000-0000-4000-8000-0000000000b6','fb-in2@example.test'),
('00000000-0000-4000-8000-0000000000b7','fb-outsider@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000b1';
update profiles set passcode_verified=true where id in ('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000b5','00000000-0000-4000-8000-0000000000b6','00000000-0000-4000-8000-0000000000b7');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values('f1000000-0000-4000-8000-000000000001','回饋測試',now()-interval '3 hours',now()-interval '1 hour',now()-interval '4 hours',10,true);
insert into event_registrations(event_id,user_id,status,checked_in_at) values
('f1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000b2','registered',now()-interval '2 hours'),
('f1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000b3','registered',null),
('f1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000b6','registered',now()-interval '2 hours');
insert into event_staff values('f1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000b5');

-- flag OFF: everything denied, no data written
set local role service_role;
do $$begin
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[{"id":"q1","type":"rating","label":"x"}]',null,now()+interval '1 day',false);raise exception 'upsert while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{}');raise exception 'submit while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$begin
 begin perform event_feedback_admin_list();raise exception 'list while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform publish_event_feedback('f1000000-0000-4000-8000-000000000001');raise exception 'publish while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform event_feedback_summary('f1000000-0000-4000-8000-000000000001');raise exception 'summary while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform event_feedback_export('f1000000-0000-4000-8000-000000000001');raise exception 'export while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
-- privileges: authenticated cannot call service-only functions or write tables
do $$begin
 begin perform submit_event_feedback(auth.uid(),'f1000000-0000-4000-8000-000000000001','{}');raise exception 'authenticated submit';exception when insufficient_privilege then null;end;
 begin perform upsert_event_feedback_form(auth.uid(),'f1000000-0000-4000-8000-000000000001','[]',null,now(),false);raise exception 'authenticated upsert';exception when insufficient_privilege then null;end;
 begin insert into event_feedback_responses(form_id,respondent_id,answers) values(gen_random_uuid(),auth.uid(),'{}');raise exception 'direct insert';exception when insufficient_privilege then null;end;
 begin insert into event_feedback_forms(event_id,opens_at,closes_at) values('f1000000-0000-4000-8000-000000000001',now(),now()+interval '1 day');raise exception 'direct form insert';exception when insufficient_privilege then null;end;
end$$;
-- admin enables the flags
select set_feature_flag('event_feedback',true);
select set_feature_flag('notifications',true);

-- form creation via service_role (as event-feedback-api does)
reset role;set local role service_role;
do $$declare r jsonb;big jsonb;begin
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','[{"id":"q1","type":"rating","label":"x"}]',null,now()+interval '1 day',false);raise exception 'member upsert';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 -- structure validation
 select jsonb_agg(jsonb_build_object('id','q'||i,'type','text','label','l')) into big from generate_series(1,16) i;
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001',big,null,now()+interval '1 day',false);raise exception '16 questions';exception when raise_exception then if sqlerrm<>'INVALID_QUESTIONS' then raise;end if;end;
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[]',null,now()+interval '1 day',false);raise exception 'empty';exception when raise_exception then if sqlerrm<>'INVALID_QUESTIONS' then raise;end if;end;
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[{"id":"q1","type":"bogus","label":"x"}]',null,now()+interval '1 day',false);raise exception 'bad type';exception when raise_exception then if sqlerrm<>'INVALID_QUESTIONS' then raise;end if;end;
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[{"id":"q1","type":"single","label":"x","options":["a"]}]',null,now()+interval '1 day',false);raise exception 'one option';exception when raise_exception then if sqlerrm<>'INVALID_QUESTIONS' then raise;end if;end;
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[{"id":"q1","type":"rating","label":"x"},{"id":"q1","type":"text","label":"y"}]',null,now()+interval '1 day',false);raise exception 'dup id';exception when raise_exception then if sqlerrm<>'INVALID_QUESTIONS' then raise;end if;end;
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[{"id":"q1","type":"rating","label":"x"}]',null,now()-interval '5 hours',false);raise exception 'bad window';exception when raise_exception then if sqlerrm<>'INVALID_WINDOW' then raise;end if;end;
 r:=upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001',
  '[{"id":"overall","type":"rating","label":"整體滿意度","required":true},{"id":"fmt","type":"single","label":"形式","options":["線上","實體"],"required":false},{"id":"note","type":"text","label":"建議"}]',
  now()-interval '30 minutes',now()+interval '1 day',true);
 if r->>'published_at' is not null then raise exception 'new form must be unpublished';end if;
end$$;

-- unpublished: attendee cannot submit, cannot see the form
do $$begin
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":5}');raise exception 'submit unpublished';exception when raise_exception then if sqlerrm<>'FEEDBACK_UNAVAILABLE' then raise;end if;end;
end$$;
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 if exists(select 1 from event_feedback_forms) then raise exception 'attendee saw unpublished form';end if;
 begin perform publish_event_feedback('f1000000-0000-4000-8000-000000000001');raise exception 'member publish';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform event_feedback_summary('f1000000-0000-4000-8000-000000000001');raise exception 'member summary';exception when raise_exception then if sqlerrm<>'STAFF_REQUIRED' then raise;end if;end;
end$$;
-- admin publishes: notifies the two checked-in members once
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$declare r jsonb;begin
 r:=publish_event_feedback('f1000000-0000-4000-8000-000000000001');
 if (r->>'notified')::int<>2 then raise exception 'notified %',r;end if;
 r:=publish_event_feedback('f1000000-0000-4000-8000-000000000001');
 if (r->>'notified')::int<>0 then raise exception 'republish notified again';end if;
end$$;
reset role;
do $$begin
 if(select count(*) from notifications where type='event_feedback' and title='活動回饋問卷開放填寫')<>2 then raise exception 'Expected 2 notifications';end if;
 if exists(select 1 from notifications where type='event_feedback' and user_id in ('00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000b7')) then raise exception 'Non checked-in notified';end if;
end$$;

-- eligibility and window
set local role service_role;
do $$declare r jsonb;begin
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b3','f1000000-0000-4000-8000-000000000001','{"overall":4}');raise exception 'not checked in submitted';exception when raise_exception then if sqlerrm<>'NOT_ELIGIBLE' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b7','f1000000-0000-4000-8000-000000000001','{"overall":4}');raise exception 'outsider submitted';exception when raise_exception then if sqlerrm<>'NOT_ELIGIBLE' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b4','f1000000-0000-4000-8000-000000000001','{"overall":4}');raise exception 'unverified submitted';exception when raise_exception then if sqlerrm<>'NOT_ELIGIBLE' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"fmt":"實體"}');raise exception 'missing required';exception when raise_exception then if sqlerrm<>'INVALID_ANSWERS' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":6}');raise exception 'rating 6';exception when raise_exception then if sqlerrm<>'INVALID_ANSWERS' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":3.5}');raise exception 'rating fractional';exception when raise_exception then if sqlerrm<>'INVALID_ANSWERS' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":3,"fmt":"火星"}');raise exception 'bad option';exception when raise_exception then if sqlerrm<>'INVALID_ANSWERS' then raise;end if;end;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":3,"zzz":"x"}');raise exception 'unknown key';exception when raise_exception then if sqlerrm<>'INVALID_ANSWERS' then raise;end if;end;
 r:=submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":5,"fmt":"實體","note":"很棒"}');
 if r->>'id' is null then raise exception 'submit failed';end if;
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":1}');raise exception 'duplicate submitted';exception when raise_exception then if sqlerrm<>'ALREADY_SUBMITTED' then raise;end if;end;
 perform submit_event_feedback('00000000-0000-4000-8000-0000000000b6','f1000000-0000-4000-8000-000000000001','{"overall":3,"fmt":"線上"}');
end$$;
reset role;
-- window: not yet open / closed
update event_feedback_forms set opens_at=now()+interval '1 hour',closes_at=now()+interval '2 hours';
set local role service_role;
do $$begin
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":1}');raise exception 'early';exception when raise_exception then if sqlerrm<>'FEEDBACK_NOT_OPEN' then raise;end if;end;
end$$;
reset role;
update event_feedback_forms set opens_at=now()-interval '2 hours',closes_at=now()-interval '1 hour';
set local role service_role;
do $$begin
 begin perform submit_event_feedback('00000000-0000-4000-8000-0000000000b2','f1000000-0000-4000-8000-000000000001','{"overall":1}');raise exception 'late';exception when raise_exception then if sqlerrm<>'FEEDBACK_CLOSED' then raise;end if;end;
end$$;
reset role;
update event_feedback_forms set opens_at=now()-interval '2 hours',closes_at=now()+interval '1 day';

-- respondent reads own response only; not others'; forms locked after responses
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 if(select count(*) from event_feedback_responses)<>1 or exists(select 1 from event_feedback_responses where respondent_id<>auth.uid()) then raise exception 'Respondent sees wrong responses';end if;
 if(select count(*) from event_feedback_forms)<>1 then raise exception 'Attendee cannot read published form';end if;
 if jsonb_array_length(my_event_feedback_forms())<>1 or (my_event_feedback_forms()->0->>'submitted')<>'true' or (my_event_feedback_forms()->0->>'state')<>'open' then raise exception 'my forms wrong %',my_event_feedback_forms();end if;
 begin update event_feedback_responses set answers='{}';raise exception 'direct update';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$begin
 if exists(select 1 from event_feedback_forms) or exists(select 1 from event_feedback_responses) then raise exception 'Not-checked-in sees form/responses';end if;
 if my_event_feedback_forms()<>'[]'::jsonb then raise exception 'Not-checked-in lists form';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b7',true);
do $$begin
 if exists(select 1 from event_feedback_forms) or exists(select 1 from event_feedback_responses) then raise exception 'Outsider sees form/responses';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b4',true);
do $$begin
 if exists(select 1 from event_feedback_forms) then raise exception 'Unverified sees form';end if;
 begin perform my_event_feedback_forms();raise exception 'unverified list';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
end$$;
-- admin cannot read raw responses (only aggregates), staff & admin read summary/export
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$declare s jsonb;x jsonb;begin
 if exists(select 1 from event_feedback_responses) then raise exception 'Admin can read raw responses';end if;
 s:=event_feedback_summary('f1000000-0000-4000-8000-000000000001');
 if (s->>'response_count')::int<>2 or (s->>'eligible_count')::int<>2 then raise exception 'summary counts %',s;end if;
 if (s->'questions'->0->>'average')::numeric<>4.00 or (s->'questions'->0->'distribution'->>'5')::int<>1 or (s->'questions'->0->'distribution'->>'3')::int<>1 then raise exception 'rating summary %',s;end if;
 if (s->'questions'->1->'counts'->>'實體')::int<>1 or (s->'questions'->1->'counts'->>'線上')::int<>1 then raise exception 'single summary %',s;end if;
 if s->'questions'->2->'texts'<>'["很棒"]'::jsonb then raise exception 'text summary %',s;end if;
 if s::text like '%0000000000b2%' or s::text like '%fb-in%' then raise exception 'summary leaks identity';end if;
 x:=event_feedback_export('f1000000-0000-4000-8000-000000000001');
 if (x->>'is_anonymous')<>'true' or jsonb_array_length(x->'rows')<>2 then raise exception 'export shape %',x;end if;
 if x::text like '%respondent%' or x::text like '%submitted_at%' or x::text like '%0000000000b2%' or x::text like '%fb-in%' then raise exception 'anonymous export leaks identity %',x;end if;
 -- locked: cannot change questions once answered
end$$;
reset role;
set local role service_role;
do $$begin
 begin perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001','[{"id":"overall","type":"rating","label":"改"}]',null,now()+interval '1 day',true);raise exception 'edited answered form';exception when raise_exception then if sqlerrm<>'FORM_LOCKED' then raise;end if;end;
 perform upsert_event_feedback_form('00000000-0000-4000-8000-0000000000b1','f1000000-0000-4000-8000-000000000001',(select questions from event_feedback_forms),null,now()+interval '2 days',true);
end$$;
reset role;set local role authenticated;
-- staff of the event can read summary
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b5',true);
do $$begin
 if (event_feedback_summary('f1000000-0000-4000-8000-000000000001')->>'response_count')::int<>2 then raise exception 'staff summary';end if;
 if jsonb_array_length(event_feedback_admin_list())<>1 then raise exception 'staff list';end if;
 if exists(select 1 from event_feedback_responses) then raise exception 'staff reads raw responses';end if;
end$$;
-- non-anonymous export includes respondent
reset role;
update event_feedback_forms set is_anonymous=false;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$declare x jsonb;begin
 x:=event_feedback_export('f1000000-0000-4000-8000-000000000001');
 if (x->>'is_anonymous')<>'false' or not (x->'rows'->0 ? 'respondent_name') then raise exception 'named export missing respondent %',x;end if;
end$$;
-- flag off again: member read paths denied, no data deleted
select set_feature_flag('event_feedback',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 if exists(select 1 from event_feedback_forms) or exists(select 1 from event_feedback_responses) then raise exception 'RLS ignores flag';end if;
 begin perform my_event_feedback_forms();raise exception 'list while off again';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
reset role;
do $$begin
 if(select count(*) from event_feedback_responses)<>2 or(select count(*) from event_feedback_forms)<>1 then raise exception 'Data deleted when flag off';end if;
end$$;
rollback;
