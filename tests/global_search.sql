\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000c0001','gs-admin@example.test'),
('00000000-0000-4000-8000-0000000c0002','gs-author@example.test'),
('00000000-0000-4000-8000-0000000c0003','gs-viewer@example.test'),
('00000000-0000-4000-8000-0000000c0004','gs-unverified@example.test'),
('00000000-0000-4000-8000-0000000c0005','gs-blocked@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000c0001';
update profiles set passcode_verified=true,display_name='Author' where id='00000000-0000-4000-8000-0000000c0002';
update profiles set passcode_verified=true,display_name='Viewer' where id='00000000-0000-4000-8000-0000000c0003';
update profiles set passcode_verified=true,display_name='Zebrablocked' where id='00000000-0000-4000-8000-0000000c0005';

insert into announcements(title,category,content) values('Zebra 公告','活動公告','zebra announcement body');
insert into public_announcements(title,content,is_published) values('Zebra pub ann','x',true),('Zebra draft ann','x',false);
insert into public_events(title,starts_at,ends_at,registration_closes_at,capacity,is_published,audience) values
('Zebra open event',now()+interval '2 day',now()+interval '3 day',now()+interval '1 day',10,true,'public'),
('Zebra members event',now()+interval '2 day',now()+interval '3 day',now()+interval '1 day',10,true,'members'),
('Zebra draft event',now()+interval '2 day',now()+interval '3 day',now()+interval '1 day',10,false,'public');
insert into spaces(id,owner_id,title,summary,visibility) values
('c1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','Zebra public space','sum','public'),
('c1000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000c0002','Zebra private space','sum','private'),
('c1000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-0000000c0002','Zebra hidden space','sum','public');
insert into discussion_threads(id,space_id,author_id,title,body,is_hidden) values
('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','Zebra thread','body',false),
('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000c0002','Zebra private thread','body',false),
('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','Zebra flagged thread','body',true),
('c2000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','Moderated thread','zebra mod',false);
insert into discussion_replies(id,thread_id,author_id,body,is_hidden) values
('c3000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','zebra reply',false),
('c3000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','zebra hiddenflag reply',true),
('c3000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000c0002','zebra privatespace reply',false);
insert into pain_points(id,proposer_id,title,scenario) values
('c4000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000c0002','Zebra pain','scn'),
('c4000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000c0002','Zebra hidden pain','scn');
insert into talk_proposals(proposer_id,title,abstract,category_tag,duration_minutes,status) values
('00000000-0000-4000-8000-0000000c0002','Zebra accepted talk','abs','實戰展示',10,'accepted'),
('00000000-0000-4000-8000-0000000c0002','Zebra draft talk','abs','實戰展示',10,'draft'),
('00000000-0000-4000-8000-0000000c0002','Zebra submitted talk','abs','實戰展示',10,'submitted');
insert into member_directory_profiles(user_id,listed,bio) values
('00000000-0000-4000-8000-0000000c0002',true,'zebra expert'),
('00000000-0000-4000-8000-0000000c0001',false,'zebra unlisted'),
('00000000-0000-4000-8000-0000000c0005',true,'zebra blocked');
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000c0003','00000000-0000-4000-8000-0000000c0005');
insert into announcements(title,category,content) values('100% done','活動公告','file_name here'),('1000 done','活動公告','fileXname here');

-- flag OFF
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0003',true);
do $$begin begin perform * from global_search('zebra');raise exception 'Search while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;end$$;
reset role;
update feature_flags set enabled=true where key='global_search';

-- not verified / anon
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0004',true);
do $$begin begin perform * from global_search('zebra');raise exception 'Unverified search';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;end$$;
reset role;
set local role anon;
do $$begin begin perform * from global_search('zebra');raise exception 'Anon search';exception when insufficient_privilege then null;end;end$$;
reset role;

-- length bounds
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0003',true);
do $$begin
 begin perform * from global_search('z');raise exception 'short';exception when raise_exception then if sqlerrm<>'QUERY_TOO_SHORT' then raise;end if;end;
 begin perform * from global_search('  z ');raise exception 'short2';exception when raise_exception then if sqlerrm<>'QUERY_TOO_SHORT' then raise;end if;end;
 begin perform * from global_search(repeat('a',101));raise exception 'long';exception when raise_exception then if sqlerrm<>'QUERY_TOO_LONG' then raise;end if;end;
 perform * from global_search(repeat('a',100));
end$$;

-- own flags off (talk_proposals, member_directory, content_reports): those sources are absent / moderation inert
do $$declare r record;begin
 select count(*) filter(where type='announcement') a,count(*) filter(where type='event') e,count(*) filter(where type='space') s,
  count(*) filter(where type='thread') t,count(*) filter(where type='reply') rp,count(*) filter(where type='pain_point') p,
  count(*) filter(where type='talk') tk,count(*) filter(where type='member') m into r from global_search('zebra',null,50);
 if r.a<>2 then raise exception 'announcements %',r.a;end if;
 if r.e<>2 then raise exception 'events %',r.e;end if;
 if r.s<>2 then raise exception 'spaces %',r.s;end if;
 if r.t<>2 then raise exception 'threads %',r.t;end if;
 if r.rp<>1 then raise exception 'replies %',r.rp;end if;
 if r.p<>2 then raise exception 'pain %',r.p;end if;
 if r.tk<>0 then raise exception 'talk source with flag off';end if;
 if r.m<>0 then raise exception 'directory source with flag off';end if;
 if exists(select 1 from global_search('zebra',null,50) where title in('Zebra draft ann','Zebra draft event','Zebra private space','Zebra private thread','Zebra flagged thread')) then raise exception 'leak';end if;
 if exists(select 1 from global_search('zebra',null,50) where snippet like '%hiddenflag%' or snippet like '%privatespace%') then raise exception 'reply leak';end if;
end$$;
reset role;

update feature_flags set enabled=true where key in('talk_proposals','member_directory','content_reports');
insert into content_moderation(target_type,target_id,hidden) values
('space','c1000000-0000-4000-8000-000000000003',true),('thread','c2000000-0000-4000-8000-000000000004',true),
('pain_point','c4000000-0000-4000-8000-000000000002',true),('reply','c3000000-0000-4000-8000-000000000001',true);

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0003',true);
do $$declare r record;begin
 select count(*) filter(where type='space') s,count(*) filter(where type='thread') t,count(*) filter(where type='reply') rp,count(*) filter(where type='pain_point') p,
  count(*) filter(where type='talk') tk,count(*) filter(where type='member') m into r from global_search('zebra',null,50);
 if r.s<>1 or r.t<>1 or r.rp<>0 or r.p<>1 then raise exception 'moderation not applied %',r;end if;
 if r.tk<>1 then raise exception 'talk (accepted only) %',r.tk;end if;
 if exists(select 1 from global_search('zebra',null,50) where title in('Zebra draft talk','Zebra submitted talk')) then raise exception 'talk leak';end if;
 if r.m<>1 then raise exception 'members %',r.m;end if;
 if exists(select 1 from global_search('zebra',array['member']) where id in('00000000-0000-4000-8000-0000000c0001','00000000-0000-4000-8000-0000000c0005')) then raise exception 'directory leak';end if;
end$$;
do $$declare r record;begin
 select * into r from global_search('zebra thread',array['thread']);
 if r.type<>'thread' or r.link<>'#project/c1000000-0000-4000-8000-000000000001/thread/c2000000-0000-4000-8000-000000000001' then raise exception 'thread link %',r;end if;
 if exists(select 1 from global_search('zebra',array['event']) where type<>'event') then raise exception 'type filter';end if;
 if length((select snippet from global_search('zebra',array['announcement']) limit 1))>160 then raise exception 'snippet';end if;
end$$;
-- author keeps own moderated content and own private-space threads (RLS parity)
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0002',true);
do $$begin
 if not exists(select 1 from global_search('zebra',array['space'],50) where id='c1000000-0000-4000-8000-000000000003') then raise exception 'author lost own hidden space';end if;
 if not exists(select 1 from global_search('zebra',array['thread'],50) where id='c2000000-0000-4000-8000-000000000002') then raise exception 'owner private-space thread missing';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0001',true);
do $$begin if (select count(*) from global_search('zebra',array['pain_point'],50))<>2 then raise exception 'admin sees hidden';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0003',true);

-- wildcard escaping: % _ \ are literals
do $$begin
 if (select count(*) from global_search('100%',array['announcement']))<>1 then raise exception 'percent not literal';end if;
 if (select count(*) from global_search('file_n',array['announcement']))<>1 then raise exception 'underscore not literal';end if;
 if (select count(*) from global_search('%%',array['announcement']))<>0 then raise exception 'wildcard matched all';end if;
 if (select count(*) from global_search('\\',array['announcement']))<>0 then raise exception 'backslash';end if;
 if (select count(*) from global_search('公告',array['announcement']))<>1 then raise exception 'CJK';end if;
end$$;
do $$begin
 if (select count(*) from global_search('zebra',null,3,0))<>3 then raise exception 'limit';end if;
 if (select count(*) from global_search('zebra',null,3,3) a where a.id in(select id from global_search('zebra',null,3,0)))<>0 then raise exception 'offset';end if;
end$$;
reset role;
rollback;
