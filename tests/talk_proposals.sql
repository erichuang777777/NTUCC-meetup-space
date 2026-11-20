\set ON_ERROR_STOP on
begin;
-- b1 admin, b2 proposer, b3 other member, b4 unverified
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000b1','tp-admin@example.test'),
('00000000-0000-4000-8000-0000000000b2','tp-member@example.test'),
('00000000-0000-4000-8000-0000000000b3','tp-member2@example.test'),
('00000000-0000-4000-8000-0000000000b4','tp-unverified@example.test');
update profiles set role='admin',passcode_verified=true,display_name='Admin A' where id='00000000-0000-4000-8000-0000000000b1';
update profiles set passcode_verified=true,display_name='Member B' where id='00000000-0000-4000-8000-0000000000b2';
update profiles set passcode_verified=true,display_name='Member C' where id='00000000-0000-4000-8000-0000000000b3';
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published,agenda) values
('f8000000-0000-4000-8000-000000000001','徵稿測試活動',now()+interval '10 days',now()+interval '10 days 2 hours',now()+interval '9 days',30,true,'[{"time":"18:00","title":"開場"}]'),
('f8000000-0000-4000-8000-000000000002','滿議程活動',now()+interval '11 days',now()+interval '11 days 2 hours',now()+interval '9 days',30,true,
  (select jsonb_agg(jsonb_build_object('time','10:'||lpad(i::text,2,'0'),'title','t'||i)) from generate_series(1,30) i));
insert into pain_points(id,proposer_id,title,scenario) values
('f8000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b3','交班很慢','每天要重複輸入'),
('f8000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000b3','報表重複','每週整理');
create function public.t_expect(p_sql text,p_err text) returns void language plpgsql as $$begin
 begin execute p_sql;exception when others then if sqlerrm=p_err or (p_err='DENIED' and sqlstate='42501') then return;end if;raise exception 'Expected % but got % (%)',p_err,sqlerrm,p_sql;end;
 raise exception 'Expected % but statement succeeded (%)',p_err,p_sql;
end$$;
grant execute on function public.t_expect(text,text) to anon,authenticated,service_role;
create temp table ids(name text primary key,id uuid);
grant all on ids to authenticated,service_role;

-- flag OFF: everything denied
set local role service_role;
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'t','a','實戰展示',10,null,null)$q$,'FEATURE_DISABLED');
select t_expect($q$select submit_talk_proposal('00000000-0000-4000-8000-0000000000b2',gen_random_uuid())$q$,'FEATURE_DISABLED');
select t_expect($q$select withdraw_talk_proposal('00000000-0000-4000-8000-0000000000b2',gen_random_uuid())$q$,'FEATURE_DISABLED');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select t_expect($q$select review_talk_proposal(gen_random_uuid(),'accepted',null)$q$,'FEATURE_DISABLED');
select t_expect($q$select schedule_talk_proposal(gen_random_uuid(),gen_random_uuid())$q$,'FEATURE_DISABLED');
select t_expect($q$select talk_proposals_admin_list()$q$,'FEATURE_DISABLED');
select t_expect($q$select list_accepted_talks()$q$,'FEATURE_DISABLED');
select t_expect($q$select pain_point_claims(gen_random_uuid())$q$,'FEATURE_DISABLED');
select t_expect($q$select * from pain_point_claim_counts()$q$,'FEATURE_DISABLED');
select set_feature_flag('talk_proposals',true);
select set_feature_flag('notifications',true);

-- privileges: authenticated cannot call service-only RPCs or write the table
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect($q$select upsert_talk_proposal(auth.uid(),null,'t','a','實戰展示',10,null,null)$q$,'DENIED');
select t_expect($q$select submit_talk_proposal(auth.uid(),gen_random_uuid())$q$,'DENIED');
select t_expect($q$select withdraw_talk_proposal(auth.uid(),gen_random_uuid())$q$,'DENIED');
select t_expect($q$insert into talk_proposals(proposer_id,title,abstract,category_tag,duration_minutes) values(auth.uid(),'x','y','實戰展示',10)$q$,'DENIED');
select t_expect($q$update talk_proposals set status='accepted'$q$,'DENIED');
-- anon has no access
reset role;set local role anon;
select t_expect($q$select count(*) from talk_proposals$q$,'DENIED');
select t_expect($q$select list_accepted_talks()$q$,'DENIED');

-- creation (service_role, as talk-proposals-api does)
reset role;set local role service_role;
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b4',null,'t','a','實戰展示',10,null,null)$q$,'MEMBER_REQUIRED');
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'','a','實戰展示',10,null,null)$q$,'INVALID_PROPOSAL');
select t_expect(format($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,%L,'a','實戰展示',10,null,null)$q$,repeat('字',121)),'INVALID_PROPOSAL');
select t_expect(format($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'t',%L,'實戰展示',10,null,null)$q$,repeat('字',1501)),'INVALID_PROPOSAL');
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'t','a','其他',10,null,null)$q$,'INVALID_PROPOSAL');
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'t','a','實戰展示',7,null,null)$q$,'INVALID_PROPOSAL');
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'t','a','實戰展示',10,gen_random_uuid(),null)$q$,'EVENT_NOT_FOUND');
select t_expect($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'t','a','實戰展示',10,null,gen_random_uuid())$q$,'PAIN_POINT_NOT_FOUND');
insert into ids select 'a',(upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'AI 寫交班摘要','我們做了一個小工具','實戰展示',10,'f8000000-0000-4000-8000-000000000001','f8000000-0000-4000-8000-0000000000a1')->>'id')::uuid;
insert into ids select 'b',(upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',null,'踩坑：報表','別這樣做','踩坑避雷',5,null,'f8000000-0000-4000-8000-0000000000a1')->>'id')::uuid;
insert into ids select 'c',(upsert_talk_proposal('00000000-0000-4000-8000-0000000000b3',null,'他人草稿','x','實戰展示',15,null,null)->>'id')::uuid;
do $$begin if(select status from talk_proposals where id=(select id from ids where name='a'))<>'draft' then raise exception 'not draft';end if;end$$;
-- draft is editable by owner only
select t_expect(format($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b3',%L,'hijack','x','實戰展示',10,null,null)$q$,(select id from ids where name='a')),'PROPOSAL_NOT_FOUND');
select t_expect(format($q$select submit_talk_proposal('00000000-0000-4000-8000-0000000000b3',%L)$q$,(select id from ids where name='a')),'PROPOSAL_NOT_FOUND');
select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',(select id from ids where name='a'),'AI 寫交班摘要（改）','我們做了一個小工具','實戰展示',15,'f8000000-0000-4000-8000-000000000001','f8000000-0000-4000-8000-0000000000a1');
do $$begin if(select title from talk_proposals where id=(select id from ids where name='a'))<>'AI 寫交班摘要（改）' then raise exception 'edit lost';end if;end$$;

-- visibility to proposer / others / admin (drafts invisible to admin)
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin if(select count(*) from talk_proposals)<>2 then raise exception 'proposer should see own 2';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$begin if(select count(*) from talk_proposals)<>1 or exists(select 1 from talk_proposals where proposer_id<>auth.uid()) then raise exception 'member sees others rows';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$begin if(select count(*) from talk_proposals)<>0 then raise exception 'admin sees drafts';end if;end$$;
select t_expect(format($q$select review_talk_proposal(%L,'accepted',null)$q$,(select id from ids where name='a')),'INVALID_TRANSITION');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b4',true);
do $$begin if(select count(*) from talk_proposals)<>0 then raise exception 'unverified sees rows';end if;end$$;
select t_expect($q$select list_accepted_talks()$q$,'MEMBER_REQUIRED');

-- submit
reset role;set local role service_role;
select submit_talk_proposal('00000000-0000-4000-8000-0000000000b2',(select id from ids where name='a'));
select submit_talk_proposal('00000000-0000-4000-8000-0000000000b2',(select id from ids where name='b'));
select t_expect(format($q$select submit_talk_proposal('00000000-0000-4000-8000-0000000000b2',%L)$q$,(select id from ids where name='a')),'INVALID_TRANSITION');
select t_expect(format($q$select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',%L,'late edit','x','實戰展示',10,null,null)$q$,(select id from ids where name='a')),'NOT_EDITABLE');

reset role;set local role authenticated;
-- members cannot review; admin sees submitted
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect(format($q$select review_talk_proposal(%L,'accepted',null)$q$,(select id from ids where name='a')),'ADMIN_REQUIRED');
select t_expect($q$select schedule_talk_proposal(gen_random_uuid(),gen_random_uuid())$q$,'ADMIN_REQUIRED');
select t_expect($q$select talk_proposals_admin_list()$q$,'ADMIN_REQUIRED');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$begin
 if(select count(*) from talk_proposals)<>2 then raise exception 'admin should see 2 submitted';end if;
 if jsonb_array_length(talk_proposals_admin_list())<>2 or talk_proposals_admin_list()->0->>'proposer_name'<>'Member B' then raise exception 'admin list wrong';end if;
end$$;
-- review rules
select t_expect(format($q$select review_talk_proposal(%L,'scheduled',null)$q$,(select id from ids where name='a')),'INVALID_STATUS');
select t_expect(format($q$select review_talk_proposal(%L,'returned','')$q$,(select id from ids where name='b')),'NOTE_REQUIRED');
select t_expect(format($q$select review_talk_proposal(%L,'returned','請補充 A123456789')$q$,(select id from ids where name='b')),'PII_DETECTED');
select t_expect($q$select review_talk_proposal(gen_random_uuid(),'accepted',null)$q$,'PROPOSAL_NOT_FOUND');
select review_talk_proposal((select id from ids where name='b'),'returned','請補充具體做法');
do $$declare r talk_proposals;begin
 select * into r from talk_proposals where id=(select id from ids where name='b');
 if r.status<>'returned' or r.reviewer_note<>'請補充具體做法' or r.reviewed_by<>auth.uid() or r.reviewed_at is null then raise exception 'review not recorded';end if;
end$$;
select t_expect(format($q$select review_talk_proposal(%L,'accepted',null)$q$,(select id from ids where name='b')),'INVALID_TRANSITION');
-- scheduling needs accepted state
select t_expect(format($q$select schedule_talk_proposal(%L,'f8000000-0000-4000-8000-000000000001')$q$,(select id from ids where name='a')),'INVALID_TRANSITION');
-- claims: submitted does not count
do $$begin if pain_point_claims('f8000000-0000-4000-8000-0000000000a1')<>0 then raise exception 'submitted counted';end if;end$$;
select review_talk_proposal((select id from ids where name='a'),'accepted',null);
do $$begin
 if pain_point_claims('f8000000-0000-4000-8000-0000000000a1')<>1 then raise exception 'accepted not counted';end if;
 if pain_point_claims('f8000000-0000-4000-8000-0000000000a2')<>0 then raise exception 'other pain counted';end if;
end$$;
-- notifications (proposer gets exactly the review notices)
reset role;
do $$begin
 if(select count(*) from notifications where type='talk_proposal_reviewed' and user_id='00000000-0000-4000-8000-0000000000b2')<>2 then raise exception 'review notifications missing';end if;
 if exists(select 1 from notifications where type='talk_proposal_reviewed' and user_id<>'00000000-0000-4000-8000-0000000000b2') then raise exception 'wrong notify target';end if;
end$$;
set local role authenticated;

-- returned proposal: proposer edits and resubmits, then gets accepted
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin if(select reviewer_note from talk_proposals where id=(select id from ids where name='b'))<>'請補充具體做法' then raise exception 'proposer cannot see note';end if;end$$;
reset role;set local role service_role;
select upsert_talk_proposal('00000000-0000-4000-8000-0000000000b2',(select id from ids where name='b'),'踩坑：報表（補充）','補上做法','踩坑避雷',5,null,'f8000000-0000-4000-8000-0000000000a1');
select submit_talk_proposal('00000000-0000-4000-8000-0000000000b2',(select id from ids where name='b'));
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select review_talk_proposal((select id from ids where name='b'),'accepted','很棒');
do $$begin if pain_point_claims('f8000000-0000-4000-8000-0000000000a1')<>2 then raise exception 'two claims expected';end if;end$$;

-- withdraw: claims drop, no revival
reset role;set local role service_role;
select withdraw_talk_proposal('00000000-0000-4000-8000-0000000000b2',(select id from ids where name='b'));
select t_expect(format($q$select withdraw_talk_proposal('00000000-0000-4000-8000-0000000000b2',%L)$q$,(select id from ids where name='b')),'INVALID_TRANSITION');
select t_expect(format($q$select submit_talk_proposal('00000000-0000-4000-8000-0000000000b2',%L)$q$,(select id from ids where name='b')),'INVALID_TRANSITION');
select t_expect(format($q$select withdraw_talk_proposal('00000000-0000-4000-8000-0000000000b3',%L)$q$,(select id from ids where name='a')),'PROPOSAL_NOT_FOUND');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$begin
 if pain_point_claims('f8000000-0000-4000-8000-0000000000a1')<>1 then raise exception 'withdrawn still counted';end if;
 if(select claims from pain_point_claim_counts() where pain_point_id='f8000000-0000-4000-8000-0000000000a1')<>1 then raise exception 'batch counts wrong';end if;
end$$;

-- other verified members see only the transparency list (no abstract/note)
do $$declare r jsonb;begin
 r:=list_accepted_talks();
 if jsonb_array_length(r)<>1 or r->0->>'title'<>'AI 寫交班摘要（改）' or r->0->>'proposer_name'<>'Member B' then raise exception 'accepted list wrong %',r;end if;
 if r->0 ? 'abstract' or r->0 ? 'reviewer_note' then raise exception 'accepted list leaks %',r;end if;
 if exists(select 1 from talk_proposals where proposer_id<>auth.uid()) then raise exception 'direct select leaks';end if;
end$$;

-- schedule
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect(format($q$select schedule_talk_proposal(%L,'f8000000-0000-4000-8000-000000000001')$q$,(select id from ids where name='a')),'ADMIN_REQUIRED');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select t_expect(format($q$select schedule_talk_proposal(%L,gen_random_uuid())$q$,(select id from ids where name='a')),'EVENT_NOT_FOUND');
select t_expect(format($q$select schedule_talk_proposal(%L,'f8000000-0000-4000-8000-000000000002')$q$,(select id from ids where name='a')),'AGENDA_FULL');
select schedule_talk_proposal((select id from ids where name='a'),'f8000000-0000-4000-8000-000000000001');
do $$declare r talk_proposals;begin
 select * into r from talk_proposals where id=(select id from ids where name='a');
 if r.status<>'scheduled' or r.scheduled_event_id<>'f8000000-0000-4000-8000-000000000001' then raise exception 'not scheduled';end if;
end$$;
reset role;
do $$declare ag jsonb;begin
 select agenda into ag from public_events where id='f8000000-0000-4000-8000-000000000001';
 if jsonb_array_length(ag)<>2 or ag->1->>'title'<>'AI 寫交班摘要（改）' or ag->1->>'speaker'<>'Member B' or ag->1->>'time' !~ '^[0-9]{2}:[0-9]{2}$' then raise exception 'agenda wrong %',ag;end if;
 if(select count(*) from jsonb_object_keys(ag->1))<>3 then raise exception 'agenda item has extra keys';end if;
 if(select count(*) from public_events where id='f8000000-0000-4000-8000-000000000002' and jsonb_array_length(agenda)=30)<>1 then raise exception 'full agenda mutated';end if;
end$$;
set local role authenticated;
select t_expect(format($q$select schedule_talk_proposal(%L,'f8000000-0000-4000-8000-000000000001')$q$,(select id from ids where name='a')),'INVALID_TRANSITION');
select t_expect(format($q$select review_talk_proposal(%L,'returned','x')$q$,(select id from ids where name='a')),'INVALID_TRANSITION');
-- scheduled talks still count for claims and cannot be withdrawn by the proposer
reset role;set local role service_role;
select t_expect(format($q$select withdraw_talk_proposal('00000000-0000-4000-8000-0000000000b2',%L)$q$,(select id from ids where name='a')),'INVALID_TRANSITION');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$begin if pain_point_claims('f8000000-0000-4000-8000-0000000000a1')<>1 then raise exception 'scheduled not counted';end if;end$$;

-- turning the flag off hides rows but keeps data
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select set_feature_flag('talk_proposals',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin if(select count(*) from talk_proposals)<>0 then raise exception 'rows visible while off';end if;end$$;
reset role;
do $$begin if(select count(*) from talk_proposals)<>3 then raise exception 'data lost when flag off';end if;end$$;
rollback;
select 'talk_proposals tests passed' as result;
