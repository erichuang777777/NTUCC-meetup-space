-- Run only in disposable test DB after migrations 001..006.
begin;
insert into auth.users(id,email) values ('f0000000-0000-4000-8000-000000000001','external@example.test'),('f0000000-0000-4000-8000-000000000002','other@example.test');
insert into public.public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('f1000000-0000-4000-8000-000000000001','Public test',now()+interval '1 day',now()+interval '2 days',now()+interval '1 hour',1,true),('f1000000-0000-4000-8000-000000000002','Draft test',now()+interval '1 day',now()+interval '2 days',now()+interval '1 hour',1,false);
do $$begin
 if has_table_privilege('anon','public.public_events','SELECT') or has_table_privilege('authenticated','public.event_registrations','SELECT') then raise exception 'Unexpected direct read grant';end if;
 if has_function_privilege('authenticated','public.register_public_event(uuid,uuid,boolean)','EXECUTE') then raise exception 'Unexpected RPC grant';end if;
 perform register_public_event('f0000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001');
 perform register_public_event('f0000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001');
 if (select count(*) from event_registrations where event_id='f1000000-0000-4000-8000-000000000001')<>1 then raise exception 'Duplicate';end if;
 begin perform register_public_event('f0000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000001');raise exception 'FAIL full';exception when others then if SQLERRM<>'EVENT_FULL' then raise;end if;end;
 begin perform register_public_event('f0000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002');raise exception 'FAIL draft';exception when others then if SQLERRM<>'EVENT_NOT_FOUND' then raise;end if;end;
 perform register_public_event('f0000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',true);
 perform register_public_event('f0000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',true);
 perform register_public_event('f0000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000001');
 if (select passcode_verified from profiles where id='f0000000-0000-4000-8000-000000000001') then raise exception 'Membership escalated';end if;
 update public_events set status='cancelled' where id='f1000000-0000-4000-8000-000000000001';
 if (select sequence from public_events where id='f1000000-0000-4000-8000-000000000001')<>1 then raise exception 'Revision missing';end if;
 begin perform register_public_event('f0000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001');raise exception 'FAIL cancelled';exception when others then if SQLERRM<>'EVENT_CANCELLED' then raise;end if;end;
end$$;
rollback;
