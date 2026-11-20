begin;
-- F10 member_hosted_events: members propose events; an admin reviews; approval creates the public_events row
-- and grants the host event_staff rights for THAT event only. Incremental, runs after 001-018. Flag key: member_hosted_events.

-- Audience of a public_events row. Existing/admin events stay 'public'; member-hosted events default to 'members'
-- and are hidden from anonymous endpoints (events-api filters on audience) and closed to non-members at registration.
alter table public.public_events add column audience text not null default 'public' check(audience in ('public','members'));

create function public.enforce_members_only_registration() returns trigger language plpgsql security definer set search_path=public as $$begin
 if new.status in ('pending','registered') and exists(select 1 from public_events where id=new.event_id and audience='members')
  and (new.user_id is null or not exists(select 1 from profiles where id=new.user_id and passcode_verified)) then
  raise exception 'MEMBERS_ONLY';
 end if;
 return new;
end$$;
create trigger enforce_members_only_registration before insert or update on public.event_registrations for each row execute function public.enforce_members_only_registration();

create table public.hosted_event_requests (
 id uuid primary key default gen_random_uuid(),host_id uuid not null references public.profiles(id) on delete cascade,
 title text not null check(length(btrim(title)) between 1 and 120),description text not null default '' check(length(description)<=3000),
 location text not null default '' check(length(location)<=200),starts_at timestamptz not null,ends_at timestamptz not null,
 capacity integer check(capacity is null or capacity between 1 and 10000),
 audience text not null default 'members' check(audience in ('members','public')),
 status text not null default 'draft' check(status in ('draft','submitted','approved','returned','cancelled')),
 reviewer_note text check(reviewer_note is null or length(reviewer_note)<=1000),reviewed_by uuid references public.profiles(id) on delete set null,reviewed_at timestamptz,
 event_id uuid references public.public_events(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(ends_at>starts_at)
);
create index hosted_event_requests_host on public.hosted_event_requests(host_id,created_at desc);
create index hosted_event_requests_status on public.hosted_event_requests(status,created_at);
-- One row per submission; used for the 5-per-30-days limit (re-submissions after a return count).
create table public.hosted_event_submissions (
 id bigint generated always as identity primary key,request_id uuid references public.hosted_event_requests on delete set null,
 host_id uuid not null references public.profiles(id) on delete cascade,created_at timestamptz not null default now()
);
create index hosted_event_submissions_host on public.hosted_event_submissions(host_id,created_at desc);
alter table public.hosted_event_requests enable row level security;
alter table public.hosted_event_submissions enable row level security;
revoke all on public.hosted_event_requests,public.hosted_event_submissions from public,anon,authenticated;
grant all on public.hosted_event_requests,public.hosted_event_submissions to service_role;
grant usage,select on sequence public.hosted_event_submissions_id_seq to service_role;
grant select on public.hosted_event_requests to authenticated;
create policy hosted_requests_read on public.hosted_event_requests for select to authenticated using(
 is_feature_enabled('member_hosted_events') and is_verified() and (host_id=auth.uid() or is_admin()));

-- Writes: service_role only (free text goes through hosted-events-api PII guard first).
create function public.save_hosted_event_request(p_actor uuid,p_id uuid,p_title text,p_description text,p_location text,p_starts timestamptz,p_ends timestamptz,p_capacity integer) returns jsonb language plpgsql security definer set search_path=public as $$declare r hosted_event_requests;begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and passcode_verified) then raise exception 'MEMBER_REQUIRED';end if;
 if length(btrim(coalesce(p_title,''))) not between 1 and 120 or length(coalesce(p_description,''))>3000 or length(coalesce(p_location,''))>200
  or p_starts is null or p_ends is null or p_ends<=p_starts or (p_capacity is not null and p_capacity not between 1 and 10000) then raise exception 'INVALID_REQUEST';end if;
 if p_id is null then
  insert into hosted_event_requests(host_id,title,description,location,starts_at,ends_at,capacity) values(p_actor,btrim(p_title),coalesce(p_description,''),coalesce(p_location,''),p_starts,p_ends,p_capacity) returning * into r;
 else
  select * into r from hosted_event_requests where id=p_id and host_id=p_actor for update;
  if not found then raise exception 'REQUEST_NOT_FOUND';end if;
  if r.status not in ('draft','returned') then raise exception 'REQUEST_LOCKED';end if;
  update hosted_event_requests set title=btrim(p_title),description=coalesce(p_description,''),location=coalesce(p_location,''),starts_at=p_starts,ends_at=p_ends,capacity=p_capacity,updated_at=now() where id=p_id returning * into r;
 end if;
 return to_jsonb(r);
end$$;

create function public.submit_hosted_event_request(p_actor uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare r hosted_event_requests;begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and passcode_verified) then raise exception 'MEMBER_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('hosted-event-submit:'||p_actor::text,0));
 select * into r from hosted_event_requests where id=p_id and host_id=p_actor for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if r.status not in ('draft','returned') then raise exception 'INVALID_STATE';end if;
 if r.starts_at<=now() then raise exception 'EVENT_IN_PAST';end if;
 if (select count(*) from hosted_event_submissions where host_id=p_actor and created_at>now()-interval '30 days')>=5 then raise exception 'RATE_LIMITED';end if;
 insert into hosted_event_submissions(request_id,host_id) values(r.id,p_actor);
 update hosted_event_requests set status='submitted',reviewer_note=null,updated_at=now() where id=r.id returning * into r;
 return to_jsonb(r);
end$$;

create function public.cancel_hosted_event_request(p_actor uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare r hosted_event_requests;begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 select * into r from hosted_event_requests where id=p_id and host_id=p_actor for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if r.status not in ('draft','submitted','returned') then raise exception 'INVALID_STATE';end if;
 update hosted_event_requests set status='cancelled',updated_at=now() where id=r.id returning * into r;
 return to_jsonb(r);
end$$;

-- Admin review. Approve creates the public_events row in the same transaction (same columns the admin editor writes:
-- registration closes at start, scheduled). p_publish -> is_published; p_public -> audience 'public' (default stays members-only).
create function public.review_hosted_event(p_actor uuid,p_id uuid,p_decision text,p_note text default null,p_publish boolean default false,p_public boolean default false) returns jsonb language plpgsql security definer set search_path=public as $$declare r hosted_event_requests;ev uuid;begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 if p_decision not in ('approve','return') then raise exception 'INVALID_DECISION';end if;
 if length(coalesce(p_note,''))>1000 or (p_decision='return' and length(btrim(coalesce(p_note,'')))=0) then raise exception 'NOTE_REQUIRED';end if;
 select * into r from hosted_event_requests where id=p_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if r.status<>'submitted' then raise exception 'INVALID_STATE';end if;
 if p_decision='approve' then
  if r.ends_at<=now() then raise exception 'EVENT_IN_PAST';end if;
  if not exists(select 1 from profiles where id=r.host_id and passcode_verified) then raise exception 'MEMBER_REQUIRED';end if;
  insert into public_events(title,description,location,starts_at,ends_at,registration_closes_at,capacity,is_published,audience)
   values(r.title,r.description,r.location,r.starts_at,r.ends_at,r.starts_at,coalesce(r.capacity,100),coalesce(p_publish,false),case when p_public then 'public' else 'members' end) returning id into ev;
  insert into event_staff(event_id,user_id) values(ev,r.host_id) on conflict do nothing;
  update hosted_event_requests set status='approved',event_id=ev,audience=case when p_public then 'public' else 'members' end,reviewer_note=nullif(btrim(coalesce(p_note,'')),''),reviewed_by=p_actor,reviewed_at=now(),updated_at=now() where id=r.id returning * into r;
  perform notify(r.host_id,'hosted_event_reviewed','你發起的活動已核准',r.title,'#hosted-events',jsonb_build_object('request_id',r.id,'event_id',ev,'decision','approved'));
 else
  update hosted_event_requests set status='returned',reviewer_note=btrim(p_note),reviewed_by=p_actor,reviewed_at=now(),updated_at=now() where id=r.id returning * into r;
  perform notify(r.host_id,'hosted_event_reviewed','你發起的活動被退回修改',r.title,'#hosted-events',jsonb_build_object('request_id',r.id,'decision','returned'));
 end if;
 return to_jsonb(r);
end$$;

-- Admin revoke: unpublish the event (registrations are retained) and remove the host's staff right.
create function public.revoke_hosted_event(p_actor uuid,p_id uuid,p_note text default null) returns jsonb language plpgsql security definer set search_path=public as $$declare r hosted_event_requests;begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 if length(coalesce(p_note,''))>1000 then raise exception 'NOTE_REQUIRED';end if;
 select * into r from hosted_event_requests where id=p_id for update;
 if not found then raise exception 'REQUEST_NOT_FOUND';end if;
 if r.status<>'approved' or r.event_id is null then raise exception 'INVALID_STATE';end if;
 update public_events set is_published=false where id=r.event_id;
 delete from event_staff where event_id=r.event_id and user_id=r.host_id;
 update hosted_event_requests set status='cancelled',reviewer_note=nullif(btrim(coalesce(p_note,'')),''),reviewed_by=p_actor,reviewed_at=now(),updated_at=now() where id=r.id returning * into r;
 perform notify(r.host_id,'hosted_event_reviewed','你發起的活動已被撤下',r.title,'#hosted-events',jsonb_build_object('request_id',r.id,'decision','revoked'));
 return to_jsonb(r);
end$$;

-- Host view of THEIR event's registrations (no e-mail; staff-scoped to this event only).
create function public.hosted_event_registrations(p_actor uuid,p_id uuid,p_page integer default 1) returns jsonb language plpgsql security definer set search_path=public as $$declare r hosted_event_requests;rows jsonb;begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 select * into r from hosted_event_requests where id=p_id and host_id=p_actor;
 if not found or r.status<>'approved' or r.event_id is null or not exists(select 1 from event_staff where event_id=r.event_id and user_id=p_actor) then raise exception 'REQUEST_NOT_FOUND';end if;
 select coalesce(jsonb_agg(s.x),'[]') into rows from (select jsonb_build_object('id',g.id,'status',g.status,'applicant_name',g.applicant_name,'organization',g.organization,'checked_in_at',g.checked_in_at,'updated_at',g.updated_at) x
  from event_registrations g where g.event_id=r.event_id order by g.updated_at desc,g.id offset (greatest(coalesce(p_page,1),1)-1)*50 limit 50) s;
 return jsonb_build_object('event_id',r.event_id,'registrations',rows,'registered',(select count(*) from event_registrations where event_id=r.event_id and status='registered'),
  'checked_in',(select count(*) from event_registrations where event_id=r.event_id and checked_in_at is not null),'page',greatest(coalesce(p_page,1),1));
end$$;

create function public.hosted_event_admin_list() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('member_hosted_events') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 return coalesce((select jsonb_agg(to_jsonb(q)) from (select r.*,p.display_name as host_name from hosted_event_requests r join profiles p on p.id=r.host_id
  where r.status<>'draft' order by (r.status='submitted') desc,r.updated_at desc limit 200) q),'[]');
end$$;

revoke all on function public.enforce_members_only_registration(),public.save_hosted_event_request(uuid,uuid,text,text,text,timestamptz,timestamptz,integer),public.submit_hosted_event_request(uuid,uuid),
 public.cancel_hosted_event_request(uuid,uuid),public.review_hosted_event(uuid,uuid,text,text,boolean,boolean),public.revoke_hosted_event(uuid,uuid,text),public.hosted_event_registrations(uuid,uuid,integer),public.hosted_event_admin_list() from public,anon,authenticated;
grant execute on function public.save_hosted_event_request(uuid,uuid,text,text,text,timestamptz,timestamptz,integer),public.submit_hosted_event_request(uuid,uuid),
 public.cancel_hosted_event_request(uuid,uuid),public.review_hosted_event(uuid,uuid,text,text,boolean,boolean),public.revoke_hosted_event(uuid,uuid,text),public.hosted_event_registrations(uuid,uuid,integer) to service_role;
grant execute on function public.hosted_event_admin_list() to authenticated,service_role;
-- clone_event (022) predates audience (023) and waitlist_enabled (020): copy both so a
-- cloned members-only event never becomes public. Same signature, grants are preserved.
create or replace function public.clone_event(p_source uuid,p_starts_at timestamptz,p_ends_at timestamptz) returns uuid language plpgsql security definer set search_path=public as $$declare e public_events;d interval;shift integer;ag jsonb:='[]';it jsonb;t text;m integer;n public_events;f event_feedback_forms;begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_starts_at is null or p_ends_at is null or p_ends_at<=p_starts_at then raise exception 'INVALID_WINDOW';end if;
 select * into e from public_events where id=p_source;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 d:=p_starts_at-e.starts_at;
 -- agenda times are "HH:MM" strings: shift by the change in Taipei start time-of-day; other formats are kept as-is
 shift:=(extract(hour from (p_starts_at at time zone 'Asia/Taipei'))::int*60+extract(minute from (p_starts_at at time zone 'Asia/Taipei'))::int)
  -(extract(hour from (e.starts_at at time zone 'Asia/Taipei'))::int*60+extract(minute from (e.starts_at at time zone 'Asia/Taipei'))::int);
 for it in select * from jsonb_array_elements(e.agenda) loop
  t:=it->>'time';
  if t ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
   m:=(((split_part(t,':',1)::int*60+split_part(t,':',2)::int+shift)%1440)+1440)%1440;
   it:=jsonb_set(it,'{time}',to_jsonb(lpad((m/60)::text,2,'0')||':'||lpad((m%60)::text,2,'0')));
  end if;
  ag:=ag||it;
 end loop;
 insert into public_events(title,description,location,starts_at,ends_at,registration_closes_at,capacity,waitlist_enabled,audience,status,is_published,checkin_opens_at,checkin_closes_at,agenda,series_id)
 values(e.title,e.description,e.location,p_starts_at,p_ends_at,least(e.registration_closes_at+d,p_starts_at),e.capacity,e.waitlist_enabled,e.audience,'scheduled',false,e.checkin_opens_at+d,e.checkin_closes_at+d,ag,e.series_id)
 returning * into n;
 select * into f from event_feedback_forms where event_id=p_source;
 if found then
  insert into event_feedback_forms(event_id,questions,opens_at,closes_at,is_anonymous,created_by,published_at)
  values(n.id,f.questions,p_ends_at+(f.opens_at-e.ends_at),p_ends_at+(f.closes_at-e.ends_at),f.is_anonymous,auth.uid(),null);
 end if;
 return n.id;
end$$;
commit;
