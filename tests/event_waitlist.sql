\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,email_confirmed_at) values
('00000000-0000-4000-8000-0000000007a1','wl-a@example.test',now()),
('00000000-0000-4000-8000-0000000007a2','wl-b@example.test',now()),
('00000000-0000-4000-8000-0000000007a3','wl-c@example.test',now()),
('00000000-0000-4000-8000-0000000007a4','wl-d@example.test',now());
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published,waitlist_enabled) values
('e7000000-0000-4000-8000-000000000001','Waitlist',now()+interval '1 day',now()+interval '2 days',now()+interval '1 day',1,true,true),
('e7000000-0000-4000-8000-000000000002','NoWaitlist',now()+interval '1 day',now()+interval '2 days',now()+interval '1 day',1,true,false);

-- Flag OFF: old behavior (EVENT_FULL) even when the event opts in.
do $$declare r jsonb;begin
 perform submit_event_application('00000000-0000-4000-8000-0000000007a1','e7000000-0000-4000-8000-000000000001','A','台大','a@example.test');
 begin perform submit_event_application('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','B','台大','b@example.test');raise exception 'flag off waitlisted';exception when others then if sqlerrm not like '%EVENT_FULL%' then raise;end if;end;
 begin perform register_guest_event('e7000000-0000-4000-8000-000000000001',repeat('1',64),'G','台大','g@example.test','ntucc_ticket_'||repeat('1',64));raise exception 'flag off guest waitlisted';exception when others then if sqlerrm not like '%EVENT_FULL%' then raise;end if;end;
 if exists(select 1 from event_registrations where status='waitlisted') then raise exception 'waitlisted row while off';end if;
end$$;

update feature_flags set enabled=true where key in('event_waitlist','notifications');

do $$declare r jsonb;a uuid;b uuid;c uuid;g jsonb;tok text:='ntucc_ticket_'||repeat('2',64);begin
 -- Event with waitlist_enabled=false stays EVENT_FULL with flag on.
 perform submit_event_application('00000000-0000-4000-8000-0000000007a1','e7000000-0000-4000-8000-000000000002','A','台大','a@example.test');
 begin perform submit_event_application('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000002','B','台大','b@example.test');raise exception 'opt-out waitlisted';exception when others then if sqlerrm not like '%EVENT_FULL%' then raise;end if;end;
 -- Full + enabled: member B, guest G, member C queue in order.
 r:=submit_event_application('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','B','台大','b@example.test');
 if r->>'status'<>'waitlisted' or (r->>'waitlist_position')::int<>1 then raise exception 'B not waitlisted #1: %',r;end if;
 g:=register_guest_event('e7000000-0000-4000-8000-000000000001',repeat('3',64),'G','臺大','g@example.test',tok);
 if g->>'status'<>'waitlisted' or (g->>'waitlist_position')::int<>2 or g->'ticket'<>'null'::jsonb then raise exception 'G not waitlisted #2: %',g;end if;
 r:=submit_event_application('00000000-0000-4000-8000-0000000007a3','e7000000-0000-4000-8000-000000000001','C','台大','c@example.test');
 if (r->>'waitlist_position')::int<>3 then raise exception 'C not #3';end if;
 -- Idempotent resubmit keeps position; ineligible org is rejected, not waitlisted.
 r:=submit_event_application('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','B','台大','b@example.test');
 if r->>'status'<>'waitlisted' or (r->>'waitlist_position')::int<>1 then raise exception 'resubmit changed position';end if;
 r:=submit_event_application('00000000-0000-4000-8000-0000000007a4','e7000000-0000-4000-8000-000000000001','D','別院','d@example.test');
 if r->>'status'<>'rejected' then raise exception 'ineligible waitlisted';end if;
 -- No ticket while waitlisted (member, guest, check-in).
 begin perform event_ticket('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('4',64));raise exception 'ticket for waitlisted';exception when others then if sqlerrm not like '%TICKET_UNAVAILABLE%' then raise;end if;end;
 if (select ticket_token from event_registrations where guest_token_hash is not null) is not null then raise exception 'guest ticket while waitlisted';end if;
 g:=access_guest_event('e7000000-0000-4000-8000-000000000001',repeat('3',64));
 if g->>'status'<>'waitlisted' or g->'ticket'<>'null'::jsonb then raise exception 'guest access leaks ticket';end if;
 -- Member A cancels: B promoted in the same tx, notified; ticket now available.
 perform submit_event_application('00000000-0000-4000-8000-0000000007a1','e7000000-0000-4000-8000-000000000001','','','',true);
 if (select status from event_registrations where user_id='00000000-0000-4000-8000-0000000007a2' and event_id='e7000000-0000-4000-8000-000000000001')<>'registered' then raise exception 'B not promoted';end if;
 if (select count(*) from notifications where user_id='00000000-0000-4000-8000-0000000007a2' and type='waitlist_promoted')<>1 then raise exception 'no promote notification';end if;
 if (select count(*) from event_registrations where event_id='e7000000-0000-4000-8000-000000000001' and status='registered')<>1 then raise exception 'seat count';end if;
 perform event_ticket('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('4',64));
 -- Positions shift: G is #1, C #2.
 g:=access_guest_event('e7000000-0000-4000-8000-000000000001',repeat('3',64));
 if (g->>'waitlist_position')::int<>1 then raise exception 'G not #1 after promotion';end if;
 -- B cancels: guest G promoted, gets a valid ticket, no notification (no user).
 perform submit_event_application('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','','','',true);
 g:=access_guest_event('e7000000-0000-4000-8000-000000000001',repeat('3',64));
 if g->>'status'<>'registered' or g->'ticket'->>'token' !~ '^ntucc_ticket_[a-f0-9]{64}$' then raise exception 'guest not promoted with ticket: %',g;end if;
 -- Guest cancel promotes member C.
 g:=access_guest_event('e7000000-0000-4000-8000-000000000001',repeat('3',64),true);
 if g->>'status'<>'cancelled' then raise exception 'guest cancel';end if;
 if (select status from event_registrations where user_id='00000000-0000-4000-8000-0000000007a3')<>'registered' then raise exception 'C not promoted';end if;
 if (select count(*) from notifications where type='waitlist_promoted')<>2 then raise exception 'promotion notifications';end if;
 -- Waitlisted member cancelling does not free a seat or promote anyone.
 perform submit_event_application('00000000-0000-4000-8000-0000000007a1','e7000000-0000-4000-8000-000000000001','A','台大','a@example.test');
 if (select status from event_registrations where user_id='00000000-0000-4000-8000-0000000007a1' and event_id='e7000000-0000-4000-8000-000000000001')<>'waitlisted' then raise exception 'A not requeued';end if;
 perform submit_event_application('00000000-0000-4000-8000-0000000007a1','e7000000-0000-4000-8000-000000000001','','','',true);
 if (select count(*) from event_registrations where event_id='e7000000-0000-4000-8000-000000000001' and status='registered')<>1 then raise exception 'waitlist cancel changed seats';end if;
 -- Registered member changes to ineligible details: seat released, next promoted.
 perform submit_event_application('00000000-0000-4000-8000-0000000007a1','e7000000-0000-4000-8000-000000000001','A','台大','a@example.test');
 perform submit_event_application('00000000-0000-4000-8000-0000000007a3','e7000000-0000-4000-8000-000000000001','C','別院','c@example.test');
 if (select status from event_registrations where user_id='00000000-0000-4000-8000-0000000007a1' and event_id='e7000000-0000-4000-8000-000000000001')<>'registered' then raise exception 'A not promoted after C ineligible';end if;
 -- Capacity increase promotes the waitlist.
 perform submit_event_application('00000000-0000-4000-8000-0000000007a2','e7000000-0000-4000-8000-000000000001','B','台大','b@example.test');
 update public_events set capacity=2 where id='e7000000-0000-4000-8000-000000000001';
 if (select status from event_registrations where user_id='00000000-0000-4000-8000-0000000007a2')<>'registered' then raise exception 'capacity increase did not promote';end if;
 -- Anon/authenticated cannot call internals.
 if has_function_privilege('authenticated','public.promote_event_waitlist(uuid)','execute') or has_function_privilege('authenticated','public.event_waitlist_position(uuid)','execute') then raise exception 'internal grant';end if;
end$$;

-- Flag off after the fact: no promotion, data retained.
update feature_flags set enabled=false where key='event_waitlist';
do $$begin
 update public_events set capacity=1 where id='e7000000-0000-4000-8000-000000000002';
 if exists(select 1 from event_registrations where status='waitlisted' and event_id='e7000000-0000-4000-8000-000000000002') then raise exception 'unexpected';end if;
end$$;
rollback;
