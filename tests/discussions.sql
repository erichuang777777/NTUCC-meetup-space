\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-000000000001','forum-owner@example.test'),
('00000000-0000-4000-8000-000000000002','forum-member@example.test'),
('00000000-0000-4000-8000-000000000003','forum-admin@example.test'),
('00000000-0000-4000-8000-000000000004','forum-pending@example.test');
update profiles set passcode_verified=true where id<>'00000000-0000-4000-8000-000000000004';
update profiles set role='admin' where id='00000000-0000-4000-8000-000000000003';
insert into spaces(id,owner_id,title,summary,visibility) values
('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Project A','Test','public'),
('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','Project B','Test','public'),
('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Private','Test','private');
insert into discussion_threads(id,space_id,author_id,title,body) values
('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Topic A','Body A'),
('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','Topic B','Body B'),
('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Private topic','Private body');
insert into discussion_replies(id,thread_id,author_id,body) values
('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','Reply A'),
('30000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002','Reply B'),
('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Private reply');
set local role anon;
do $$declare t text;begin foreach t in array array['discussion_threads','discussion_replies','discussion_threads_read','discussion_replies_read'] loop
 begin execute format('select * from %I',t);raise exception 'Guest can read %',t;exception when insufficient_privilege then null;end;
end loop;end$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$begin
 if(select count(*) from discussion_threads_read)<>2 then raise exception 'Member leaked private topic';end if;
 if(select count(*) from discussion_replies_read)<>2 then raise exception 'Member leaked private reply';end if;
 if(select count(*) from discussion_threads_read where space_id='10000000-0000-4000-8000-000000000001')<>1 then raise exception 'Topics mixed across projects';end if;
 begin insert into discussion_threads(space_id,author_id,title,body) values('10000000-0000-4000-8000-000000000001',auth.uid(),'Bypass','Bypass');raise exception 'Direct write bypasses PII';exception when insufficient_privilege then null;end;
 begin update discussion_threads set is_pinned=true;raise exception 'Member can pin directly';exception when insufficient_privilege then null;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
do $$begin if(select count(*) from discussion_threads_read)<>2 or (select count(*) from discussion_replies_read)<>2 then raise exception 'Admin can read private discussion';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000004',true);
do $$begin if exists(select 1 from discussion_threads_read) or exists(select 1 from discussion_replies_read) then raise exception 'Unverified account leaked forum';end if;end$$;
reset role;
do $$begin if(select reply_count from discussion_threads where id='20000000-0000-4000-8000-000000000001')<>1 then raise exception 'Reply counter incorrect';end if;end$$;
update discussion_replies set is_hidden=true where id='30000000-0000-4000-8000-000000000001';
do $$begin if(select reply_count from discussion_threads where id='20000000-0000-4000-8000-000000000001')<>0 then raise exception 'Hidden reply counted';end if;end$$;
update discussion_threads set is_hidden=true where id='20000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$begin if(select count(*) from discussion_threads_read)<>1 or exists(select 1 from discussion_replies_read) then raise exception 'Hidden content leaked';end if;end$$;
reset role;
update spaces set cover_image='data:image/png;base64,YQ==' where id='10000000-0000-4000-8000-000000000001';
select save_space('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{"title":"Updated","summary":"Updated","category_tag":"實戰展示","visibility":"public","highlights":[],"reference_links":[]}',null,null);
do $$begin if(select cover_image from spaces where id='10000000-0000-4000-8000-000000000001') is null then raise exception 'Old client removed cover';end if;end$$;
do $$begin if not (select has_cover from spaces where id='10000000-0000-4000-8000-000000000001') then raise exception 'Cover metadata flag missing';end if;end$$;
rollback;
