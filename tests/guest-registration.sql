begin;
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values('b1000000-0000-4000-8000-000000000001','guest test',now()+interval '1 day',now()+interval '2 days',now()+interval '1 day',1,true);
do $$declare r jsonb;t text:='ntucc_ticket_'||repeat('a',64);begin
 r:=register_guest_event('b1000000-0000-4000-8000-000000000001',repeat('a',64),'guest','臺大','a@example.test',t);
 if r->>'status'<>'registered' then raise exception 'guest failed';end if;
 perform register_guest_event('b1000000-0000-4000-8000-000000000001',repeat('a',64),'guest','臺大','a@example.test',t);
 if (select count(*) from event_registrations where event_id='b1000000-0000-4000-8000-000000000001')<>1 then raise exception 'duplicate retry';end if;
 begin perform register_guest_event('b1000000-0000-4000-8000-000000000001',repeat('b',64),'other','台大','a@example.test',t);raise exception 'capacity bypass';exception when others then if sqlerrm not like '%EVENT_FULL%' then raise;end if;end;
 begin perform access_guest_event('b1000000-0000-4000-8000-000000000001',repeat('b',64));raise exception 'token bypass';exception when others then if sqlerrm not like '%INVALID_GUEST_TOKEN%' then raise;end if;end;
 r:=access_guest_event('b1000000-0000-4000-8000-000000000001',repeat('a',64),true);
 if r->>'status'<>'cancelled' or r->'ticket'<>'null'::jsonb then raise exception 'cancel failed';end if;
 begin perform register_guest_event('b1000000-0000-4000-8000-000000000001',repeat('b',64),'other','other hospital','a@example.test',t);raise exception 'eligibility bypass';exception when others then if sqlerrm not like '%ORGANIZATION_NOT_ELIGIBLE%' then raise;end if;end;
 if not consume_guest_quota('test',1) or consume_guest_quota('test',1) then raise exception 'quota failed';end if;
 if exists(select 1 from event_registrations where guest_token_hash is not null and user_id is not null) then raise exception 'guest got user';end if;
 if has_function_privilege('anon','public.register_guest_event(uuid,text,text,text,text,text)','execute') then raise exception 'anon direct rpc';end if;
end$$;
rollback;
