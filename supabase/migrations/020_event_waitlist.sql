begin;
-- F7 event_waitlist: capacity already exists (public_events.capacity, 006). This adds an opt-in waitlist.
-- Seat semantics (unchanged): only status='registered' holds a seat (members and guests alike). 'pending' (legacy 008
-- rows), 'rejected', 'cancelled' and the new 'waitlisted' never hold one. Only keyword-eligible applicants are
-- waitlisted (eligibility_status='approved'), so promotion goes straight to 'registered' (008 has no manual review step).
-- Waitlist order: waitlisted_at (clock_timestamp taken under the event row lock, so it is monotonic), then id.
-- Every seat-freeing path (cancel by member/guest, change to ineligible details, capacity increase) promotes in the same tx.
alter table public.public_events add column waitlist_enabled boolean not null default false;
alter table public.event_registrations add column waitlisted_at timestamptz;
alter table public.event_registrations drop constraint event_registrations_status_check;
alter table public.event_registrations add constraint event_registrations_status_check check(status in ('pending','registered','cancelled','rejected','waitlisted'));
alter table public.event_registrations add constraint waitlisted_at_check check((status='waitlisted')=(waitlisted_at is not null));
create index event_registrations_waitlist on public.event_registrations(event_id,waitlisted_at,id) where status='waitlisted';

create function public.event_waitlist_position(p_registration uuid) returns integer language sql stable security definer set search_path=public as $$
 select case when r.status='waitlisted' then (select count(*)::integer from event_registrations x where x.event_id=r.event_id and x.status='waitlisted' and (x.waitlisted_at,x.id)<=(r.waitlisted_at,r.id)) end
 from event_registrations r where r.id=p_registration$$;
revoke all on function public.event_waitlist_position(uuid) from public,anon,authenticated;
grant execute on function public.event_waitlist_position(uuid) to service_role;

-- Internal: caller MUST already hold the event row lock (for no key update / the UPDATE itself).
create function public.promote_event_waitlist(p_event uuid) returns integer language plpgsql security definer set search_path=public as $$
declare e public_events;w event_registrations;n integer:=0;begin
 if not is_feature_enabled('event_waitlist') then return 0;end if;
 select * into e from public_events where id=p_event;
 if not found or e.status<>'scheduled' then return 0;end if;
 loop
  exit when (select count(*) from event_registrations where event_id=p_event and status='registered')>=e.capacity;
  select * into w from event_registrations where event_id=p_event and status='waitlisted' order by waitlisted_at,id limit 1 for update;
  exit when not found;
  update event_registrations set status='registered',waitlisted_at=null,updated_at=now() where id=w.id;
  -- Guests have no account: give them a ticket now (the status change invalidated any earlier one). Members fetch theirs lazily.
  if w.guest_token_hash is not null then
   update event_registrations set ticket_token='ntucc_ticket_'||replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','') where id=w.id;
  else
   perform notify(w.user_id,'waitlist_promoted','候補已遞補成功',e.title,'#event/'||p_event,jsonb_build_object('event_id',p_event));
  end if;
  n:=n+1;
 end loop;
 return n;
end$$;
revoke all on function public.promote_event_waitlist(uuid) from public,anon,authenticated,service_role;

create function public.promote_on_capacity_increase() returns trigger language plpgsql security definer set search_path=public as $$begin
 perform promote_event_waitlist(new.id);return null;
end$$;
revoke all on function public.promote_on_capacity_increase() from public,anon,authenticated,service_role;
create trigger public_events_promote_waitlist after update of capacity,status on public.public_events for each row when(new.capacity>old.capacity or (new.status='scheduled' and old.status<>'scheduled')) execute function public.promote_on_capacity_increase();

-- Legacy 006 RPC: identical except a cancellation now promotes the waitlist.
create or replace function public.register_public_event(p_user uuid,p_event uuid,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events; r event_registrations; begin
 select * into e from public_events where id=p_event for no key update;
 if not found then raise exception 'EVENT_NOT_FOUND'; end if;
 if not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null) then raise exception 'EMAIL_NOT_VERIFIED';end if;
 select * into r from event_registrations where user_id=p_user and event_id=p_event;
 if p_cancel then
  if r.id is null then return jsonb_build_object('status','cancelled','id',null);end if;
  update event_registrations set status='cancelled',waitlisted_at=null,updated_at=now() where id=r.id;
  if r.status='registered' then perform promote_event_waitlist(p_event);end if;
  return jsonb_build_object('status','cancelled','id',r.id);
 end if;
 if not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
 if e.status='cancelled' then raise exception 'EVENT_CANCELLED';end if;
 if r.status='registered' then return jsonb_build_object('status','registered','id',r.id);end if;
 if now() >= e.registration_closes_at then raise exception 'REGISTRATION_CLOSED';end if;
 if (select count(*) from event_registrations where event_id=p_event and status='registered') >= e.capacity then raise exception 'EVENT_FULL';end if;
 insert into event_registrations(event_id,user_id,status) values(p_event,p_user,'registered')
 on conflict(event_id,user_id) do update set status='registered',waitlisted_at=null,updated_at=now() returning * into r;
 return jsonb_build_object('status','registered','id',r.id);
end$$;

create or replace function public.submit_event_application(p_user uuid,p_event uuid,p_name text,p_organization text,p_email text,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events;r event_registrations;eligible boolean;prev text;target text;res jsonb;begin
 select * into e from public_events where id=p_event for no key update;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 select * into r from event_registrations where user_id=p_user and event_id=p_event for update;
 prev:=r.status;
 if p_cancel then
  if r.id is not null then update event_registrations set status='cancelled',ticket_token=null,waitlisted_at=null,updated_at=now() where id=r.id returning * into r;end if;
  if prev='registered' then perform promote_event_waitlist(p_event);end if;
  return jsonb_build_object('status','cancelled','id',r.id);
 end if;
 if not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
 if e.status<>'scheduled' then raise exception 'EVENT_CANCELLED';end if;
 if length(trim(p_name)) not between 1 and 100 or length(trim(p_organization)) not between 1 and 200 or length(p_email)>254 then raise exception 'INVALID_APPLICATION';end if;
 eligible:=position('台大' in replace(p_organization,'臺','台'))>0;
 if r.id is not null and r.status<>'cancelled' and r.applicant_name=p_name and r.organization=p_organization and lower(r.contact_email)=lower(p_email) then
  return jsonb_build_object('id',r.id,'status',r.status,'eligibility_status',r.eligibility_status)||case when r.status='waitlisted' then jsonb_build_object('waitlist_position',event_waitlist_position(r.id)) else '{}'::jsonb end;
 end if;
 -- Existing reserved seats may complete migration-required details after the cutoff.
 if clock_timestamp()>=e.registration_closes_at and not (r.id is not null and r.status='registered' and r.eligibility_status='pending') then raise exception 'REGISTRATION_CLOSED';end if;
 target:=case when eligible then 'registered' else 'rejected' end;
 if eligible and (select count(*) from event_registrations where event_id=p_event and status='registered' and (r.id is null or id<>r.id))>=e.capacity then
  if not (is_feature_enabled('event_waitlist') and e.waitlist_enabled) then raise exception 'EVENT_FULL';end if;
  target:='waitlisted';
 end if;
 insert into event_registrations(event_id,user_id,status,applicant_name,organization,contact_email,eligibility_status,review_reason,waitlisted_at)
 values(p_event,p_user,target,p_name,p_organization,lower(p_email),case when eligible then 'approved' else 'rejected' end,case when eligible then null else '本活動限台大醫療體系參與，您填寫的單位未包含台大，這次暫無法受理報名。' end,case when target='waitlisted' then clock_timestamp() end)
 on conflict(event_id,user_id) do update set status=excluded.status,applicant_name=excluded.applicant_name,organization=excluded.organization,contact_email=excluded.contact_email,eligibility_status=excluded.eligibility_status,review_reason=excluded.review_reason,ticket_token=null,checked_in_at=case when event_registrations.status='registered' and excluded.status='registered' then event_registrations.checked_in_at else null end,checked_in_by=case when event_registrations.status='registered' and excluded.status='registered' then event_registrations.checked_in_by else null end,
  waitlisted_at=case when excluded.status='waitlisted' then coalesce(event_registrations.waitlisted_at,excluded.waitlisted_at) end,updated_at=now() returning * into r;
 -- A registered applicant who changed to ineligible details releases the seat.
 if prev='registered' and r.status<>'registered' then perform promote_event_waitlist(p_event);end if;
 res:=jsonb_build_object('id',r.id,'status',r.status,'eligibility_status',r.eligibility_status,'review_reason',r.review_reason);
 if r.status='waitlisted' then res:=res||jsonb_build_object('waitlist_position',event_waitlist_position(r.id));end if;
 return res;
end$$;

create or replace function public.register_guest_event(p_event uuid,p_hash text,p_name text,p_organization text,p_email text,p_ticket text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events;r event_registrations;target text;begin
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
 if e.status<>'scheduled' then raise exception 'EVENT_CANCELLED';end if;
 if p_hash !~ '^[a-f0-9]{64}$' or p_ticket !~ '^ntucc_ticket_[a-f0-9]{64}$' or length(trim(p_name)) not between 1 and 100 or length(trim(p_organization)) not between 1 and 200 or length(p_email) not between 3 and 254 then raise exception 'INVALID_APPLICATION';end if;
 select * into r from event_registrations where guest_token_hash=p_hash for update;
 if found then
  if r.event_id<>p_event or r.applicant_name<>p_name or r.organization<>p_organization or r.contact_email<>lower(p_email) then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if r.guest_expires_at<=now() then raise exception 'GUEST_ACCESS_EXPIRED';end if;
  return jsonb_build_object('registration_id',r.id,'status',r.status,'ticket',case when r.status='registered' then jsonb_build_object('token',r.ticket_token) else null end)||case when r.status='waitlisted' then jsonb_build_object('waitlist_position',event_waitlist_position(r.id)) else '{}'::jsonb end;
 end if;
 if position('台大' in replace(p_organization,'臺','台'))=0 then raise exception 'ORGANIZATION_NOT_ELIGIBLE';end if;
 if clock_timestamp()>=e.registration_closes_at then raise exception 'REGISTRATION_CLOSED';end if;
 target:='registered';
 if (select count(*) from event_registrations where event_id=p_event and status='registered')>=e.capacity then
  if not (is_feature_enabled('event_waitlist') and e.waitlist_enabled) then raise exception 'EVENT_FULL';end if;
  target:='waitlisted';
 end if;
 insert into event_registrations(event_id,user_id,status,applicant_name,organization,contact_email,eligibility_status,ticket_token,guest_token_hash,guest_expires_at,waitlisted_at)
 values(p_event,null,target,p_name,p_organization,lower(p_email),'approved',case when target='registered' then p_ticket end,p_hash,greatest(e.ends_at,now())+interval '30 days',case when target='waitlisted' then clock_timestamp() end) returning * into r;
 if target='waitlisted' then return jsonb_build_object('registration_id',r.id,'status',r.status,'ticket',null,'waitlist_position',event_waitlist_position(r.id));end if;
 return jsonb_build_object('registration_id',r.id,'status',r.status,'ticket',jsonb_build_object('token',r.ticket_token));
end$$;

create or replace function public.access_guest_event(p_event uuid,p_hash text,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r event_registrations;e public_events;prev text;res jsonb;begin
 select * into e from public_events where id=p_event for no key update;
 select * into r from event_registrations where event_id=p_event and guest_token_hash=p_hash and guest_expires_at>now() for update;
 if not found then raise exception 'INVALID_GUEST_TOKEN';end if;
 prev:=r.status;
 if p_cancel then
  update event_registrations set status='cancelled',ticket_token=null,waitlisted_at=null,updated_at=now() where id=r.id returning * into r;
  if prev='registered' then perform promote_event_waitlist(p_event);end if;
 end if;
 res:=jsonb_build_object('registration_id',r.id,'status',r.status,'applicant_name',r.applicant_name,'organization',r.organization,'contact_email',r.contact_email,'checked_in_at',r.checked_in_at,'ticket',case when r.status='registered' and e.is_published and e.status='scheduled' then jsonb_build_object('token',r.ticket_token,'checked_in_at',r.checked_in_at) else null end);
 if r.status='waitlisted' then res:=res||jsonb_build_object('waitlist_position',event_waitlist_position(r.id));end if;
 return res;
end$$;
commit;
