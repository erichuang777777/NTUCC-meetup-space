alter table public.public_events add column checkin_opens_at timestamptz;
alter table public.public_events add column checkin_closes_at timestamptz;
alter table public.public_events add constraint checkin_window check ((checkin_opens_at is null and checkin_closes_at is null) or (checkin_opens_at is not null and checkin_closes_at is not null and checkin_closes_at>checkin_opens_at));
-- Tickets are bearer credentials: never grant direct browser table access.
alter table public.event_registrations add column ticket_token text unique;
alter table public.event_registrations add column checked_in_at timestamptz;
alter table public.event_registrations add column checked_in_by uuid references auth.users;
create table public.event_staff (
 event_id uuid references public.public_events on delete cascade,
 user_id uuid references public.profiles on delete cascade,
 primary key(event_id,user_id)
);
alter table public.event_staff enable row level security;
revoke all on public.event_staff from public,anon,authenticated;
grant all on public.event_staff to service_role;
create function public.invalidate_event_ticket() returns trigger language plpgsql set search_path=public as $$begin
 if new.status is distinct from old.status then
  new.ticket_token:=null; new.checked_in_at:=null; new.checked_in_by:=null;
 end if;
 return new;
end$$;
create trigger invalidate_event_ticket before update on public.event_registrations for each row execute function public.invalidate_event_ticket();
create function public.event_ticket(p_user uuid,p_event uuid,p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events; r event_registrations;begin
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published or e.status<>'scheduled' then raise exception 'TICKET_UNAVAILABLE';end if;
 select * into r from event_registrations where user_id=p_user and event_id=p_event for update;
 if not found or r.status<>'registered' then raise exception 'TICKET_UNAVAILABLE';end if;
 if p_token !~ '^ntucc_ticket_[a-f0-9]{64}$' then raise exception 'INVALID_TICKET';end if;
 if r.ticket_token is null then
  update event_registrations set ticket_token=p_token where id=r.id returning * into r;
 end if;
 return jsonb_build_object('token',r.ticket_token,'registration_id',r.id,'event_id',p_event,'checked_in_at',r.checked_in_at);
end$$;
create function public.check_in_public_event(p_actor uuid,p_event uuid,p_token text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events; r event_registrations; previous boolean;begin
 if not exists(select 1 from profiles p where p.id=p_actor and p.passcode_verified and (p.role='admin' or exists(select 1 from event_staff s where s.event_id=p_event and s.user_id=p_actor))) then raise exception 'STAFF_REQUIRED';end if;
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published or e.status<>'scheduled' then raise exception 'CHECKIN_UNAVAILABLE';end if;
 if clock_timestamp()<coalesce(e.checkin_opens_at,e.starts_at) or clock_timestamp()>coalesce(e.checkin_closes_at,e.ends_at) then raise exception 'CHECKIN_CLOSED';end if;
 select * into r from event_registrations where event_id=p_event and ticket_token=p_token and status='registered' for update;
 if not found then raise exception 'INVALID_TICKET';end if;
 previous:=r.checked_in_at is not null;
 if not previous then
  update event_registrations set checked_in_at=clock_timestamp(),checked_in_by=p_actor where id=r.id returning * into r;
 end if;
 return jsonb_build_object('registration_id',r.id,'checked_in_at',r.checked_in_at,'already_checked_in',previous,'display_name',(select display_name from profiles where id=r.user_id));
end$$;
revoke all on function public.event_ticket(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.check_in_public_event(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.event_ticket(uuid,uuid,text) to service_role;
grant execute on function public.check_in_public_event(uuid,uuid,text) to service_role;
