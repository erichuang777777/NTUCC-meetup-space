\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000006a1','fp-admin@example.test'),
('00000000-0000-4000-8000-0000000006a2','fp-author@example.test'),
('00000000-0000-4000-8000-0000000006a3','fp-bob@example.test'),
('00000000-0000-4000-8000-0000000006a4','fp-carol@example.test'),
('00000000-0000-4000-8000-0000000006a5','fp-twin1@example.test'),
('00000000-0000-4000-8000-0000000006a6','fp-twin2@example.test'),
('00000000-0000-4000-8000-0000000006a7','fp-dave@example.test'),
('00000000-0000-4000-8000-0000000006a8','fp-unverified@example.test');
update profiles set role='admin',passcode_verified=true,display_name='Admin F' where id='00000000-0000-4000-8000-0000000006a1';
update profiles set passcode_verified=true,display_name='Auth Alice' where id='00000000-0000-4000-8000-0000000006a2';
update profiles set passcode_verified=true,display_name='Reply Bob' where id='00000000-0000-4000-8000-0000000006a3';
update profiles set passcode_verified=true,display_name='Carol C' where id='00000000-0000-4000-8000-0000000006a4';
update profiles set passcode_verified=true,display_name='Twin' where id in ('00000000-0000-4000-8000-0000000006a5','00000000-0000-4000-8000-0000000006a6');
update profiles set passcode_verified=true,display_name='Dave D' where id='00000000-0000-4000-8000-0000000006a7';
update profiles set display_name='Ghost G' where id='00000000-0000-4000-8000-0000000006a8';
insert into spaces(id,owner_id,title,summary,visibility) values
('60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000006a2','FP Public','Summary','public');
create function public.t_expect(p_sql text,p_err text) returns void language plpgsql as $$begin
 begin execute p_sql;exception when others then if sqlerrm=p_err or (p_err='DENIED' and sqlstate='42501') then return;end if;raise exception 'Expected % but got % (%)',p_err,sqlerrm,p_sql;end;
 raise exception 'Expected % but statement succeeded (%)',p_err,p_sql;
end$$;
grant execute on function public.t_expect(text,text) to authenticated;

-- flag OFF: triggers no-op, columns default, RPCs denied
insert into discussion_threads(id,space_id,author_id,title,body) values
('61000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000006a2','Off thread','hello @Carol C');
do $$begin
 if exists(select 1 from discussion_mentions) or exists(select 1 from discussion_follows) then raise exception 'Triggers ran with flag off';end if;
 if exists(select 1 from discussion_threads where is_featured or accepted_reply_id is not null) then raise exception 'Defaults changed';end if;
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a4',true);
select t_expect($q$select mention_suggestions('Tw')$q$,'FEATURE_DISABLED');
select t_expect($q$select toggle_helpful('thread','61000000-0000-4000-8000-000000000001')$q$,'FEATURE_DISABLED');
select t_expect($q$select toggle_follow_thread('61000000-0000-4000-8000-000000000001')$q$,'FEATURE_DISABLED');
select t_expect($q$select set_accepted_reply('61000000-0000-4000-8000-000000000001',null)$q$,'FEATURE_DISABLED');
select t_expect($q$select set_thread_flags('61000000-0000-4000-8000-000000000001',true,true)$q$,'FEATURE_DISABLED');
select t_expect($q$select forum_plus_threads(array[gen_random_uuid()])$q$,'FEATURE_DISABLED');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a8',true);
select t_expect($q$select mention_suggestions('Tw')$q$,'MEMBER_REQUIRED');
select t_expect($q$select toggle_helpful('thread','61000000-0000-4000-8000-000000000001')$q$,'MEMBER_REQUIRED');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a1',true);
select set_feature_flag('notifications',true);
select set_feature_flag('forum_plus',true);
reset role;

-- direct writes denied; blocked pair setup
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a4',true);
select t_expect($q$insert into discussion_reactions(target_type,target_id,user_id) values('thread',gen_random_uuid(),auth.uid())$q$,'DENIED');
select t_expect($q$insert into discussion_follows(thread_id,user_id) values(gen_random_uuid(),auth.uid())$q$,'DENIED');
select t_expect($q$insert into discussion_mentions(source_type,source_id,mentioned_user) values('thread',gen_random_uuid(),auth.uid())$q$,'DENIED');
select t_expect($q$select set_thread_flags('61000000-0000-4000-8000-000000000001',true,true)$q$,'ADMIN_REQUIRED');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a8',true);
select t_expect($q$select mention_suggestions('Tw')$q$,'MEMBER_REQUIRED');
reset role;
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000006a7','00000000-0000-4000-8000-0000000006a2');

-- mentions: Carol resolved; Twin ambiguous, Nobody unknown, self skipped, Dave blocked, Ghost unverified ignored
insert into discussion_threads(id,space_id,author_id,title,body) values
('61000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000006a2','On thread','cc @Carol C @Twin @Nobody @Auth Alice @Dave D @Ghost G');
do $$begin
 if (select count(*) from discussion_mentions)<>1 or not exists(select 1 from discussion_mentions where source_type='thread' and mentioned_user='00000000-0000-4000-8000-0000000006a4') then raise exception 'Mention resolution wrong: %',(select count(*) from discussion_mentions);end if;
 if (select count(*) from notifications where type='forum_mention')<>1 then raise exception 'Mention notification count';end if;
 if not exists(select 1 from discussion_follows where thread_id='61000000-0000-4000-8000-000000000002' and user_id='00000000-0000-4000-8000-0000000006a2') then raise exception 'Author did not auto-follow';end if;
end$$;

-- follow + fan-out (author excluded, no duplicates)
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a4',true);
do $$begin
 if not toggle_follow_thread('61000000-0000-4000-8000-000000000002') then raise exception 'Follow failed';end if;
 if (select count(*) from discussion_follows where user_id=auth.uid())<>1 then raise exception 'Follow rows';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a3',true);
do $$begin if not toggle_follow_thread('61000000-0000-4000-8000-000000000002') then raise exception 'Bob follow failed';end if;end$$;
reset role;
insert into discussion_replies(id,thread_id,author_id,body) values
('62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a3','first reply');
do $$begin
 if (select count(*) from notifications where type='forum_followed_reply' and user_id='00000000-0000-4000-8000-0000000006a4')<>1 then raise exception 'Carol not notified of followed reply';end if;
 if exists(select 1 from notifications where type='forum_followed_reply' and user_id in('00000000-0000-4000-8000-0000000006a3','00000000-0000-4000-8000-0000000006a2')) then raise exception 'Replier/author got follower notification';end if;
 if (select count(*) from notifications where type='discussion_reply' and user_id='00000000-0000-4000-8000-0000000006a2')<>1 then raise exception 'F1 author notification missing';end if;
end$$;
-- reply that mentions a follower: only the mention notification, no duplicate follow notification
insert into discussion_replies(id,thread_id,author_id,body) values
('62000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a3','ping @Carol C');
do $$begin
 if (select count(*) from notifications where type='forum_followed_reply' and user_id='00000000-0000-4000-8000-0000000006a4')<>1 then raise exception 'Duplicate follower notification';end if;
 if (select count(*) from notifications where type='forum_mention' and user_id='00000000-0000-4000-8000-0000000006a4')<>2 then raise exception 'Reply mention missing';end if;
end$$;
-- blocked follower skipped
insert into discussion_follows(thread_id,user_id) values('61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a7');
insert into discussion_replies(id,thread_id,author_id,body) values
('62000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a3','another');
do $$begin
 if (select count(*) from notifications where type='forum_followed_reply' and user_id='00000000-0000-4000-8000-0000000006a7')<>1 then raise exception 'Unblocked follower pair should be notified';end if;
end$$;
insert into discussion_follows(thread_id,user_id) values('61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a5');
insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000006a5','00000000-0000-4000-8000-0000000006a3');
insert into discussion_replies(id,thread_id,author_id,body) values
('62000000-0000-4000-8000-000000000004','61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a3','more');
do $$begin
 if exists(select 1 from notifications where type='forum_followed_reply' and user_id='00000000-0000-4000-8000-0000000006a5') then raise exception 'Blocked follower notified';end if;
end$$;
-- unfollow
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a4',true);
do $$begin if toggle_follow_thread('61000000-0000-4000-8000-000000000002') then raise exception 'Unfollow failed';end if;end$$;

-- helpful: toggle, one per user, count
do $$begin
 if toggle_helpful('thread','61000000-0000-4000-8000-000000000002')<>1 then raise exception 'First helpful';end if;
 if toggle_helpful('thread','61000000-0000-4000-8000-000000000002')<>0 then raise exception 'Helpful not toggled off';end if;
 if toggle_helpful('thread','61000000-0000-4000-8000-000000000002')<>1 then raise exception 'Re-helpful';end if;
 if toggle_helpful('reply','62000000-0000-4000-8000-000000000001')<>1 then raise exception 'Reply helpful';end if;
 if (select helpful_count from forum_plus_threads(array['61000000-0000-4000-8000-000000000002']::uuid[]))<>1 then raise exception 'Count read';end if;
end$$;
select t_expect($q$select toggle_helpful('thread',gen_random_uuid())$q$,'NOT_FOUND');
select t_expect($q$select toggle_helpful('space','61000000-0000-4000-8000-000000000002')$q$,'INVALID_TARGET');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a3',true);
do $$begin
 if toggle_helpful('thread','61000000-0000-4000-8000-000000000002')<>2 then raise exception 'Second voter';end if;
 if (select count(*) from discussion_reactions)<>3 then raise exception 'Verified member cannot read reactions';end if;
end$$;

-- accepted reply rules
select t_expect($q$select set_accepted_reply('61000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000001')$q$,'FORBIDDEN');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a2',true);
select t_expect($q$select set_accepted_reply('61000000-0000-4000-8000-000000000002',gen_random_uuid())$q$,'INVALID_REPLY');
reset role;
insert into discussion_replies(id,thread_id,author_id,body) values
('62000000-0000-4000-8000-000000000009','61000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000006a3','other thread reply');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a2',true);
select t_expect($q$select set_accepted_reply('61000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000009')$q$,'INVALID_REPLY');
do $$begin
 perform set_accepted_reply('61000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000001');
 if (select accepted_reply_id from forum_plus_threads(array['61000000-0000-4000-8000-000000000002']::uuid[]))<>'62000000-0000-4000-8000-000000000001' then raise exception 'Not accepted';end if;
 perform set_accepted_reply('61000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000001');
end$$;
reset role;
do $$begin if (select count(*) from notifications where type='forum_accepted' and user_id='00000000-0000-4000-8000-0000000006a3')<>1 then raise exception 'Accepted notification count';end if;end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a2',true);
do $$begin perform set_accepted_reply('61000000-0000-4000-8000-000000000002',null);
 if (select accepted_reply_id from forum_plus_threads(array['61000000-0000-4000-8000-000000000002']::uuid[])) is not null then raise exception 'Not cleared';end if;end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a1',true);
do $$begin perform set_accepted_reply('61000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000002');end$$;

-- admin pin / feature only
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a2',true);
select t_expect($q$select set_thread_flags('61000000-0000-4000-8000-000000000002',true,true)$q$,'ADMIN_REQUIRED');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a1',true);
select set_thread_flags('61000000-0000-4000-8000-000000000002',true,null);
do $$begin
 if not (select is_pinned and not is_featured from forum_plus_threads(array['61000000-0000-4000-8000-000000000002']::uuid[])) then raise exception 'Pin flags';end if;
end$$;
select set_thread_flags('61000000-0000-4000-8000-000000000002',null,true);
do $$begin if not (select is_pinned and is_featured from forum_plus_threads(array['61000000-0000-4000-8000-000000000002']::uuid[])) then raise exception 'Feature flags';end if;end$$;
select t_expect($q$select set_thread_flags(gen_random_uuid(),true,true)$q$,'NOT_FOUND');

-- mention suggestions: verified only, max 8, prefix, excludes self, escapes wildcards
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a4',true);
do $$begin
 if (select count(*) from mention_suggestions('Tw'))<>2 then raise exception 'Prefix suggestions';end if;
 if exists(select 1 from mention_suggestions('Ghost')) then raise exception 'Unverified suggested';end if;
 if exists(select 1 from mention_suggestions('Carol')) then raise exception 'Self suggested';end if;
 if exists(select 1 from mention_suggestions('%')) then raise exception 'Wildcard not escaped';end if;
end$$;
reset role;

-- turning the flag off keeps data and silences triggers
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000006a1',true);
select set_feature_flag('forum_plus',false);
reset role;
insert into discussion_replies(id,thread_id,author_id,body) values
('62000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-0000000006a3','silent @Carol C');
do $$begin
 if (select count(*) from discussion_mentions)<>2 then raise exception 'Mention trigger ran with flag off';end if;
 if (select count(*) from discussion_reactions)<>3 then raise exception 'Data lost';end if;
end$$;
rollback;
