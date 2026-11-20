\set ON_ERROR_STOP on
begin;
-- d1 admin, d2 verified member, d3 unverified, d4 space owner / talk proposer
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000d1','ea-admin@example.test'),
('00000000-0000-4000-8000-0000000000d2','ea-member@example.test'),
('00000000-0000-4000-8000-0000000000d3','ea-unverified@example.test'),
('00000000-0000-4000-8000-0000000000d4','ea-owner@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000d1';
update profiles set passcode_verified=true where id in('00000000-0000-4000-8000-0000000000d2','00000000-0000-4000-8000-0000000000d4');
insert into event_series(id,title,slug) values('e1000000-0000-4000-8000-000000000001','每月 AI Meetup','ea-monthly');
-- E1 public event in series with agenda; E2 members-only event; E3 unpublished event; E4 public event, never archived
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published,audience,series_id,agenda) values
('e1000000-0000-4000-8000-0000000000a1','AI 實戰分享','2030-01-10T10:00:00Z','2030-01-10T12:00:00Z','2030-01-09T10:00:00Z',25,true,'public','e1000000-0000-4000-8000-000000000001','[{"time":"18:00","title":"開場"},{"time":"18:30","title":"LLM 實戰","speaker":"小明"},{"time":"19:00","title":"開場"}]'),
('e1000000-0000-4000-8000-0000000000a2','內部讀書會','2030-02-10T10:00:00Z','2030-02-10T12:00:00Z','2030-02-09T10:00:00Z',25,true,'members',null,'[]'),
('e1000000-0000-4000-8000-0000000000a3','草稿活動','2030-03-10T10:00:00Z','2030-03-10T12:00:00Z','2030-03-09T10:00:00Z',25,false,'public',null,'[]'),
('e1000000-0000-4000-8000-0000000000a4','無回顧活動','2030-04-10T10:00:00Z','2030-04-10T12:00:00Z','2030-04-09T10:00:00Z',25,true,'public',null,'[]');
-- spaces: S1 public, S2 private, S3 public but hidden, S4 public (talk proposer's)
insert into spaces(id,owner_id,title,summary,visibility,created_at) values
('e2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d4','公開展示','摘要一','public','2030-01-01'),
('e2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000d4','私人展示','摘要二','private','2030-01-02'),
('e2000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-0000000000d4','被隱藏展示','摘要三','public','2030-01-03');
-- 7 QA on S1 with distinct upvotes; q0 (highest) is hidden
insert into space_qa(id,space_id,author_id,question_text,upvotes)
select ('e3000000-0000-4000-8000-00000000000'||i)::uuid,'e2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d2','問題 '||i,10-i from generate_series(0,6) i;
insert into space_qa(id,space_id,author_id,question_text,upvotes) values('e3000000-0000-4000-8000-0000000000f1','e2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000d2','私人問題',99);
insert into content_moderation(target_type,target_id,hidden) values('qa','e3000000-0000-4000-8000-000000000000',true),('space','e2000000-0000-4000-8000-000000000003',true);
-- talk scheduled to E1 by d4
insert into talk_proposals(id,proposer_id,title,abstract,category_tag,duration_minutes,status,scheduled_event_id) values
('e4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d4','Agent 踩坑','摘要','踩坑避雷',10,'scheduled','e1000000-0000-4000-8000-0000000000a1');
-- photos: one fully public, one pending, one published on the members-only event
insert into event_photos(id,event_id,user_id,object_path,width,height,byte_size,status,publication_consent,publication_consent_at,audience,reviewed_at) values
('e5000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000d4','e1/p1.png',100,100,1000,'published',true,now(),'public_web',now()),
('e5000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000d4','e1/p2.png',100,100,1000,'pending',false,null,null,null),
('e5000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000d4','e1/p3.png',100,100,1000,'published',true,now(),'public_web',now());
-- anonymous feedback form with 3 responses (text answers must never surface)
insert into event_feedback_forms(id,event_id,questions,opens_at,closes_at,is_anonymous,published_at) values('e6000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-0000000000a1',
 '[{"id":"r1","type":"rating","label":"滿意度"},{"id":"t1","type":"text","label":"建議"}]','2030-01-10T12:00:00Z','2030-01-17T12:00:00Z',true,now());
insert into event_feedback_responses(form_id,respondent_id,answers) values
('e6000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d1','{"r1":5,"t1":"秘密文字甲"}'),
('e6000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d2','{"r1":4,"t1":"秘密文字乙"}'),
('e6000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000d4','{"r1":3}');

-- flag OFF: everything denied, no rows visible
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
do $$begin
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a1');raise exception 'page while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform list_event_archives();raise exception 'list while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[]','{}');raise exception 'save while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform generate_event_archive_draft('e1000000-0000-4000-8000-0000000000a1');raise exception 'draft while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform event_archive_admin_list();raise exception 'admin list while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
reset role;
update feature_flags set enabled=true where key in('event_archive','event_feedback','content_reports');

-- anonymous: no access at all
set local role anon;
do $$begin
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a1');raise exception 'anon page';exception when insufficient_privilege then null;end;
 begin perform list_event_archives();raise exception 'anon list';exception when insufficient_privilege then null;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[]','{}');raise exception 'anon save';exception when insufficient_privilege then null;end;
 begin perform 1 from event_archives;raise exception 'anon table';exception when insufficient_privilege then null;end;
end$$;
reset role;

-- unverified user: members only
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d3',true);
do $$begin
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a1');raise exception 'unverified page';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
 begin perform list_event_archives();raise exception 'unverified list';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
end$$;

-- member: cannot write, nothing published yet
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d2',true);
do $$begin
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[]','{}');raise exception 'member save';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform generate_event_archive_draft('e1000000-0000-4000-8000-0000000000a1');raise exception 'member draft';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform event_archive_admin_list();raise exception 'member admin list';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 if jsonb_array_length(list_event_archives())<>0 then raise exception 'list before publish';end if;
 if exists(select 1 from event_archives) then raise exception 'member reads table';end if;
end$$;

-- admin: draft, validation, save
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
do $$declare d jsonb;begin
 d:=generate_event_archive_draft('e1000000-0000-4000-8000-0000000000a1');
 if d->'highlights' <> '["開場","LLM 實戰（小明）","Agent 踩坑"]'::jsonb then raise exception 'draft highlights %',d->'highlights';end if;
 if d->'related_space_ids' <> '["e2000000-0000-4000-8000-000000000003"]'::jsonb and d->'related_space_ids' <> '["e2000000-0000-4000-8000-000000000001"]'::jsonb then raise exception 'draft related %',d->'related_space_ids';end if;
 -- latest public space of the proposer is hidden (S3), so the draft must not pick it
 if d->'related_space_ids' @> '["e2000000-0000-4000-8000-000000000003"]'::jsonb then raise exception 'draft picked hidden space';end if;
 begin perform generate_event_archive_draft(gen_random_uuid());raise exception 'draft missing event';exception when raise_exception then if sqlerrm<>'EVENT_NOT_FOUND' then raise;end if;end;
 begin perform save_event_archive(gen_random_uuid(),'x','[]','[]','{}');raise exception 'missing event';exception when raise_exception then if sqlerrm<>'EVENT_NOT_FOUND' then raise;end if;end;
 -- https only
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[{"title":"投影片","url":"http://example.com/a"}]','{}');raise exception 'http url';exception when raise_exception then if sqlerrm<>'INVALID_URL' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[{"title":"投影片","url":"javascript:alert(1)"}]','{}');raise exception 'js url';exception when raise_exception then if sqlerrm<>'INVALID_URL' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[{"title":"投影片","url":"https://exa mple.com"}]','{}');raise exception 'space url';exception when raise_exception then if sqlerrm<>'INVALID_URL' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[{"title":"投影片","url":"https://example.com","extra":1}]','{}');raise exception 'extra key';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]',(select jsonb_agg(jsonb_build_object('title','t','url','https://example.com/'||i)) from generate_series(1,21) i),'{}');raise exception '21 links';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 -- limits
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1',repeat('字',3001),'[]','[]','{}');raise exception 'long summary';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x',(select jsonb_agg('h'||i) from generate_series(1,11) i),'[]','{}');raise exception '11 highlights';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[1]','[]','{}');raise exception 'non-string highlight';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[]',(select array_agg(gen_random_uuid()) from generate_series(1,21)));raise exception '21 spaces';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[]','{e2000000-0000-4000-8000-000000000002}');raise exception 'private space';exception when raise_exception then if sqlerrm<>'SPACE_NOT_FOUND' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[]','{e2000000-0000-4000-8000-000000000001,e2000000-0000-4000-8000-000000000001}');raise exception 'dup spaces';exception when raise_exception then if sqlerrm<>'INVALID_ARCHIVE' then raise;end if;end;
 -- PII
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','病患王小明的案例','[]','[]','{}');raise exception 'pii summary';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','["身分證 A123456789"]','[]','{}');raise exception 'pii highlight';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','x','[]','[{"title":"病歷號 12345678","url":"https://example.com"}]','{}');raise exception 'pii title';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 -- save unpublished
 d:=save_event_archive('e1000000-0000-4000-8000-0000000000a1','本場回顧','["亮點一"]','[{"title":"投影片","url":"https://example.com/slides"}]','{e2000000-0000-4000-8000-000000000001,e2000000-0000-4000-8000-000000000003}');
 if (d->>'published')::boolean or d->>'published_at' is not null then raise exception 'saved as published';end if;
 -- admin may preview unpublished archive; hidden space already excluded for admin too
 d:=event_archive_page('e1000000-0000-4000-8000-0000000000a1');
 if (d->>'published')::boolean then raise exception 'preview flag';end if;
 if jsonb_array_length(d->'spaces')<>1 then raise exception 'admin preview shows hidden space';end if;
end$$;

-- member still cannot see the unpublished archive
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d2',true);
do $$begin
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a1');raise exception 'unpublished visible';exception when raise_exception then if sqlerrm<>'ARCHIVE_NOT_FOUND' then raise;end if;end;
 if jsonb_array_length(list_event_archives())<>0 then raise exception 'unpublished listed';end if;
end$$;

-- admin publishes (keeps published_at on re-save), archives for a members-only and a draft event
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
do $$begin
 begin perform save_event_archive('e1000000-0000-4000-8000-0000000000a1','本場回顧','[]','[]','{e2000000-0000-4000-8000-000000000001,e2000000-0000-4000-8000-000000000002}',true);raise exception 'private space published';exception when raise_exception then if sqlerrm<>'SPACE_NOT_FOUND' then raise;end if;end;
end$$;
do $$declare d jsonb;t1 timestamptz;begin
 -- private space in the related list is rejected; use the public ones
 d:=save_event_archive('e1000000-0000-4000-8000-0000000000a1','本場回顧','["亮點一"]','[{"title":"投影片","url":"https://example.com/slides"}]','{e2000000-0000-4000-8000-000000000001,e2000000-0000-4000-8000-000000000003}',true);
 if not (d->>'published')::boolean or d->>'published_at' is null then raise exception 'not published';end if;
 t1:=(d->>'published_at')::timestamptz;
 d:=save_event_archive('e1000000-0000-4000-8000-0000000000a1','本場回顧二','["亮點一"]','[]','{e2000000-0000-4000-8000-000000000001}',true);
 if (d->>'published_at')::timestamptz<>t1 then raise exception 'published_at changed';end if;
 perform save_event_archive('e1000000-0000-4000-8000-0000000000a2','內部回顧','[]','[]','{}',true);
 perform save_event_archive('e1000000-0000-4000-8000-0000000000a3','草稿回顧','[]','[]','{}',true);
 if jsonb_array_length(event_archive_admin_list())<4 then raise exception 'admin list';end if;
end$$;

-- member sees published archive with filtered content
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d2',true);
do $$declare d jsonb;qa jsonb;begin
 d:=event_archive_page('e1000000-0000-4000-8000-0000000000a1');
 if d->>'summary'<>'本場回顧二' or jsonb_array_length(d->'agenda')<>3 then raise exception 'basics';end if;
 if jsonb_array_length(d->'spaces')<>1 or d#>>'{spaces,0,id}'<>'e2000000-0000-4000-8000-000000000001' then raise exception 'spaces %',d->'spaces';end if;
 if (d#>'{spaces,0}') ? 'owner_id' then raise exception 'space leaks owner';end if;
 qa:=d#>'{spaces,0,qa}';
 if jsonb_array_length(qa)<>5 then raise exception 'qa count %',jsonb_array_length(qa);end if;
 if qa::text like '%問題 0%' or qa::text like '%私人問題%' then raise exception 'hidden/private qa shown';end if;
 if qa#>>'{0,question_text}'<>'問題 1' or (qa#>>'{0,upvotes}')::int<(qa#>>'{4,upvotes}')::int then raise exception 'qa order';end if;
 if jsonb_array_length(d->'photos')<>1 or d#>>'{photos,0,id}'<>'e5000000-0000-4000-8000-000000000001' or d#>>'{photos,0,url}'<>'/api/v1/event-photos/public/e5000000-0000-4000-8000-000000000001' then raise exception 'photos %',d->'photos';end if;
 -- anonymous feedback: aggregates only
 if (d#>>'{feedback,response_count}')::int<>3 or (d#>>'{feedback,ratings,0,average}')::numeric<>4.00 or d::text like '%秘密文字%' or (d->'feedback')::text like '%respondent%' or (d->'feedback')::text like '%texts%' then raise exception 'feedback %',d->'feedback';end if;
 if jsonb_array_length(d#>'{feedback,ratings}')<>1 then raise exception 'text question aggregated';end if;
 -- members-only event: page works for members but no photos are exposed
 d:=event_archive_page('e1000000-0000-4000-8000-0000000000a2');
 if jsonb_array_length(d->'photos')<>0 then raise exception 'members-only event photos';end if;
 -- unpublished event or event without archive
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a3');raise exception 'draft event';exception when raise_exception then if sqlerrm<>'ARCHIVE_NOT_FOUND' then raise;end if;end;
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a4');raise exception 'no archive';exception when raise_exception then if sqlerrm<>'ARCHIVE_NOT_FOUND' then raise;end if;end;
end$$;

-- withdrawn / pending photos and small feedback groups stay hidden
reset role;
update event_photos set status='withdrawn',publication_consent=false,audience=null where id='e5000000-0000-4000-8000-000000000001';
delete from event_feedback_responses where respondent_id='00000000-0000-4000-8000-0000000000d4';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d2',true);
do $$declare d jsonb;begin
 d:=event_archive_page('e1000000-0000-4000-8000-0000000000a1');
 if jsonb_array_length(d->'photos')<>0 then raise exception 'withdrawn photo shown';end if;
 if (d#>>'{feedback,response_count}')::int<>2 or jsonb_array_length(d#>'{feedback,ratings}')<>0 then raise exception 'small group averages exposed %',d->'feedback';end if;
end$$;

-- list: published + published events only, series filter, title search, newest first
do $$declare l jsonb;begin
 l:=list_event_archives();
 if jsonb_array_length(l)<>2 or l#>>'{0,event_id}'<>'e1000000-0000-4000-8000-0000000000a2' then raise exception 'list %',l;end if;
 if jsonb_array_length(list_event_archives('e1000000-0000-4000-8000-000000000001'))<>1 then raise exception 'series filter';end if;
 if jsonb_array_length(list_event_archives(null,'實戰'))<>1 or jsonb_array_length(list_event_archives(null,'%'))<>0 then raise exception 'search';end if;
 if jsonb_array_length(list_event_archives(null,null,1,1))<>1 or jsonb_array_length(list_event_archives(null,null,50,5))<>0 then raise exception 'paging';end if;
end$$;
-- unpublish hides it again
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d1',true);
select save_event_archive('e1000000-0000-4000-8000-0000000000a1','本場回顧二','["亮點一"]','[]','{}',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000d2',true);
do $$begin
 begin perform event_archive_page('e1000000-0000-4000-8000-0000000000a1');raise exception 'unpublished visible';exception when raise_exception then if sqlerrm<>'ARCHIVE_NOT_FOUND' then raise;end if;end;
 if jsonb_array_length(list_event_archives())<>1 then raise exception 'unpublished listed';end if;
end$$;
-- flag off again: turning it off keeps the data
reset role;
update feature_flags set enabled=false where key='event_archive';
do $$begin if (select count(*) from event_archives)<>3 then raise exception 'data lost';end if;end$$;
rollback;
