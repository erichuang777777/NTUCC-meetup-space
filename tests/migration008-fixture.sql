-- Disposable fixture BEFORE migration 008: simulate one already-reserved final seat.
insert into auth.users(id,email) values ('c0000000-0000-4000-8000-000000000001','legacy@example.test'),('c0000000-0000-4000-8000-000000000002','new@example.test');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('c1000000-0000-4000-8000-000000000001','Legacy full event',now()+interval '1 hour',now()+interval '2 hours',now()-interval '1 minute',1,true);
insert into event_registrations(id,event_id,user_id,status,ticket_token) values ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','registered','ntucc_ticket_'||repeat('e',64));

update event_registrations set checked_in_at='2026-11-18T01:00:00Z',checked_in_by='c0000000-0000-4000-8000-000000000002' where id='c2000000-0000-4000-8000-000000000001';
