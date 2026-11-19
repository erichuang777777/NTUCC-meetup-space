\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000b1','md-admin@example.test'),
('00000000-0000-4000-8000-0000000000b2','md-alice@example.test'),
('00000000-0000-4000-8000-0000000000b3','md-bob@example.test'),
('00000000-0000-4000-8000-0000000000b4','md-carol@example.test'),
('00000000-0000-4000-8000-0000000000b5','md-unverified@example.test'),
('00000000-0000-4000-8000-0000000000b6','md-dave@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000b1';
update profiles set passcode_verified=true,display_name='Alice',department='藥劑部' where id='00000000-0000-4000-8000-0000000000b2';
update profiles set passcode_verified=true,display_name='Bob',department='資訊室' where id='00000000-0000-4000-8000-0000000000b3';
update profiles set passcode_verified=true,display_name='Carol',department='資訊室' where id='00000000-0000-4000-8000-0000000000b4';
update profiles set passcode_verified=true,display_name='Dave',department='護理部' where id='00000000-0000-4000-8000-0000000000b6';

-- flag OFF: everything denied
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 begin perform upsert_my_directory_profile(true,'x','{a}',false,'');raise exception 'Upsert while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform * from search_member_directory();raise exception 'Search while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 begin perform * from member_directory_tags();raise exception 'Tags while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
end$$;
reset role;
-- a pre-existing row must stay hidden while off
insert into member_directory_profiles(user_id,listed,bio) values('00000000-0000-4000-8000-0000000000b2',true,'prior');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin if exists(select 1 from member_directory_profiles) then raise exception 'Rows visible while off';end if;end$$;
reset role;
update feature_flags set enabled=true where key='member_directory';
delete from member_directory_profiles;

-- unverified denied
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b5',true);
do $$begin
 begin perform upsert_my_directory_profile(true,'x','{a}',false,'');raise exception 'Unverified upsert';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
 begin perform * from search_member_directory();raise exception 'Unverified search';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
 begin perform * from member_directory_tags();raise exception 'Unverified tags';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
 if exists(select 1 from member_directory_profiles) then raise exception 'Unverified reads table';end if;
end$$;

-- direct writes blocked
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 begin insert into member_directory_profiles(user_id,listed) values(auth.uid(),true);raise exception 'Direct insert';exception when insufficient_privilege then null;end;
 begin update member_directory_profiles set listed=true;raise exception 'Direct update';exception when insufficient_privilege then null;end;
end$$;

-- Alice lists with normalized tags; Bob lists; Carol stays unlisted; Dave lists
do $$declare r jsonb;begin
 r:=upsert_my_directory_profile(true,'  藥物交互作用專家 ','{" Python ","python","SQL  Server","","資料分析"}',true,'歡迎問藥物資料庫');
 if r->>'bio'<>'藥物交互作用專家' or r->'expertise_tags'<>'["Python","SQL Server","資料分析"]'::jsonb then raise exception 'Normalization wrong: %',r;end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
select upsert_my_directory_profile(true,'做自動化','{Python,RPA}',false,'');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b4',true);
select upsert_my_directory_profile(false,'不公開','{Secret}',true,'私下');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b6',true);
select upsert_my_directory_profile(true,'護理流程','{Python}',false,'');

-- Carol (unlisted): sees own row plus the 3 listed
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b4',true);
do $$begin
 if not exists(select 1 from member_directory_profiles where user_id=auth.uid() and not listed) then raise exception 'Owner cannot see own unlisted row';end if;
 if(select count(*) from member_directory_profiles)<>4 then raise exception 'Expected own + 3 listed rows, got %',(select count(*) from member_directory_profiles);end if;
end$$;

-- Bob: sees Alice+Dave, not Carol (unlisted), not self in search
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$begin
 if exists(select 1 from search_member_directory() where display_name='Carol') then raise exception 'Unlisted visible in search';end if;
 if exists(select 1 from member_directory_profiles where user_id='00000000-0000-4000-8000-0000000000b4') then raise exception 'Unlisted visible in table';end if;
 if(select count(*) from search_member_directory())<>2 then raise exception 'Expected 2 listed others';end if;
 if(select count(*) from search_member_directory('藥物'))<>1 then raise exception 'Query filter failed';end if;
 if(select count(*) from search_member_directory(null,'護理部'))<>1 then raise exception 'Department filter failed';end if;
 if(select count(*) from search_member_directory(null,null,'PYTHON'))<>2 then raise exception 'Tag filter failed';end if;
 if(select count(*) from search_member_directory('%'))<>0 then raise exception 'Wildcard not escaped';end if;
 if(select count(*) from search_member_directory(null,null,null,1,0))<>1 or(select count(*) from search_member_directory(null,null,null,1,1))<>1 then raise exception 'Paging failed';end if;
 if(select member_count from member_directory_tags() where lower(tag)='python')<>3 then raise exception 'Tag count wrong';end if;
 if exists(select 1 from member_directory_tags() where tag='Secret') then raise exception 'Unlisted tag counted';end if;
end$$;

-- admin sees listed only, not Carol's private row
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$begin
 if exists(select 1 from member_directory_profiles where user_id='00000000-0000-4000-8000-0000000000b4') then raise exception 'Admin snooped unlisted row';end if;
 if(select count(*) from member_directory_profiles)<>3 then raise exception 'Admin should see 3 listed rows';end if;
end$$;

-- blocks both ways
reset role;
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000b2'); -- Bob blocked Alice
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000000b6','00000000-0000-4000-8000-0000000000b3'); -- Dave blocked Bob
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$begin
 if exists(select 1 from search_member_directory() where display_name in('Alice','Dave')) then raise exception 'Block (either way) not filtered for Bob';end if;
 if exists(select 1 from member_directory_profiles where user_id in('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000b6')) then raise exception 'Blocked rows visible via table';end if;
 if(select member_count from member_directory_tags() where lower(tag)='python')<>1 then raise exception 'Tag counts ignore blocks';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 if exists(select 1 from search_member_directory() where display_name='Bob') then raise exception 'Alice sees Bob who blocked her';end if;
 if not exists(select 1 from search_member_directory() where display_name='Dave') then raise exception 'Alice should still see Dave';end if;
end$$;

-- PII rejection and length limits
do $$begin
 begin perform upsert_my_directory_profile(true,'我是A123456789','{}',false,'');raise exception 'ID in bio';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 begin perform upsert_my_directory_profile(true,'x','{}',false,'請教 a223456789');raise exception 'ID in topics';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 begin perform upsert_my_directory_profile(true,'病歷號 12345678','{}',false,'');raise exception 'MRN in bio';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 begin perform upsert_my_directory_profile(true,'MRN:1234567','{}',false,'');raise exception 'MRN en';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 begin perform upsert_my_directory_profile(true,'x','{A123456789}',false,'');raise exception 'ID in tag';exception when raise_exception then if sqlerrm<>'PII_DETECTED' then raise;end if;end;
 perform upsert_my_directory_profile(true,'我有 123456 個想法','{}',false,'');
 begin perform upsert_my_directory_profile(true,repeat('a',501),'{}',false,'');raise exception 'Long bio';exception when raise_exception then if sqlerrm<>'INVALID_BIO' then raise;end if;end;
 perform upsert_my_directory_profile(true,repeat('a',500),'{}',false,repeat('b',200));
 begin perform upsert_my_directory_profile(true,'','{}',false,repeat('b',201));raise exception 'Long topics';exception when raise_exception then if sqlerrm<>'INVALID_TOPICS' then raise;end if;end;
 begin perform upsert_my_directory_profile(true,'','{a,b,c,d,e,f,g,h,i,j,k}',false,'');raise exception '11 tags';exception when raise_exception then if sqlerrm<>'INVALID_TAGS' then raise;end if;end;
 perform upsert_my_directory_profile(true,'','{a,b,c,d,e,f,g,h,i,j}',false,'');
 begin perform upsert_my_directory_profile(true,'',array[repeat('t',21)],false,'');raise exception 'Long tag';exception when raise_exception then if sqlerrm<>'INVALID_TAGS' then raise;end if;end;
 perform upsert_my_directory_profile(true,'',array[repeat('t',20)],false,'');
end$$;

-- flag off again keeps data
reset role;
update feature_flags set enabled=false where key='member_directory';
do $$begin if(select count(*) from member_directory_profiles)<>4 then raise exception 'Data lost when flag off';end if;end$$;
rollback;
