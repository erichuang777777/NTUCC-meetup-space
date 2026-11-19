\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000a1','ff-admin@example.test'),
('00000000-0000-4000-8000-0000000000a2','ff-member@example.test'),
('00000000-0000-4000-8000-0000000000a3','ff-member2@example.test'),
('00000000-0000-4000-8000-0000000000a4','ff-unverified@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000a1';
update profiles set passcode_verified=true where id in ('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000a3');
do $$begin
 if(select count(*) from feature_flags)<>15 then raise exception 'Expected 15 seeded flags';end if;
 if exists(select 1 from feature_flags where enabled) then raise exception 'Seeded flag enabled';end if;
end$$;

-- unverified user
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a4',true);
do $$begin
 if exists(select 1 from feature_flags) then raise exception 'Unverified user read flags';end if;
 begin perform set_feature_flag('polls',true);raise exception 'Unverified set flag';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform mark_all_notifications_read();raise exception 'Unverified marked read';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
end$$;

-- verified member
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a2',true);
do $$begin
 if(select count(*) from feature_flags)<>15 then raise exception 'Member cannot read flags';end if;
 begin update feature_flags set enabled=true;raise exception 'Member updated flags directly';exception when insufficient_privilege then null;end;
 begin insert into feature_flags(key,label) values('x_flag','x');raise exception 'Member inserted flag';exception when insufficient_privilege then null;end;
 begin delete from feature_flags;raise exception 'Member deleted flags';exception when insufficient_privilege then null;end;
 begin perform set_feature_flag('polls',true);raise exception 'Member set flag';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 if exists(select 1 from feature_flag_events) then raise exception 'Member read flag audit';end if;
 if is_feature_enabled('no_such_flag') then raise exception 'Unknown flag enabled';end if;
 begin perform notify(auth.uid(),'t','x');raise exception 'Authenticated executed notify';exception when insufficient_privilege then null;end;
 begin insert into notifications(user_id,type,title) values(auth.uid(),'t','x');raise exception 'Direct notification insert';exception when insufficient_privilege then null;end;
end$$;

-- anon has no access
reset role;set local role anon;
do $$begin
 begin perform 1 from feature_flags;raise exception 'Anon read flags';exception when insufficient_privilege then null;end;
 begin perform is_feature_enabled('polls');raise exception 'Anon executed is_feature_enabled';exception when insufficient_privilege then null;end;
end$$;

-- notify no-op while disabled (service_role)
reset role;set local role service_role;
do $$declare r uuid;begin
 r:=notify('00000000-0000-4000-8000-0000000000a2','test','disabled');
 if r is not null or exists(select 1 from notifications) then raise exception 'notify not a no-op while disabled';end if;
end$$;

-- admin toggles
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',true);
do $$begin
 begin perform set_feature_flag('no_such_flag',true);raise exception 'Unknown key accepted';exception when raise_exception then if sqlerrm<>'UNKNOWN_FEATURE' then raise;end if;end;
 perform set_feature_flag('notifications',true);
 if not is_feature_enabled('notifications') then raise exception 'Flag not enabled';end if;
 if not exists(select 1 from feature_flags where key='notifications' and updated_by=auth.uid() and updated_at is not null) then raise exception 'updated_by not recorded';end if;
 if not exists(select 1 from feature_flag_events where flag_key='notifications' and enabled and actor_id=auth.uid()) then raise exception 'Audit row missing';end if;
 perform set_feature_flag('notifications',false);
 perform set_feature_flag('notifications',true);
 if(select count(*) from feature_flag_events where flag_key='notifications')<>3 then raise exception 'Audit rows not appended';end if;
end$$;

-- notify inserts when enabled
reset role;set local role service_role;
do $$declare r uuid;begin
 r:=notify('00000000-0000-4000-8000-0000000000a2','test','hello','body','/#announcements','{"a":1}');
 if r is null then raise exception 'notify did not insert';end if;
 perform notify('00000000-0000-4000-8000-0000000000a2','test','hello2',null,'#registration');
 perform notify('00000000-0000-4000-8000-0000000000a3','test','other user');
 begin perform notify('00000000-0000-4000-8000-0000000000a2','test','bad','b','https://evil.example');raise exception 'Absolute link accepted';exception when raise_exception then if sqlerrm<>'INVALID_LINK' then raise;end if;end;
 begin perform notify('00000000-0000-4000-8000-0000000000a2','test','bad','b','javascript:alert(1)');raise exception 'JS link accepted';exception when raise_exception then if sqlerrm<>'INVALID_LINK' then raise;end if;end;
end$$;

-- user sees only own; mark read RPCs
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a2',true);
do $$declare first_id uuid;n int;begin
 if(select count(*) from notifications)<>2 then raise exception 'Member sees wrong notification set';end if;
 if exists(select 1 from notifications where title='other user') then raise exception 'Member sees others notifications';end if;
 begin update notifications set read_at=now();raise exception 'Direct notification update';exception when insufficient_privilege then null;end;
 begin delete from notifications;raise exception 'Direct notification delete';exception when insufficient_privilege then null;end;
 select id into first_id from notifications where title='hello';
 n:=mark_notifications_read(array[first_id]);
 if n<>1 or (select read_at from notifications where id=first_id) is null then raise exception 'mark_notifications_read failed';end if;
 if mark_notifications_read(array[first_id])<>0 then raise exception 'Re-mark not idempotent';end if;
 if(select count(*) from notifications where read_at is null)<>1 then raise exception 'Unread count wrong';end if;
 if mark_all_notifications_read()<>1 then raise exception 'mark_all failed';end if;
 if exists(select 1 from notifications where read_at is null) then raise exception 'Unread remain';end if;
end$$;
-- cannot mark another user's notifications
reset role;set local role service_role;
select notify('00000000-0000-4000-8000-0000000000a2','test','fresh');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a3',true);
do $$begin
 if mark_notifications_read((select array_agg(id) from (select id from notifications) x))<>1 then raise exception 'Marked wrong count';end if;
 if mark_all_notifications_read()<>0 then raise exception 'Marked nothing expected';end if;
end$$;
reset role;
do $$begin
 if not exists(select 1 from notifications where title='fresh' and read_at is null) then raise exception 'Other user marked someone elses notification';end if;
end$$;
do $$begin
 if(select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications')<>1 then raise exception 'notifications not in realtime publication';end if;
end$$;
rollback;
