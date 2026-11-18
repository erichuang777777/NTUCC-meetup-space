-- Guest registration is not an auth user or forum membership. Capabilities are hashed.
alter table public.event_registrations alter column user_id drop not null;
alter table public.event_registrations add column guest_token_hash text unique;
alter table public.event_registrations add column guest_expires_at timestamptz;
alter table public.event_registrations add constraint registration_identity check
 ((user_id is not null and guest_token_hash is null) or (user_id is null and guest_token_hash is not null));
create table public.event_guest_limits (key text primary key, window_start timestamptz not null, hits integer not null);
alter table public.event_guest_limits enable row level security;
revoke all on public.event_guest_limits from public,anon,authenticated;
grant all on public.event_guest_limits to service_role;
create function public.consume_guest_quota(p_key text,p_limit integer) returns boolean
language plpgsql security definer set search_path=public as $$
declare n integer;begin
 delete from event_guest_limits where window_start < now()-interval '2 hours';
 insert into event_guest_limits values(p_key,date_trunc('hour',now()),1)
 on conflict(key) do update set hits=case when event_guest_limits.window_start=date_trunc('hour',now()) then event_guest_limits.hits+1 else 1 end,window_start=date_trunc('hour',now()) returning hits into n;
 return n<=p_limit;
end$$;
create function public.register_guest_event(p_event uuid,p_hash text,p_name text,p_organization text,p_email text,p_ticket text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events;r event_registrations;begin
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
 if e.status<>'scheduled' then raise exception 'EVENT_CANCELLED';end if;
 if p_hash !~ '^[a-f0-9]{64}$' or p_ticket !~ '^ntucc_ticket_[a-f0-9]{64}$' or length(trim(p_name)) not between 1 and 100 or length(trim(p_organization)) not between 1 and 200 or length(p_email) not between 3 and 254 then raise exception 'INVALID_APPLICATION';end if;
 select * into r from event_registrations where guest_token_hash=p_hash for update;
 if found then
  if r.event_id<>p_event or r.applicant_name<>p_name or r.organization<>p_organization or r.contact_email<>lower(p_email) then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if r.guest_expires_at<=now() then raise exception 'GUEST_ACCESS_EXPIRED';end if;
  return jsonb_build_object('registration_id',r.id,'status',r.status,'ticket',case when r.status='registered' then jsonb_build_object('token',r.ticket_token) else null end);
 end if;
 if position('台大' in replace(p_organization,'臺','台'))=0 then raise exception 'ORGANIZATION_NOT_ELIGIBLE';end if;
 if clock_timestamp()>=e.registration_closes_at then raise exception 'REGISTRATION_CLOSED';end if;
 if (select count(*) from event_registrations where event_id=p_event and status='registered')>=e.capacity then raise exception 'EVENT_FULL';end if;
 insert into event_registrations(event_id,user_id,status,applicant_name,organization,contact_email,eligibility_status,ticket_token,guest_token_hash,guest_expires_at)
 values(p_event,null,'registered',p_name,p_organization,lower(p_email),'approved',p_ticket,p_hash,greatest(e.ends_at,now())+interval '30 days') returning * into r;
 return jsonb_build_object('registration_id',r.id,'status',r.status,'ticket',jsonb_build_object('token',r.ticket_token));
end$$;
create function public.access_guest_event(p_event uuid,p_hash text,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r event_registrations;e public_events;begin
 select * into e from public_events where id=p_event for no key update;
 select * into r from event_registrations where event_id=p_event and guest_token_hash=p_hash and guest_expires_at>now() for update;
 if not found then raise exception 'INVALID_GUEST_TOKEN';end if;
 if p_cancel then update event_registrations set status='cancelled',ticket_token=null,updated_at=now() where id=r.id returning * into r;end if;
 return jsonb_build_object('registration_id',r.id,'status',r.status,'applicant_name',r.applicant_name,'organization',r.organization,'contact_email',r.contact_email,'checked_in_at',r.checked_in_at,'ticket',case when r.status='registered' and e.is_published and e.status='scheduled' then jsonb_build_object('token',r.ticket_token,'checked_in_at',r.checked_in_at) else null end);
end$$;
revoke all on function public.consume_guest_quota(text,integer),public.register_guest_event(uuid,text,text,text,text,text),public.access_guest_event(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.consume_guest_quota(text,integer),public.register_guest_event(uuid,text,text,text,text,text),public.access_guest_event(uuid,text,boolean) to service_role;

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
 return jsonb_build_object('registration_id',r.id,'checked_in_at',r.checked_in_at,'already_checked_in',previous,'display_name',coalesce(r.applicant_name,(select display_name from profiles where id=r.user_id)));
end$$;
