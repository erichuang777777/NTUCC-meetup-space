-- Disposable database only, after migrations 001..007.
begin;
set local timezone='Pacific/Honolulu';
insert into auth.users(id,email) values ('e0000000-0000-4000-8000-000000000001','attendee@example.test'),('e0000000-0000-4000-8000-000000000002','staff@example.test'),('e0000000-0000-4000-8000-000000000003','outsider@example.test');
update profiles set passcode_verified=true where id='e0000000-0000-4000-8000-000000000002';
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published,checkin_opens_at,checkin_closes_at) values ('e1000000-0000-4000-8000-000000000001','QR test',now()+interval '1 hour',now()+interval '2 hours',now()+interval '30 minutes',5,true,now()-interval '1 hour',now()+interval '3 hours');
insert into event_staff values ('e1000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000002');
do $$declare t text:='ntucc_ticket_'||repeat('a',64); t2 text:='ntucc_ticket_'||repeat('b',64); r jsonb; first_time timestamptz;begin
 if has_function_privilege('authenticated','public.event_ticket(uuid,uuid,text)','EXECUTE') or has_table_privilege('anon','public.event_staff','SELECT') then raise exception 'Unexpected privilege';end if;
 perform register_public_event('e0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001');
 r:=event_ticket('e0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',t);
 if r->>'token'<>t then raise exception 'Issue failed';end if;
 r:=event_ticket('e0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',t2);
 if r->>'token'<>t then raise exception 'Repeated retrieval rotated ticket';end if;
 begin perform check_in_public_event('e0000000-0000-4000-8000-000000000003','e1000000-0000-4000-8000-000000000001',t);raise exception 'FAIL permission';exception when others then if SQLERRM<>'STAFF_REQUIRED' then raise;end if;end;
 begin perform check_in_public_event('e0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',t2);raise exception 'FAIL guess';exception when others then if SQLERRM<>'INVALID_TICKET' then raise;end if;end;
 r:=check_in_public_event('e0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',t);first_time:=(r->>'checked_in_at')::timestamptz;
 if (r->>'already_checked_in')::boolean then raise exception 'First scan duplicate';end if;
 r:=check_in_public_event('e0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',t);
 if not (r->>'already_checked_in')::boolean or (r->>'checked_in_at')::timestamptz<>first_time then raise exception 'Not idempotent';end if;
 perform register_public_event('e0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',true);
 perform register_public_event('e0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001');
 perform event_ticket('e0000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',t2);
 begin perform check_in_public_event('e0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',t);raise exception 'FAIL stale';exception when others then if SQLERRM<>'INVALID_TICKET' then raise;end if;end;
 update public_events set checkin_opens_at=now()+interval '4 hours',checkin_closes_at=now()+interval '5 hours' where id='e1000000-0000-4000-8000-000000000001';
 begin perform check_in_public_event('e0000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001',t2);raise exception 'FAIL window';exception when others then if SQLERRM<>'CHECKIN_CLOSED' then raise;end if;end;
end$$;
rollback;
