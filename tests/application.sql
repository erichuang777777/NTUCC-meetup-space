-- Disposable database only, after migration 008.
begin;
insert into auth.users(id,email) values ('b0000000-0000-4000-8000-000000000001','login@example.test'),('b0000000-0000-4000-8000-000000000002','other@example.test');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('b1000000-0000-4000-8000-000000000001','Application test',now()+interval '1 day',now()+interval '2 days',now()+interval '1 hour',1,true);
do $$declare r jsonb;begin
 r:=submit_event_application('b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','姓名','其他醫院','personal@example.test');
 if r->>'status'<>'rejected' then raise exception 'Keyword filter failed';end if;
 begin perform event_ticket('b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('d',64));raise exception 'FAIL rejected ticket';exception when others then if SQLERRM<>'TICKET_UNAVAILABLE' then raise;end if;end;
 r:=submit_event_application('b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','姓名','台大醫院','personal@example.test');
 if r->>'status'<>'registered' then raise exception 'Personal email rejected';end if;
 perform event_ticket('b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('d',64));
 begin perform submit_event_application('b0000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001','另一人','台大','other@example.test');raise exception 'FAIL capacity';exception when others then if SQLERRM<>'EVENT_FULL' then raise;end if;end;
 r:=submit_event_application('b0000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','姓名','臺大醫院','personal@example.test');
 if r->>'status'<>'registered' then raise exception 'Traditional character rejected';end if;
 if exists(select 1 from event_registrations where user_id='b0000000-0000-4000-8000-000000000001' and ticket_token is not null) then raise exception 'Changed application retained old QR';end if;
end$$;
rollback;
