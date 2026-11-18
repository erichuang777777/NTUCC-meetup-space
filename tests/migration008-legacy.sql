-- Verify migration retained the exact seat, and allow completing details after cutoff.
do $$declare r jsonb;begin
 if not exists(select 1 from event_registrations where id='c2000000-0000-4000-8000-000000000001' and status='registered' and eligibility_status='pending' and ticket_token is null) then raise exception 'Legacy migration did not preserve seat/reset ticket';end if;
 r:=submit_event_application('c0000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','原報名者','台大醫院','personal@example.test');
 if r->>'id'<>'c2000000-0000-4000-8000-000000000001' or r->>'status'<>'registered' or r->>'eligibility_status'<>'approved' then raise exception 'Legacy completion lost seat';end if;
 if not exists(select 1 from event_registrations where id='c2000000-0000-4000-8000-000000000001' and checked_in_at='2026-11-18T01:00:00Z' and checked_in_by='c0000000-0000-4000-8000-000000000002') then raise exception 'Legacy check-in lost';end if;
 r:=event_ticket('c0000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('f',64));
 if r->>'token'<>'ntucc_ticket_'||repeat('f',64) then raise exception 'New QR not issued';end if;
 begin perform submit_event_application('c0000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000001','新報名者','台大醫院','new@example.test');raise exception 'FAIL cutoff';exception when others then if SQLERRM<>'REGISTRATION_CLOSED' then raise;end if;end;
 if (select count(*) from event_registrations where event_id='c1000000-0000-4000-8000-000000000001' and status='registered')<>1 then raise exception 'Seat count changed';end if;
end$$;
delete from public_events where id='c1000000-0000-4000-8000-000000000001';
delete from profiles where id in ('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002');
delete from auth.users where id in ('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002');
