\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000b1','po-admin@example.test'),
('00000000-0000-4000-8000-0000000000b2','po-member@example.test'),
('00000000-0000-4000-8000-0000000000b3','po-member2@example.test'),
('00000000-0000-4000-8000-0000000000b4','po-unverified@example.test');
update profiles set role='admin',passcode_verified=true,display_name='Admin A' where id='00000000-0000-4000-8000-0000000000b1';
update profiles set passcode_verified=true,display_name='Member B' where id='00000000-0000-4000-8000-0000000000b2';
update profiles set passcode_verified=true,display_name='Member C' where id='00000000-0000-4000-8000-0000000000b3';
-- test helper: run sql, require it to fail with the given message
create function public.t_expect(p_sql text,p_err text) returns void language plpgsql as $$begin
 begin execute p_sql;exception when others then if sqlerrm=p_err or (p_err='DENIED' and sqlstate='42501') then return;end if;raise exception 'Expected % but got % (%)',p_err,sqlerrm,p_sql;end;
 raise exception 'Expected % but statement succeeded (%)',p_err,p_sql;
end$$;
grant execute on function public.t_expect(text,text) to authenticated;

-- flag OFF: everything denied, tables empty to members
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a','b'])$q$,'FEATURE_DISABLED');
select t_expect($q$select set_poll_settings(true)$q$,'FEATURE_DISABLED');
select t_expect($q$select cast_poll_vote(gen_random_uuid(),array[gen_random_uuid()])$q$,'FEATURE_DISABLED');
select t_expect($q$select close_poll(gen_random_uuid())$q$,'FEATURE_DISABLED');
select t_expect($q$select poll_results(gen_random_uuid())$q$,'FEATURE_DISABLED');
select set_feature_flag('polls',true);

-- direct writes never allowed
select t_expect($q$insert into polls(creator_id,title,kind) values(auth.uid(),'x','single')$q$,'DENIED');
select t_expect($q$insert into poll_votes(poll_id,option_id,voter_id) values(gen_random_uuid(),gen_random_uuid(),auth.uid())$q$,'DENIED');
select t_expect($q$update poll_settings set members_can_create=true$q$,'DENIED');
select t_expect($q$insert into poll_options(poll_id,label,position) values(gen_random_uuid(),'x',0)$q$,'DENIED');

-- unverified user
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b4',true);
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a','b'])$q$,'MEMBER_REQUIRED');
select t_expect($q$select poll_results(gen_random_uuid())$q$,'MEMBER_REQUIRED');
select t_expect($q$select cast_poll_vote(gen_random_uuid(),array[gen_random_uuid()])$q$,'MEMBER_REQUIRED');
do $$begin if exists(select 1 from poll_settings) or exists(select 1 from polls) then raise exception 'Unverified reads polls';end if;end$$;

-- member cannot create while setting is off, cannot change settings
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a','b'])$q$,'CREATE_NOT_ALLOWED');
select t_expect($q$select set_poll_settings(true)$q$,'ADMIN_REQUIRED');
do $$begin if (select members_can_create from poll_settings) then raise exception 'Default should be false';end if;end$$;

-- admin creates polls; validation
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['only one'])$q$,'INVALID_OPTIONS');
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a','b','c','d','e','f','g','h','i','j','k'])$q$,'INVALID_OPTIONS');
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a','a'])$q$,'INVALID_OPTIONS');
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a',repeat('x',101)])$q$,'INVALID_OPTIONS');
select t_expect($q$select create_poll(repeat('t',121),'','single',1,false,'always',null,null,null,array['a','b'])$q$,'INVALID_POLL');
select t_expect($q$select create_poll('t',repeat('d',1001),'single',1,false,'always',null,null,null,array['a','b'])$q$,'INVALID_POLL');
select t_expect($q$select create_poll('t','','ranked',1,false,'always',null,null,null,array['a','b'])$q$,'INVALID_POLL');
select t_expect($q$select create_poll('t','','multiple',5,false,'always',null,null,null,array['a','b'])$q$,'INVALID_POLL');
select t_expect($q$select create_poll('t','','single',1,false,'sometimes',null,null,null,array['a','b'])$q$,'INVALID_POLL');
select t_expect($q$select create_poll('t','','single',1,false,'always',now()-interval '1 hour',null,null,array['a','b'])$q$,'INVALID_POLL');
select t_expect($q$select create_poll('t','','single',1,false,'always',null,'event',gen_random_uuid(),array['a','b'])$q$,'INVALID_ATTACHMENT');
select t_expect($q$select create_poll('t','','single',1,false,'always',null,'event',null,array['a','b'])$q$,'INVALID_ATTACHMENT');
-- PII (Taiwan ID, MRN with context) in title / description / option labels
select t_expect($q$select create_poll('A123456789 問題','','single',1,false,'always',null,null,null,array['a','b'])$q$,'PII_DETECTED');
select t_expect($q$select create_poll('t','病歷號 12345678','single',1,false,'always',null,null,null,array['a','b'])$q$,'PII_DETECTED');
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['ok','MRN: 1234567'])$q$,'PII_DETECTED');
do $$begin
 if exists(select 1 from polls) then raise exception 'Rejected poll left rows';end if;
 if polls_has_pii('投票 12345678') then raise exception 'Bare number flagged as MRN';end if;
end$$;

create temp table ids(name text primary key,id uuid);
grant all on ids to authenticated;
insert into ids select 'single',create_poll('午餐吃什麼','選一個','single',1,false,'always',null,null,null,array['便當','麵','沙拉']);
insert into ids select 'multi',create_poll('想聽哪些主題','','multiple',2,false,'always',null,null,null,array['AI','資安','雲端']);
insert into ids select 'anon',create_poll('匿名意見','','single',1,true,'always',null,null,null,array['是','否']);
insert into ids select 'aftervote',create_poll('投完才看','','single',1,false,'after_vote',null,null,null,array['甲','乙']);
insert into ids select 'afterclose',create_poll('結束才看','','single',1,false,'after_close',null,null,null,array['甲','乙']);
insert into ids select 'timed',create_poll('限時','','single',1,false,'always',now()+interval '1 hour',null,null,array['甲','乙']);
do $$begin
 if(select count(*) from poll_options where poll_id=(select id from ids where name='single'))<>3 then raise exception 'Options not stored';end if;
 if(select max_choices from polls where id=(select id from ids where name='single'))<>1 then raise exception 'single max_choices';end if;
end$$;

-- admin enables member creation; member creates own poll
select set_poll_settings(true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
insert into ids select 'member',create_poll('同仁發起','','single',1,false,'always',null,null,null,array['x','y']);
do $$begin if(select creator_id from polls where id=(select id from ids where name='member'))<>auth.uid() then raise exception 'creator_id wrong';end if;end$$;
-- another member cannot close it; creator can
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
select t_expect(format($q$select close_poll(%L)$q$,(select id from ids where name='member')),'FORBIDDEN');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select close_poll((select id from ids where name='member'));
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid])$q$,(select id from ids where name='member'),(select id from poll_options where poll_id=(select id from ids where name='member') and position=0)),'POLL_CLOSED');

-- single vs multiple
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
create function pg_temp.opt(p text,pos int) returns uuid language sql as $$select o.id from poll_options o join ids i on i.id=o.poll_id where i.name=p and o.position=pos$$;
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid,%L::uuid])$q$,(select id from ids where name='single'),pg_temp.opt('single',0),pg_temp.opt('single',1)),'INVALID_CHOICES');
select t_expect(format($q$select cast_poll_vote(%L,array[]::uuid[])$q$,(select id from ids where name='single')),'INVALID_CHOICES');
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid])$q$,(select id from ids where name='single'),pg_temp.opt('multi',0)),'INVALID_CHOICES');
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid,%L::uuid,%L::uuid])$q$,(select id from ids where name='multi'),pg_temp.opt('multi',0),pg_temp.opt('multi',1),pg_temp.opt('multi',2)),'INVALID_CHOICES');
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid,%L::uuid])$q$,(select id from ids where name='multi'),pg_temp.opt('multi',0),pg_temp.opt('multi',0)),'INVALID_CHOICES');
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid])$q$,gen_random_uuid(),pg_temp.opt('single',0)),'POLL_NOT_FOUND');
select cast_poll_vote((select id from ids where name='single'),array[pg_temp.opt('single',0)]);
select cast_poll_vote((select id from ids where name='multi'),array[pg_temp.opt('multi',0),pg_temp.opt('multi',2)]);
-- re-vote replaces the previous selection
select cast_poll_vote((select id from ids where name='single'),array[pg_temp.opt('single',1)]);
select cast_poll_vote((select id from ids where name='multi'),array[pg_temp.opt('multi',1)]);
do $$declare r jsonb;begin
 if(select count(*) from poll_votes where voter_id=auth.uid() and poll_id=(select id from ids where name='single'))<>1 then raise exception 'Single vote not replaced';end if;
 if not exists(select 1 from poll_votes where voter_id=auth.uid() and option_id=pg_temp.opt('single',1)) then raise exception 'Wrong single option';end if;
 if(select count(*) from poll_votes where voter_id=auth.uid() and poll_id=(select id from ids where name='multi'))<>1 then raise exception 'Multi vote not replaced';end if;
end$$;
select cast_poll_vote((select id from ids where name='multi'),array[pg_temp.opt('multi',0),pg_temp.opt('multi',1)]);

-- member C votes; non-anonymous results show names, counts correct
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
select cast_poll_vote((select id from ids where name='single'),array[pg_temp.opt('single',1)]);
do $$declare r jsonb;begin
 r:=poll_results((select id from ids where name='single'));
 if not (r->>'visible')::boolean or (r->>'total_voters')::int<>2 then raise exception 'single results wrong %',r;end if;
 if (r->'options'->1->>'votes')::int<>2 or (r->'options'->0->>'votes')::int<>0 then raise exception 'single counts wrong %',r;end if;
 if r->'options'->1->'voters'<>'["Member B", "Member C"]'::jsonb then raise exception 'voter names wrong %',r;end if;
 r:=poll_results((select id from ids where name='multi'));
 if (r->>'total_voters')::int<>1 or (r->'options'->0->>'votes')::int<>1 or (r->'options'->2->>'votes')::int<>0 then raise exception 'multi results wrong %',r;end if;
end$$;
-- no direct view of others' votes
do $$begin if exists(select 1 from poll_votes where voter_id<>auth.uid()) then raise exception 'Direct view of others votes';end if;end$$;

-- anonymous poll: no voter ids anywhere except own selection
select cast_poll_vote((select id from ids where name='anon'),array[pg_temp.opt('anon',0)]);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select cast_poll_vote((select id from ids where name='anon'),array[pg_temp.opt('anon',1)]);
do $$declare r jsonb;begin
 r:=poll_results((select id from ids where name='anon'));
 if (r->>'total_voters')::int<>2 or (r->'options'->0->>'votes')::int<>1 then raise exception 'anon counts wrong %',r;end if;
 if r::text like '%Member%' or r::text like '%0000000000b3%' then raise exception 'Anon results leak voters %',r;end if;
 if r->'options'->0->'voters' is distinct from 'null'::jsonb then raise exception 'anon voters not null %',r;end if;
 if r->'my_options'->>0<>pg_temp.opt('anon',1)::text then raise exception 'own selection missing';end if;
 if (select count(*) from poll_votes where poll_id=(select id from ids where name='anon'))<>1 then raise exception 'Member sees others anon votes';end if;
end$$;
-- even admins cannot see anonymous voter rows directly
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$declare r jsonb;begin
 if exists(select 1 from poll_votes where poll_id=(select id from ids where name='anon')) then raise exception 'Admin sees anon voter rows';end if;
 r:=poll_results((select id from ids where name='anon'));
 if r::text like '%Member%' or jsonb_array_length(r->'my_options')<>0 then raise exception 'Admin sees anon voters %',r;end if;
end$$;

-- show_results = after_vote
do $$declare r jsonb;begin
 r:=poll_results((select id from ids where name='aftervote'));
 if (r->>'visible')::boolean or r->'options'->0 ? 'votes' or r ? 'total_voters' then raise exception 'after_vote leaks before voting %',r;end if;
end$$;
select cast_poll_vote((select id from ids where name='aftervote'),array[pg_temp.opt('aftervote',0)]);
do $$declare r jsonb;begin
 r:=poll_results((select id from ids where name='aftervote'));
 if not (r->>'visible')::boolean or (r->'options'->0->>'votes')::int<>1 then raise exception 'after_vote hidden after voting %',r;end if;
end$$;

-- show_results = after_close
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select cast_poll_vote((select id from ids where name='afterclose'),array[pg_temp.opt('afterclose',0)]);
do $$declare r jsonb;begin
 r:=poll_results((select id from ids where name='afterclose'));
 if (r->>'visible')::boolean or r ? 'total_voters' or r->'options'->0 ? 'votes' then raise exception 'after_close leaks while open %',r;end if;
 if jsonb_array_length(r->'my_options')<>1 then raise exception 'own selection should be shown';end if;
end$$;
select t_expect(format($q$select close_poll(%L)$q$,(select id from ids where name='afterclose')),'FORBIDDEN');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select close_poll((select id from ids where name='afterclose'));
do $$declare r jsonb;begin
 r:=poll_results((select id from ids where name='afterclose'));
 if not (r->>'visible')::boolean or (r->>'total_voters')::int<>1 or not (r->>'is_closed')::boolean then raise exception 'after_close hidden after close %',r;end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid])$q$,(select id from ids where name='afterclose'),pg_temp.opt('afterclose',1)),'POLL_CLOSED');

-- expired poll (closes_at passed) denies votes and reveals after_close results
reset role;
update polls set closes_at=now()-interval '1 minute' where id=(select id from ids where name='timed');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid])$q$,(select id from ids where name='timed'),pg_temp.opt('timed',0)),'POLL_CLOSED');
do $$begin if not (poll_results((select id from ids where name='timed'))->>'is_closed')::boolean then raise exception 'Expired poll not closed';end if;end$$;

-- admin may close any poll; settings can be switched back
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select close_poll((select id from ids where name='single'));
select set_poll_settings(false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
select t_expect($q$select create_poll('t','','single',1,false,'always',null,null,null,array['a','b'])$q$,'CREATE_NOT_ALLOWED');

-- attachment to existing content
reset role;
insert into discussion_threads(id,space_id,author_id,title,body) select '00000000-0000-4000-8000-0000000000c1',s.id,'00000000-0000-4000-8000-0000000000b2','T','B' from spaces s limit 1;
do $$begin
 if not exists(select 1 from spaces) then
  insert into spaces(id,owner_id,title,summary) values('00000000-0000-4000-8000-0000000000c0','00000000-0000-4000-8000-0000000000b2','S','S');
  insert into discussion_threads(id,space_id,author_id,title,body) values('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-0000000000c0','00000000-0000-4000-8000-0000000000b2','T','B');
 end if;
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
select create_poll('討論串投票','','single',1,false,'always',null,'thread','00000000-0000-4000-8000-0000000000c1',array['a','b']);
do $$begin if not exists(select 1 from polls where attached_type='thread' and attached_id='00000000-0000-4000-8000-0000000000c1') then raise exception 'Attachment not stored';end if;end$$;

-- flag turned OFF: data stays, access denied
select set_feature_flag('polls',false);
select t_expect(format($q$select poll_results(%L)$q$,(select id from ids where name='single')),'FEATURE_DISABLED');
select t_expect(format($q$select cast_poll_vote(%L,array[%L::uuid])$q$,(select id from ids where name='multi'),pg_temp.opt('multi',0)),'FEATURE_DISABLED');
do $$begin if exists(select 1 from polls) or exists(select 1 from poll_options) or exists(select 1 from poll_settings) or exists(select 1 from poll_votes) then raise exception 'Rows visible while flag off';end if;end$$;
reset role;
do $$begin if(select count(*) from polls)<8 or not exists(select 1 from poll_votes) then raise exception 'Data lost when flag off';end if;end$$;
rollback;
