-- Complete the shared public-event registration flow. No membership is granted.
alter table public.event_registrations add column meal_preference text not null default '不需餐盒'
 check (meal_preference in ('葷食','素食','不需餐盒'));
create index event_registration_email on public.event_registrations(event_id,lower(trim(contact_email))) where status='registered';

-- Serialize with capacity/check-in/cancellation writes. Existing duplicate records
-- are retained for administrator review; new active duplicates cannot be added.
create function public.enforce_event_registration_email() returns trigger
language plpgsql set search_path=public as $$begin
 if new.status='registered' and nullif(trim(new.contact_email),'') is not null and
  (tg_op='INSERT' or old.status is distinct from new.status or lower(trim(old.contact_email)) is distinct from lower(trim(new.contact_email))) then
  perform 1 from public_events where id=new.event_id for no key update;
  if exists(select 1 from event_registrations where event_id=new.event_id and status='registered'
   and lower(trim(contact_email))=lower(trim(new.contact_email)) and id<>new.id
   and (new.user_id is null or user_id is distinct from new.user_id)) then
   raise exception 'REGISTRATION_CONFLICT';
  end if;
 end if;
 return new;
end$$;
create trigger event_registration_email_guard before insert or update on public.event_registrations
 for each row execute function public.enforce_event_registration_email();

create function public.register_guest_event_details(p_event uuid,p_hash text,p_name text,p_organization text,p_email text,p_ticket text,p_meal text)
returns jsonb language plpgsql security definer set search_path=public as $$declare result jsonb;r event_registrations;begin
 if p_meal is null or p_meal not in ('葷食','素食','不需餐盒') then raise exception 'INVALID_APPLICATION';end if;
 perform 1 from public_events where id=p_event for no key update;
 select * into r from event_registrations where guest_token_hash=p_hash;
 if found and r.meal_preference<>p_meal then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 result:=register_guest_event(p_event,p_hash,p_name,p_organization,lower(trim(p_email)),p_ticket);
 update event_registrations set meal_preference=p_meal where guest_token_hash=p_hash and event_id=p_event;
 return result;
end$$;
create function public.submit_event_application_details(p_user uuid,p_event uuid,p_name text,p_organization text,p_email text,p_cancel boolean,p_meal text)
returns jsonb language plpgsql security definer set search_path=public as $$declare result jsonb;r event_registrations;e public_events;begin
 if p_meal is null or p_meal not in ('葷食','素食','不需餐盒') then raise exception 'INVALID_APPLICATION';end if;
 select * into e from public_events where id=p_event for no key update;
 select * into r from event_registrations where user_id=p_user and event_id=p_event for update;
 if not p_cancel and r.status='registered' and r.eligibility_status='approved' then
  if not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
  if e.status<>'scheduled' then raise exception 'EVENT_CANCELLED';end if;
  if r.applicant_name is distinct from p_name or r.organization is distinct from p_organization or r.contact_email is distinct from lower(trim(p_email)) or r.meal_preference is distinct from p_meal then
   perform update_event_registration(p_event,p_user,null,p_name,p_organization,p_email,p_meal);
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'eligibility_status',r.eligibility_status);
 end if;
 result:=submit_event_application(p_user,p_event,p_name,p_organization,lower(trim(p_email)),p_cancel);
 if not p_cancel then update event_registrations set meal_preference=p_meal where user_id=p_user and event_id=p_event;end if;
 return result;
end$$;

-- Possession of a guest capability or the trusted authenticated subject is required.
-- Updating never creates a seat, changes identity, resets check-in or rotates tickets.
create function public.update_event_registration(p_event uuid,p_user uuid,p_hash text,p_name text,p_organization text,p_email text,p_meal text)
returns jsonb language plpgsql security definer set search_path=public as $$declare e public_events;r event_registrations;begin
 if (p_user is null)=(p_hash is null) then raise exception 'INVALID_REGISTRATION_IDENTITY';end if;
 select * into e from public_events where id=p_event for no key update;
 select * into r from event_registrations where event_id=p_event and
  ((p_user is not null and user_id=p_user) or (p_hash is not null and guest_token_hash=p_hash and guest_expires_at>now())) for update;
 if not found then raise exception 'INVALID_REGISTRATION_IDENTITY';end if;
 if not e.is_published or e.status<>'scheduled' then raise exception 'EVENT_CANCELLED';end if;
 if r.status<>'registered' then raise exception 'REGISTRATION_NOT_ACTIVE';end if;
 if clock_timestamp()>=e.registration_closes_at then raise exception 'REGISTRATION_CLOSED';end if;
 if r.checked_in_at is not null then raise exception 'REGISTRATION_ALREADY_CHECKED_IN';end if;
 if p_name is null or length(trim(p_name)) not between 1 and 100 or p_organization is null or length(trim(p_organization)) not between 1 and 200
  or p_email is null or length(trim(p_email)) not between 3 and 254 or p_meal is null or p_meal not in ('葷食','素食','不需餐盒') then raise exception 'INVALID_APPLICATION';end if;
 if position('台大' in replace(p_organization,'臺','台'))=0 then raise exception 'ORGANIZATION_NOT_ELIGIBLE';end if;
 update event_registrations set applicant_name=trim(p_name),organization=trim(p_organization),contact_email=lower(trim(p_email)),meal_preference=p_meal,updated_at=now() where id=r.id;
 return jsonb_build_object('status','registered','registration_id',r.id);
end$$;
create function public.public_event_availability(p_event uuid) returns jsonb
language plpgsql security definer set search_path=public as $$declare e public_events;n integer;begin
 select * into e from public_events where id=p_event and is_published;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 select count(*) into n from event_registrations where event_id=p_event and status='registered';
 return jsonb_build_object('registered',n,'remaining',greatest(0,e.capacity-n));
end$$;
create function public.event_registration_summary(p_event uuid) returns jsonb
language sql security definer set search_path=public as $$
 select jsonb_build_object('checked_in',count(*) filter(where status='registered' and checked_in_at is not null),
 'guest',count(*) filter(where status='registered' and user_id is null),
 'member',count(*) filter(where status='registered' and user_id is not null),
 'meals',jsonb_build_object('葷食',count(*) filter(where status='registered' and meal_preference='葷食'),
 '素食',count(*) filter(where status='registered' and meal_preference='素食'),
 '不需餐盒',count(*) filter(where status='registered' and meal_preference='不需餐盒')),
 'duplicate_emails',(select count(*) from (select lower(trim(contact_email)) from event_registrations where event_id=p_event and status='registered' and nullif(trim(contact_email),'') is not null group by lower(trim(contact_email)) having count(*)>1) d))
 from event_registrations where event_id=p_event;
$$;
revoke all on function public.register_guest_event_details(uuid,text,text,text,text,text,text),public.submit_event_application_details(uuid,uuid,text,text,text,boolean,text),public.update_event_registration(uuid,uuid,text,text,text,text,text),public.public_event_availability(uuid),public.event_registration_summary(uuid) from public,anon,authenticated;
grant execute on function public.register_guest_event_details(uuid,text,text,text,text,text,text),public.submit_event_application_details(uuid,uuid,text,text,text,boolean,text),public.update_event_registration(uuid,uuid,text,text,text,text,text),public.public_event_availability(uuid),public.event_registration_summary(uuid) to service_role;

create or replace function public.access_guest_event(p_event uuid,p_hash text,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r event_registrations;e public_events;begin
 select * into e from public_events where id=p_event for no key update;
 select * into r from event_registrations where event_id=p_event and guest_token_hash=p_hash and guest_expires_at>now() for update;
 if not found then raise exception 'INVALID_GUEST_TOKEN';end if;
 if p_cancel then update event_registrations set status='cancelled',ticket_token=null,updated_at=now() where id=r.id returning * into r;end if;
 return jsonb_build_object('registration_id',r.id,'status',r.status,'meal_preference',r.meal_preference,'can_edit',(r.status='registered' and r.checked_in_at is null and e.is_published and e.status='scheduled' and clock_timestamp()<e.registration_closes_at),'applicant_name',r.applicant_name,'organization',r.organization,'contact_email',r.contact_email,'checked_in_at',r.checked_in_at,'ticket',case when r.status='registered' and e.is_published and e.status='scheduled' then jsonb_build_object('token',r.ticket_token,'checked_in_at',r.checked_in_at) else null end);
end$$;

-- Aggregate once so PostgREST's per-query row cap cannot silently truncate CSV.
create function public.event_registration_export(p_event uuid) returns jsonb
language sql security definer set search_path=public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'applicant_name',applicant_name,'organization',organization,
 'contact_email',contact_email,'meal_preference',meal_preference,'checked_in_at',checked_in_at) order by id),'[]'::jsonb)
 from event_registrations where event_id=p_event and status='registered';
$$;
revoke all on function public.event_registration_export(uuid) from public,anon,authenticated;
grant execute on function public.event_registration_export(uuid) to service_role;
