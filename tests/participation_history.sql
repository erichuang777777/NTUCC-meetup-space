\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000e1','ph-admin@example.test'),
('00000000-0000-4000-8000-0000000000e2','ph-alice@example.test'),
('00000000-0000-4000-8000-0000000000e3','ph-bob@example.test'),
('00000000-0000-4000-8000-0000000000e4','ph-carol@example.test'),
('00000000-0000-4000-8000-0000000000e5','ph-unverified@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000e1';
update profiles set passcode_verified=true,display_name='Alice' where id='00000000-0000-4000-8000-0000000000e2';
update profiles set passcode_verified=true,display_name='Bob' where id='00000000-0000-4000-8000-0000000000e3';
update profiles set passcode_verified=true,display_name='Carol' where id='00000000-0000-4000-8000-0000000000e4';
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values
('e1400000-0000-4000-8000-000000000001','PH 活動 A',now()-interval '10 days',now()-interval '9 days',now()-interval '11 days',10,true),
('e1400000-0000-4000-8000-000000000002','PH 活動 B',now()+interval '10 days',now()+interval '11 days',now()+interval '9 days',10,true);
insert into event_registrations(event_id,user_id,status,checked_in_at) values
('e1400000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000e2','registered',now()-interval '10 days'),
('e1400000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000000e2','registered',null),
('e1400000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000e3','registered',now()-interval '10 days');
insert into spaces(id,owner_id,title,summary,visibility) values
('e1400000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000e2','Alice 公開展示','s','public'),
('e1400000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000e2','Alice 私人展示','s','private'),
('e1400000-0000-4000-8000-0000000000a3','00000000-0000-4000-8000-0000000000e3','Bob 私人秘密展示','s','private');
insert into discussion_threads(id,space_id,author_id,title,body) values
('e1400000-0000-4000-8000-0000000000b1','e1400000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000e2','T1','b'),
('e1400000-0000-4000-8000-0000000000b2','e1400000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000e2','T2 private space','b');

create function pg_temp.expect(q text,code text) returns void language plpgsql as $$begin
 begin execute q;raise exception 'NOT DENIED: %',q;exception when raise_exception then if sqlerrm<>code then raise;end if;end;end$$;
grant execute on function pg_temp.expect(text,text) to authenticated;

-- flag OFF
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e2',true);
select pg_temp.expect('select * from my_participation()','FEATURE_DISABLED');
select pg_temp.expect('select my_participation_summary()','FEATURE_DISABLED');
select pg_temp.expect('select set_participation_visibility(true)','FEATURE_DISABLED');
select pg_temp.expect($q$select member_participation_summary('00000000-0000-4000-8000-0000000000e3')$q$,'FEATURE_DISABLED');
reset role;
update feature_flags set enabled=true where key='participation_history';

-- non-verified denied
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e5',true);
select pg_temp.expect('select * from my_participation()','MEMBER_REQUIRED');
select pg_temp.expect('select my_participation_summary()','MEMBER_REQUIRED');
select pg_temp.expect('select set_participation_visibility(true)','MEMBER_REQUIRED');
select pg_temp.expect($q$select member_participation_summary('00000000-0000-4000-8000-0000000000e3')$q$,'MEMBER_REQUIRED');

-- direct writes blocked
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e2',true);
do $$begin
 begin insert into participation_visibility(user_id,show_in_directory) values(auth.uid(),true);raise exception 'Direct insert';exception when insufficient_privilege then null;end;
end$$;

-- only own data
do $$declare n int;s jsonb;begin
 select count(*) into n from my_participation();
 if n<>4 then raise exception 'Alice timeline expected 4 got %',n;end if;
 if exists(select 1 from my_participation() where title like 'Bob%') then raise exception 'Other user data leaked';end if;
 if not exists(select 1 from my_participation() where kind='space' and title='Alice 私人展示') then raise exception 'Own private space missing';end if;
 if (select count(*) from my_participation(2,0))<>2 or (select count(*) from my_participation(2,3))<>1 then raise exception 'Paging wrong';end if;
 s:=my_participation_summary();
 if (s->>'events_registered')::int<>2 or (s->>'events_attended')::int<>1 or (s->>'spaces')::int<>2 or (s->>'threads')::int<>2 then raise exception 'Summary wrong %',s;end if;
 if (s->>'show_in_directory')::boolean then raise exception 'Default must be hidden';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
do $$begin
 if (select count(*) from my_participation())<>2 then raise exception 'Bob timeline wrong';end if;
 if exists(select 1 from my_participation() where title like 'Alice%') then raise exception 'Alice data leaked to Bob';end if;
end$$;

-- opt-in summary: directory flag off => null even when opted in
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e2',true);
select set_participation_visibility(true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
do $$begin if member_participation_summary('00000000-0000-4000-8000-0000000000e2') is not null then raise exception 'Summary while directory flag off';end if;end$$;
reset role;
update feature_flags set enabled=true where key='member_directory';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
-- opted in but not listed => null
do $$begin if member_participation_summary('00000000-0000-4000-8000-0000000000e2') is not null then raise exception 'Summary for unlisted member';end if;end$$;
reset role;
insert into member_directory_profiles(user_id,listed) values('00000000-0000-4000-8000-0000000000e2',true),('00000000-0000-4000-8000-0000000000e4',true);
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
do $$declare s jsonb;begin
 s:=member_participation_summary('00000000-0000-4000-8000-0000000000e2');
 if s is null then raise exception 'Summary missing';end if;
 if s::text<>jsonb_build_object('events_attended',1,'talks_given',1,'threads_started',1)::text and s<>jsonb_build_object('events_attended',1,'talks_given',1,'threads_started',1) then raise exception 'Aggregates wrong %',s;end if;
 if (select count(*) from jsonb_object_keys(s))<>3 then raise exception 'Extra keys exposed';end if;
 -- listed but did not opt in (Carol) => null
 if member_participation_summary('00000000-0000-4000-8000-0000000000e4') is not null then raise exception 'Summary without opt-in';end if;
end$$;
-- block either direction hides the summary
reset role;
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000000e2','00000000-0000-4000-8000-0000000000e3');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
do $$begin if member_participation_summary('00000000-0000-4000-8000-0000000000e2') is not null then raise exception 'Blocked-by target summary visible';end if;end$$;
reset role;
delete from contact_blocks;
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000000e3','00000000-0000-4000-8000-0000000000e2');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
do $$begin if member_participation_summary('00000000-0000-4000-8000-0000000000e2') is not null then raise exception 'Blocker still sees summary';end if;end$$;
-- opting out hides again
reset role;
delete from contact_blocks;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e2',true);
select set_participation_visibility(false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e3',true);
do $$begin if member_participation_summary('00000000-0000-4000-8000-0000000000e2') is not null then raise exception 'Summary after opt-out';end if;end$$;
-- admin gets no special access to others' timelines
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000e1',true);
do $$begin if exists(select 1 from my_participation()) then raise exception 'Admin sees others data';end if;end$$;
rollback;
