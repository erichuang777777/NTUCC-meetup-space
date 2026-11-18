-- Public editorial content is separate from all existing members-only data.
create table public.public_events (
 id uuid primary key default gen_random_uuid(), title text not null,
 description text not null default '', location text not null default '',
 starts_at timestamptz not null, ends_at timestamptz not null,
 registration_closes_at timestamptz not null, capacity integer not null check(capacity between 1 and 10000),
 sequence integer not null default 0,
 status text not null default 'scheduled' check(status in ('scheduled','cancelled')),
 is_published boolean not null default false, updated_at timestamptz not null default now(),
 check(ends_at > starts_at), check(registration_closes_at <= starts_at)
);
create table public.public_announcements (
 id uuid primary key default gen_random_uuid(), title text not null, content text not null,
 is_published boolean not null default false, created_at timestamptz not null default now()
);
create table public.event_registrations (
 id uuid primary key default gen_random_uuid(), event_id uuid not null references public.public_events on delete cascade,
 user_id uuid not null references auth.users on delete cascade,
 status text not null check(status in ('registered','cancelled')), updated_at timestamptz not null default now(),
 unique(event_id,user_id)
);
create table public.event_api_tokens (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade,
 token_hash text not null unique, prefix text not null, expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
do $$declare t text;begin foreach t in array array['public_events','public_announcements','event_registrations','event_api_tokens'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon, authenticated',t);
 execute format('grant all on public.%I to service_role',t);
end loop;end$$;
-- Only trusted server requests may bind the authenticated subject to p_user.
create function public.register_public_event(p_user uuid,p_event uuid,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events; r event_registrations; begin
 select * into e from public_events where id=p_event for no key update;
 if not found then raise exception 'EVENT_NOT_FOUND'; end if;
 if not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null) then raise exception 'EMAIL_NOT_VERIFIED';end if;
 select * into r from event_registrations where user_id=p_user and event_id=p_event;
 if p_cancel then
  if r.id is null then return jsonb_build_object('status','cancelled','id',null);end if;
  update event_registrations set status='cancelled',updated_at=now() where id=r.id;
  return jsonb_build_object('status','cancelled','id',r.id);
 end if;
 if not e.is_published then raise exception 'EVENT_NOT_FOUND';end if;
 if e.status='cancelled' then raise exception 'EVENT_CANCELLED';end if;
 if r.status='registered' then return jsonb_build_object('status','registered','id',r.id);end if;
 if now() >= e.registration_closes_at then raise exception 'REGISTRATION_CLOSED';end if;
 if (select count(*) from event_registrations where event_id=p_event and status='registered') >= e.capacity then raise exception 'EVENT_FULL';end if;
 insert into event_registrations(event_id,user_id,status) values(p_event,p_user,'registered')
 on conflict(event_id,user_id) do update set status='registered',updated_at=now() returning * into r;
 return jsonb_build_object('status','registered','id',r.id);
end$$;
revoke all on function public.register_public_event(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.register_public_event(uuid,uuid,boolean) to service_role;

create function public.public_event_revision() returns trigger language plpgsql set search_path=public as $$begin
 if new.capacity < (select count(*) from event_registrations where event_id=old.id and status='registered') then raise exception 'CAPACITY_BELOW_REGISTRATIONS';end if;
 new.sequence := old.sequence+1; new.updated_at := now(); return new;
end$$;
create trigger public_event_revision before update on public.public_events for each row execute function public.public_event_revision();
