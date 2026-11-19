\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000005a1','cr-admin@example.test'),
('00000000-0000-4000-8000-0000000005a2','cr-author@example.test'),
('00000000-0000-4000-8000-0000000005a3','cr-reporter@example.test'),
('00000000-0000-4000-8000-0000000005a4','cr-other@example.test'),
('00000000-0000-4000-8000-0000000005a5','cr-unverified@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000005a1';
update profiles set passcode_verified=true where id in ('00000000-0000-4000-8000-0000000005a2','00000000-0000-4000-8000-0000000005a3','00000000-0000-4000-8000-0000000005a4');
insert into spaces(id,owner_id,title,summary,visibility) values
('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000005a2','CR Public','Summary','public'),
('50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000005a2','CR Private','Secret','private');
insert into discussion_threads(id,space_id,author_id,title,body) values
('51000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000005a2','Thread','Body'),
('51000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000005a2','PrivThread','Body');
insert into discussion_replies(id,thread_id,author_id,body) values
('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000005a4','Reply');
insert into space_qa(id,space_id,author_id,question_text) values('53000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000005a2','Question');
insert into pain_points(id,proposer_id,title,scenario) values('54000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000005a2','Pain','Scenario');
-- 21 extra pain points by author for the rate-limit test
insert into pain_points(proposer_id,title,scenario) select '00000000-0000-4000-8000-0000000005a2','P'||g,'S' from generate_series(1,21) g;

-- Flag OFF: RPCs denied, moderation rows inert
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a3',true);
do $$begin
 begin perform report_content('thread','51000000-0000-4000-8000-000000000001','spam');raise exception 'Reported while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
do $$begin
 begin perform moderate_content('thread','51000000-0000-4000-8000-000000000001',true);raise exception 'Moderated while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform resolve_report(gen_random_uuid(),'dismissed');raise exception 'Resolved while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform admin_report_queue();raise exception 'Queue while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
-- a hidden row inserted behind the flag's back must be ignored while off
reset role;
insert into content_moderation(target_type,target_id,hidden) values('thread','51000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a4',true);
do $$begin
 if not exists(select 1 from discussion_threads where id='51000000-0000-4000-8000-000000000001') then raise exception 'Hidden flag applied while feature off';end if;
 if not exists(select 1 from discussion_threads_read where id='51000000-0000-4000-8000-000000000001') then raise exception 'View hid content while feature off';end if;
 if exists(select 1 from content_moderation) then raise exception 'Member read moderation table';end if;
end$$;
reset role;
delete from content_moderation;

-- Enable flags
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
select set_feature_flag('content_reports',true);
select set_feature_flag('notifications',true);

-- Unverified denied
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a5',true);
do $$begin
 begin perform report_content('thread','51000000-0000-4000-8000-000000000001','spam');raise exception 'Unverified reported';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
end$$;

-- Reporter
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a3',true);
do $$declare r uuid;begin
 r:=report_content('thread','51000000-0000-4000-8000-000000000001','spam','重複洗版');
 if r is null then raise exception 'No report id';end if;
 begin perform report_content('thread','51000000-0000-4000-8000-000000000001','harassment');raise exception 'Duplicate open report';exception when raise_exception then if sqlerrm<>'ALREADY_REPORTED' then raise;end if;end;
 begin perform report_content('thread','51000000-0000-4000-8000-000000000002','spam');raise exception 'Reported invisible private thread';exception when raise_exception then if sqlerrm<>'TARGET_NOT_FOUND' then raise;end if;end;
 begin perform report_content('space','50000000-0000-4000-8000-000000000002','spam');raise exception 'Reported private space';exception when raise_exception then if sqlerrm<>'TARGET_NOT_FOUND' then raise;end if;end;
 begin perform report_content('thread',gen_random_uuid(),'spam');raise exception 'Reported missing target';exception when raise_exception then if sqlerrm<>'TARGET_NOT_FOUND' then raise;end if;end;
 begin perform report_content('nope','51000000-0000-4000-8000-000000000001','spam');raise exception 'Bad type';exception when raise_exception then if sqlerrm<>'INVALID_TARGET_TYPE' then raise;end if;end;
 begin perform report_content('reply','52000000-0000-4000-8000-000000000001','nope');raise exception 'Bad reason';exception when raise_exception then if sqlerrm<>'INVALID_REASON' then raise;end if;end;
 begin perform report_content('reply','52000000-0000-4000-8000-000000000001','other',repeat('x',501));raise exception 'Long detail';exception when raise_exception then if sqlerrm<>'DETAIL_TOO_LONG' then raise;end if;end;
 begin perform report_content('reply','52000000-0000-4000-8000-000000000001','other','病患王小明 0912-345-678');raise exception 'PII detail';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 perform report_content('reply','52000000-0000-4000-8000-000000000001','harassment');
 perform report_content('qa','53000000-0000-4000-8000-000000000001','incorrect');
 perform report_content('pain_point','54000000-0000-4000-8000-000000000001','pii');
 perform report_content('space','50000000-0000-4000-8000-000000000001','other');
 if(select count(*) from content_reports)<>5 then raise exception 'Reporter should see exactly own 5 reports';end if;
 begin insert into content_reports(reporter_id,target_type,target_id,reason) values(auth.uid(),'qa',gen_random_uuid(),'spam');raise exception 'Direct insert';exception when insufficient_privilege then null;end;
 begin update content_reports set status='dismissed';raise exception 'Direct update';exception when insufficient_privilege then null;end;
 begin perform moderate_content('thread','51000000-0000-4000-8000-000000000001',true);raise exception 'Member moderated';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform resolve_report(r,'dismissed');raise exception 'Member resolved';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform admin_report_queue();raise exception 'Member read queue';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 if exists(select 1 from moderation_events) or exists(select 1 from content_moderation) then raise exception 'Member read audit tables';end if;
end$$;
-- Other member cannot see reporter's reports; author cannot report own content
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a4',true);
do $$begin
 if exists(select 1 from content_reports) then raise exception 'Other member read reports';end if;
 begin perform report_content('reply','52000000-0000-4000-8000-000000000001','spam');raise exception 'Reported own reply';exception when raise_exception then if sqlerrm<>'CANNOT_REPORT_OWN' then raise;end if;end;
 perform report_content('thread','51000000-0000-4000-8000-000000000001','spam');
end$$;

-- Admin sees all, queue has previews, dismiss one
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
do $$declare q jsonb;rid uuid;begin
 if(select count(*) from content_reports)<>6 then raise exception 'Admin should see all reports';end if;
 q:=admin_report_queue('open');
 if jsonb_array_length(q)<>6 then raise exception 'Queue size %',jsonb_array_length(q);end if;
 if not exists(select 1 from jsonb_array_elements(q) e where e->'preview'->>'body'='Body' and e->>'reporter_name' is not null) then raise exception 'Preview missing';end if;
 select id into rid from content_reports where target_type='pain_point';
 begin perform resolve_report(rid,'open');raise exception 'Bad status';exception when raise_exception then if sqlerrm<>'INVALID_STATUS' then raise;end if;end;
 perform resolve_report(rid,'dismissed','查證後無違規');
 begin perform resolve_report(rid,'actioned');raise exception 'Resolved twice';exception when raise_exception then if sqlerrm<>'ALREADY_RESOLVED' then raise;end if;end;
 if not exists(select 1 from moderation_events where report_id=rid and action='dismiss' and actor_id=auth.uid()) then raise exception 'Dismiss audit missing';end if;
end$$;
reset role;
do $$begin
 if not exists(select 1 from notifications where user_id='00000000-0000-4000-8000-0000000005a3' and type='report_handled' and title='您的檢舉已處理') then raise exception 'Reporter not notified';end if;
end$$;
-- dismissed report allows re-reporting later (unique only on open)
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a3',true);
do $$begin perform report_content('pain_point','54000000-0000-4000-8000-000000000001','spam');end$$;

-- Hide thread + qa
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
do $$declare res jsonb;begin
 res:=moderate_content('thread','51000000-0000-4000-8000-000000000001',true,'洗版');
 if (res->>'reports_closed')::int<>2 then raise exception 'Expected 2 reports closed, got %',res;end if;
 perform moderate_content('qa','53000000-0000-4000-8000-000000000001',true);
 begin perform moderate_content('thread',gen_random_uuid(),true);raise exception 'Moderated missing target';exception when raise_exception then if sqlerrm<>'TARGET_NOT_FOUND' then raise;end if;end;
 if(select count(*) from moderation_events where action='hide')<>2 then raise exception 'Hide audit rows';end if;
end$$;
reset role;
do $$begin
 if not exists(select 1 from notifications where user_id='00000000-0000-4000-8000-0000000005a2' and type='content_hidden' and title='您的內容已被管理員隱藏' and coalesce(body,'') not like '%Body%') then raise exception 'Author not notified';end if;
 if(select count(*) from notifications where type='report_handled' and user_id in('00000000-0000-4000-8000-0000000005a3','00000000-0000-4000-8000-0000000005a4'))<3 then raise exception 'Reporters not notified on hide';end if;
end$$;
-- other member: hidden thread, its replies (via parent) and hidden QA invisible; views too
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a4',true);
do $$begin
 if exists(select 1 from discussion_threads where id='51000000-0000-4000-8000-000000000001') then raise exception 'Hidden thread visible to member';end if;
 if exists(select 1 from discussion_threads_read where id='51000000-0000-4000-8000-000000000001') then raise exception 'Hidden thread visible via view';end if;
 if exists(select 1 from discussion_replies_read where thread_id='51000000-0000-4000-8000-000000000001') then raise exception 'Reply of hidden thread visible via view';end if;
 if exists(select 1 from qa_public where id='53000000-0000-4000-8000-000000000001') then raise exception 'Hidden QA visible via view';end if;
 if exists(select 1 from discussion_replies where id='52000000-0000-4000-8000-000000000001') then raise exception 'Reply of hidden thread visible';end if;
 begin perform report_content('thread','51000000-0000-4000-8000-000000000001','spam');raise exception 'Reported hidden thread';exception when raise_exception then if sqlerrm<>'TARGET_NOT_FOUND' then raise;end if;end;
 if exists(select 1 from moderation_hidden_visible('thread',array['51000000-0000-4000-8000-000000000001']::uuid[])) then raise exception 'Non-author sees hidden marker';end if;
end$$;
-- author sees own hidden content; admin sees it too
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a2',true);
do $$begin
 if not exists(select 1 from discussion_threads where id='51000000-0000-4000-8000-000000000001') then raise exception 'Author cannot see own hidden thread';end if;
 if not exists(select 1 from discussion_threads_read where id='51000000-0000-4000-8000-000000000001') then raise exception 'Author cannot see own hidden thread via view';end if;
 if not exists(select 1 from qa_public where id='53000000-0000-4000-8000-000000000001') then raise exception 'Author cannot see own hidden QA via view';end if;
 if not exists(select 1 from moderation_hidden_visible('thread',array['51000000-0000-4000-8000-000000000001']::uuid[])) then raise exception 'Author hidden marker missing';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
do $$begin
 if not exists(select 1 from discussion_threads where id='51000000-0000-4000-8000-000000000001') then raise exception 'Admin cannot see hidden thread';end if;
 if not exists(select 1 from qa_public where id='53000000-0000-4000-8000-000000000001') then raise exception 'Admin cannot see hidden QA';end if;
 if jsonb_array_length(admin_moderation_history())<5 then raise exception 'History too short';end if;
end$$;
-- hiding the public space hides it from others, but not from the owner
select moderate_content('space','50000000-0000-4000-8000-000000000001',true,null);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a4',true);
do $$begin
 if exists(select 1 from spaces where id='50000000-0000-4000-8000-000000000001') then raise exception 'Hidden space visible';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a2',true);
do $$begin if not exists(select 1 from spaces where id='50000000-0000-4000-8000-000000000001') then raise exception 'Owner lost own hidden space';end if;end$$;
-- service role helper
reset role;set local role service_role;
do $$begin
 if not exists(select 1 from moderation_hidden_ids('thread',array['51000000-0000-4000-8000-000000000001']::uuid[],'00000000-0000-4000-8000-0000000005a4')) then raise exception 'Helper missed hidden id';end if;
 if exists(select 1 from moderation_hidden_ids('thread',array['51000000-0000-4000-8000-000000000001']::uuid[],'00000000-0000-4000-8000-0000000005a2')) then raise exception 'Helper hid from author';end if;
 if exists(select 1 from moderation_hidden_ids('thread',array['51000000-0000-4000-8000-000000000001']::uuid[],'00000000-0000-4000-8000-0000000005a1')) then raise exception 'Helper hid from admin';end if;
end$$;
reset role;
-- unhide restores visibility
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
select moderate_content('space','50000000-0000-4000-8000-000000000001',false,'誤判');
select moderate_content('thread','51000000-0000-4000-8000-000000000001',false,'誤判');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a4',true);
do $$begin
 if not exists(select 1 from discussion_threads_read where id='51000000-0000-4000-8000-000000000001') then raise exception 'Unhide did not restore';end if;
 if not exists(select 1 from spaces where id='50000000-0000-4000-8000-000000000001') then raise exception 'Unhide space did not restore';end if;
end$$;

-- Rate limit: 20 reports per rolling day
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a3',true);
do $$declare n integer;ids uuid[];x uuid;begin
 select count(*) into n from content_reports where reporter_id=auth.uid();
 select array_agg(id) into ids from(select id from pain_points where title like 'P%' order by title) s;
 foreach x in array ids loop
  begin perform report_content('pain_point',x,'spam');n:=n+1;
  exception when raise_exception then if sqlerrm='REPORT_RATE_LIMITED' then exit;else raise;end if;end;
 end loop;
 if n<>20 then raise exception 'Rate limit hit at % reports',n;end if;
end$$;

-- Flag OFF again: hiding ignored, data intact
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a1',true);
select moderate_content('thread','51000000-0000-4000-8000-000000000001',true);
select set_feature_flag('content_reports',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000005a4',true);
do $$begin
 if not exists(select 1 from discussion_threads_read where id='51000000-0000-4000-8000-000000000001') then raise exception 'Hidden flag applied after turning feature off';end if;
 if exists(select 1 from content_reports) then raise exception 'Reports readable while off';end if;
end$$;
reset role;
do $$begin if not exists(select 1 from content_moderation where hidden) then raise exception 'Data deleted when flag off';end if;end$$;
rollback;
