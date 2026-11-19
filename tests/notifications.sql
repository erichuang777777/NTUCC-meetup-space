\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000b1','nt-admin@example.test'),
('00000000-0000-4000-8000-0000000000b2','nt-alice@example.test'),
('00000000-0000-4000-8000-0000000000b3','nt-bob@example.test'),
('00000000-0000-4000-8000-0000000000b4','nt-unverified@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000b1';
update profiles set passcode_verified=true,display_name='Alice' where id='00000000-0000-4000-8000-0000000000b2';
update profiles set passcode_verified=true,display_name='Bob' where id='00000000-0000-4000-8000-0000000000b3';

-- Flag OFF: nothing is produced by any trigger or by queue_event_reminders.
do $$declare conv uuid;sp uuid;th uuid;ev uuid;begin
 insert into private_conversations(member_low,member_high) values('00000000-0000-4000-8000-0000000000b2','00000000-0000-4000-8000-0000000000b3') returning id into conv;
 insert into private_messages(conversation_id,sender_id,body) values(conv,'00000000-0000-4000-8000-0000000000b2','hi');
 insert into spaces(owner_id,title,summary,visibility) values('00000000-0000-4000-8000-0000000000b3','S','s','public') returning id into sp;
 insert into discussion_threads(space_id,author_id,title,body) values(sp,'00000000-0000-4000-8000-0000000000b3','T','b') returning id into th;
 insert into discussion_replies(thread_id,author_id,body) values(th,'00000000-0000-4000-8000-0000000000b2','r');
 insert into public_events(title,starts_at,ends_at,registration_closes_at,capacity,is_published) values('E',now()+interval '2 hours',now()+interval '3 hours',now()+interval '1 hour',10,true) returning id into ev;
 insert into event_registrations(event_id,user_id,status,eligibility_status) values(ev,'00000000-0000-4000-8000-0000000000b2','registered','pending');
 update event_registrations set eligibility_status='approved' where event_id=ev;
 set local role service_role;
 if queue_event_reminders()<>0 then raise exception 'reminders queued while flag off';end if;
 reset role;
 if exists(select 1 from notifications) then raise exception 'notifications produced while flag off';end if;
 if exists(select 1 from event_reminders_sent) then raise exception 'reminder tracked while flag off';end if;
 perform set_config('nt.conv',conv::text,true);perform set_config('nt.sp',sp::text,true);perform set_config('nt.th',th::text,true);perform set_config('nt.ev',ev::text,true);
end$$;

-- Rows created while on are hidden when off (data kept).
do $$begin update feature_flags set enabled=true where key='notifications';
 perform notify('00000000-0000-4000-8000-0000000000b2','x_test','hello');
 update feature_flags set enabled=false where key='notifications';end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin
 if exists(select 1 from notifications) then raise exception 'notifications visible while flag off';end if;
 if mark_all_notifications_read()<>0 then raise exception 'mark read worked while flag off';end if;
 if exists(select 1 from notification_preferences) then raise exception 'prefs visible while flag off';end if;
 begin insert into notification_preferences(user_id,type,enabled) values(auth.uid(),'private_message',false);raise exception 'pref insert while flag off';exception when insufficient_privilege then null;end;
end$$;
reset role;
do $$begin if(select count(*) from notifications)<>1 then raise exception 'data deleted by flag off';end if;
 update feature_flags set enabled=true where key='notifications';
 delete from notifications;end$$;

-- Unverified user has no access
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b4',true);
do $$begin
 begin insert into notification_preferences(user_id,type,enabled) values(auth.uid(),'private_message',false);raise exception 'unverified wrote prefs';exception when insufficient_privilege then null;end;
 if exists(select 1 from notification_preferences) then raise exception 'unverified read prefs';end if;
end$$;

-- Private message trigger, opt-out, block
reset role;
do $$declare conv uuid:=current_setting('nt.conv')::uuid;n record;begin
 insert into private_messages(conversation_id,sender_id,body) values(conv,'00000000-0000-4000-8000-0000000000b2','secret body text');
 select * into n from notifications where user_id='00000000-0000-4000-8000-0000000000b3' and type='private_message';
 if not found then raise exception 'no private message notification';end if;
 if n.body<>'Alice' or n.link<>'#messages' or n.title<>'新私訊' or n.payload::text like '%secret%' then raise exception 'unexpected message notification %',n;end if;
 if exists(select 1 from notifications where user_id='00000000-0000-4000-8000-0000000000b2') then raise exception 'sender notified';end if;
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b3',true);
do $$declare id1 uuid;begin
 if(select count(*) from notifications)<>1 then raise exception 'recipient should see own row only';end if;
 select id into id1 from notifications;
 if mark_notifications_read(array[id1])<>1 then raise exception 'mark one failed';end if;
 if mark_all_notifications_read()<>0 then raise exception 'unexpected unread';end if;
 insert into notification_preferences(user_id,type,enabled) values(auth.uid(),'private_message',false);
 begin insert into notification_preferences(user_id,type,enabled) values('00000000-0000-4000-8000-0000000000b2','x',false);raise exception 'wrote other prefs';exception when insufficient_privilege then null;end;
end$$;
reset role;
do $$declare conv uuid:=current_setting('nt.conv')::uuid;begin
 insert into private_messages(conversation_id,sender_id,body) values(conv,'00000000-0000-4000-8000-0000000000b2','again');
 if(select count(*) from notifications where user_id='00000000-0000-4000-8000-0000000000b3' and type='private_message')<>1 then raise exception 'opt-out ignored';end if;
 delete from notification_preferences;
 insert into contact_blocks(owner_id,blocked_user_id) values('00000000-0000-4000-8000-0000000000b3','00000000-0000-4000-8000-0000000000b2');
 insert into private_messages(conversation_id,sender_id,body) values(conv,'00000000-0000-4000-8000-0000000000b2','blocked');
 if(select count(*) from notifications where user_id='00000000-0000-4000-8000-0000000000b3' and type='private_message')<>1 then raise exception 'blocked contact produced notification';end if;
 delete from contact_blocks;
end$$;

-- Discussion reply trigger
do $$declare th uuid:=current_setting('nt.th')::uuid;n record;begin
 insert into discussion_replies(thread_id,author_id,body) values(th,'00000000-0000-4000-8000-0000000000b3','self reply');
 if exists(select 1 from notifications where type='discussion_reply') then raise exception 'self reply notified';end if;
 insert into discussion_replies(thread_id,author_id,body) values(th,'00000000-0000-4000-8000-0000000000b2','real reply');
 select * into n from notifications where type='discussion_reply';
 if not found or n.user_id<>'00000000-0000-4000-8000-0000000000b3' or n.body<>'Alice' or n.link<>'#project/'||current_setting('nt.sp')||'/thread/'||th then raise exception 'bad reply notification %',n;end if;
end$$;

-- Registration review trigger
do $$declare ev uuid:=current_setting('nt.ev')::uuid;n record;begin
 update event_registrations set eligibility_status='pending' where event_id=ev;
 delete from notifications;
 update event_registrations set eligibility_status='approved' where event_id=ev;
 select * into n from notifications where type='registration_review';
 if not found or n.user_id<>'00000000-0000-4000-8000-0000000000b2' or n.title<>'報名已通過審核' then raise exception 'bad approval notification %',n;end if;
 update event_registrations set eligibility_status='pending' where event_id=ev;
 delete from notifications;
 update event_registrations set eligibility_status='rejected' where event_id=ev;
 if not exists(select 1 from notifications where type='registration_review' and title='報名未通過審核') then raise exception 'no rejection notification';end if;
 update event_registrations set eligibility_status='approved' where event_id=ev;
 delete from notifications;
end$$;

-- Reminders: authenticated denied, service_role sends once
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b2',true);
do $$begin begin perform queue_event_reminders();raise exception 'authenticated ran reminders';exception when insufficient_privilege then null;end;end$$;
reset role;
do $$declare ev uuid:=current_setting('nt.ev')::uuid;n int;begin
 set local role service_role;
 n:=queue_event_reminders();
 if n<>1 then raise exception 'expected 1 reminder, got %',n;end if;
 if queue_event_reminders()<>0 then raise exception 'reminder sent twice';end if;
 reset role;
 if(select count(*) from notifications where type='event_reminder' and user_id='00000000-0000-4000-8000-0000000000b2')<>1 then raise exception 'reminder row missing';end if;
 update public_events set starts_at=now()+interval '3 days',ends_at=now()+interval '3 days 1 hour',registration_closes_at=now()+interval '2 days' where id=ev;
 delete from event_reminders_sent;
 set local role service_role;
 if queue_event_reminders()<>0 then raise exception 'reminded outside window';end if;
 reset role;
end$$;

-- Admin cannot call service-only notify either
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000b1',true);
do $$begin begin perform notify(auth.uid(),'t','x');raise exception 'admin ran notify';exception when insufficient_privilege then null;end;end$$;
rollback;
