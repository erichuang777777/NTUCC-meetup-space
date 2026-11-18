-- Lightweight user-requested organization keyword screening; not employment verification.
alter table public.event_registrations add column applicant_name text;
alter table public.event_registrations add column organization text;
alter table public.event_registrations add column contact_email text;
alter table public.event_registrations add column eligibility_status text not null default 'pending' check(eligibility_status in ('pending','approved','rejected'));
alter table public.event_registrations add column review_reason text;
alter table public.event_registrations drop constraint event_registrations_status_check;
alter table public.event_registrations add constraint event_registrations_status_check check(status in ('pending','registered','cancelled','rejected'));
-- Legacy rows/seats are retained; existing tickets require the attendee to supply the new fields.
update public.event_registrations set ticket_token=null;
create function public.submit_event_application(p_user uuid,p_event uuid,p_name text,p_organization text,p_email text,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events;r event_registrations;eligible boolean;begin
 select * into e from public_events where id=p_event for no key update;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 select * into r from event_registrations where user_id=p_user and event_id=p_event for update;
 if p_cancel then
  if r.id is not null then update event_registrations set status='cancelled',ticket_token=null,updated_at=now() where id=r.id returning * into r;end if;
  return jsonb_build_object('status','cancelled','id',r.id);
 end if;
 if not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
 if e.status<>'scheduled' then raise exception 'EVENT_CANCELLED';end if;
 if length(trim(p_name)) not between 1 and 100 or length(trim(p_organization)) not between 1 and 200 or length(p_email)>254 then raise exception 'INVALID_APPLICATION';end if;
 eligible:=position('台大' in replace(p_organization,'臺','台'))>0;
 if r.id is not null and r.status<>'cancelled' and r.applicant_name=p_name and r.organization=p_organization and lower(r.contact_email)=lower(p_email) then
  return jsonb_build_object('id',r.id,'status',r.status,'eligibility_status',r.eligibility_status);
 end if;
 -- Existing reserved seats may complete migration-required details after the cutoff.
 if clock_timestamp()>=e.registration_closes_at and not (r.id is not null and r.status='registered' and r.eligibility_status='pending') then raise exception 'REGISTRATION_CLOSED';end if;
 if eligible and (select count(*) from event_registrations where event_id=p_event and status='registered' and (r.id is null or id<>r.id))>=e.capacity then raise exception 'EVENT_FULL';end if;
 insert into event_registrations(event_id,user_id,status,applicant_name,organization,contact_email,eligibility_status,review_reason)
 values(p_event,p_user,case when eligible then 'registered' else 'rejected' end,p_name,p_organization,lower(p_email),case when eligible then 'approved' else 'rejected' end,case when eligible then null else '本活動限台大醫療體系參與，您填寫的單位未包含台大，這次暫無法受理報名。' end)
 on conflict(event_id,user_id) do update set status=excluded.status,applicant_name=excluded.applicant_name,organization=excluded.organization,contact_email=excluded.contact_email,eligibility_status=excluded.eligibility_status,review_reason=excluded.review_reason,ticket_token=null,checked_in_at=case when event_registrations.status='registered' and excluded.status='registered' then event_registrations.checked_in_at else null end,checked_in_by=case when event_registrations.status='registered' and excluded.status='registered' then event_registrations.checked_in_by else null end,updated_at=now() returning * into r;
 return jsonb_build_object('id',r.id,'status',r.status,'eligibility_status',r.eligibility_status,'review_reason',r.review_reason);
end$$;
revoke all on function public.submit_event_application(uuid,uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.submit_event_application(uuid,uuid,text,text,text,boolean) to service_role;

create or replace function public.event_ticket(p_user uuid,p_event uuid,p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events; r event_registrations;begin
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published or e.status<>'scheduled' then raise exception 'TICKET_UNAVAILABLE';end if;
 select * into r from event_registrations where user_id=p_user and event_id=p_event for update;
 if not found or r.status<>'registered' or r.eligibility_status<>'approved' then raise exception 'TICKET_UNAVAILABLE';end if;
 if p_token !~ '^ntucc_ticket_[a-f0-9]{64}$' then raise exception 'INVALID_TICKET';end if;
 if r.ticket_token is null then
  update event_registrations set ticket_token=p_token where id=r.id returning * into r;
 end if;
 return jsonb_build_object('token',r.ticket_token,'registration_id',r.id,'event_id',p_event,'checked_in_at',r.checked_in_at);
end$$;
create or replace function public.check_in_public_event(p_actor uuid,p_event uuid,p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events; r event_registrations; previous boolean;begin
 if not exists(select 1 from profiles p where p.id=p_actor and p.passcode_verified and (p.role='admin' or exists(select 1 from event_staff s where s.event_id=p_event and s.user_id=p_actor))) then raise exception 'STAFF_REQUIRED';end if;
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published or e.status<>'scheduled' then raise exception 'CHECKIN_UNAVAILABLE';end if;
 if clock_timestamp()<coalesce(e.checkin_opens_at,e.starts_at) or clock_timestamp()>coalesce(e.checkin_closes_at,e.ends_at) then raise exception 'CHECKIN_CLOSED';end if;
 select * into r from event_registrations where event_id=p_event and ticket_token=p_token and status='registered' and eligibility_status='approved' for update;
 if not found then raise exception 'INVALID_TICKET';end if;
 previous:=r.checked_in_at is not null;
 if not previous then
  update event_registrations set checked_in_at=clock_timestamp(),checked_in_by=p_actor where id=r.id returning * into r;
 end if;
 return jsonb_build_object('registration_id',r.id,'checked_in_at',r.checked_in_at,'already_checked_in',previous,'display_name',(select display_name from profiles where id=r.user_id));
end$$;
