-- Photo publication is opt-in, reviewed, and proxied from a permanently private bucket.
alter table public.event_photos drop constraint event_photos_status_check;
alter table public.event_photos add constraint event_photos_status_check check(status in ('pending','published','returned','withdrawn'));
alter table public.event_photos add column publication_consent boolean not null default false;
alter table public.event_photos add column publication_consent_at timestamptz;
alter table public.event_photos add column audience text check(audience is null or audience='public_web');
alter table public.event_photos add column review_reason text;
alter table public.event_photos add column reviewed_at timestamptz;
alter table public.event_photos add column reviewed_by uuid references auth.users on delete set null;
alter table public.event_photos add column withdrawn_at timestamptz;
alter table public.event_photos add column storage_deleted_at timestamptz;
alter table public.event_photos add constraint photo_publication_consent_required check(status<>'published' or (publication_consent and audience is not distinct from 'public_web' and reviewed_at is not null));
create table public.event_photo_audit (
 id bigint generated always as identity primary key,photo_id uuid references public.event_photos on delete set null,
 actor_id uuid references auth.users on delete set null,action text not null,reason text,created_at timestamptz not null default now()
);
create table public.event_photo_cleanup (
 id uuid primary key default gen_random_uuid(),photo_id uuid references public.event_photos on delete set null,
 object_path text not null unique,status text not null default 'pending' check(status in ('intent','pending','deleted','retained')),
 attempts integer not null default 0,created_at timestamptz not null default now(),last_attempt_at timestamptz,deleted_at timestamptz
);
alter table public.event_photo_audit enable row level security;
alter table public.event_photo_cleanup enable row level security;
revoke all on public.event_photo_audit,public.event_photo_cleanup from public,anon,authenticated;
grant all on public.event_photo_audit,public.event_photo_cleanup to service_role;
grant usage,select on sequence public.event_photo_audit_id_seq to service_role;
create function public.change_event_photo(p_photo uuid,p_actor uuid,p_action text,p_consent boolean default null,p_audience text default null,p_reason text default null,p_reviewed boolean default false)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r event_photos;is_admin boolean;begin
 select * into r from event_photos where id=p_photo for update;
 if not found or p_actor is null then raise exception 'PHOTO_NOT_FOUND';end if;
 select exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) into is_admin;
 if p_action in ('consent','withdraw') then
  if r.user_id<>p_actor then raise exception 'PHOTO_NOT_FOUND';end if;
 elsif p_action in ('publish','return') then
  if not is_admin then raise exception 'ADMIN_REQUIRED';end if;
 else raise exception 'INVALID_PHOTO_ACTION';end if;
 if r.status='withdrawn' then
  if p_action='withdraw' then return jsonb_build_object('id',r.id,'status','withdrawn','storage_deleted',r.storage_deleted_at is not null);end if;
  raise exception 'PHOTO_WITHDRAWN';
 end if;
 if p_action='consent' then
  if p_consent is null or p_audience<>'public_web' or p_audience is null then raise exception 'PUBLIC_AUDIENCE_REQUIRED';end if;
  if r.publication_consent=p_consent then
   return jsonb_build_object('id',r.id,'status',r.status,'publication_consent',r.publication_consent,'audience',r.audience,'review_reason',r.review_reason,'storage_deleted',r.storage_deleted_at is not null);
  end if;
  update event_photos set publication_consent=p_consent,publication_consent_at=case when p_consent then now() else null end,audience=case when p_consent then 'public_web' else null end,
    status=case when not p_consent and status='published' then 'pending' else status end,
    reviewed_at=case when not p_consent then null else reviewed_at end,reviewed_by=case when not p_consent then null else reviewed_by end
    where id=r.id returning * into r;
 elsif p_action in ('publish','return') then
  if p_reviewed is distinct from true or length(trim(coalesce(p_reason,''))) not between 1 and 1000 then raise exception 'PHOTO_REVIEW_REQUIRED';end if;
  if p_action='publish' then
   if not r.publication_consent or r.audience is distinct from 'public_web' or p_audience is distinct from 'public_web' then raise exception 'PUBLICATION_CONSENT_REQUIRED';end if;
   if not exists(select 1 from public_events where id=r.event_id and is_published) then raise exception 'PHOTO_EVENT_UNAVAILABLE';end if;
  end if;
  if r.status=(case when p_action='publish' then 'published' else 'returned' end) and r.review_reason=p_reason and r.reviewed_by=p_actor then
   return jsonb_build_object('id',r.id,'status',r.status,'publication_consent',r.publication_consent,'audience',r.audience,'review_reason',r.review_reason,'storage_deleted',r.storage_deleted_at is not null);
  end if;
  update event_photos set status=case when p_action='publish' then 'published' else 'returned' end,review_reason=p_reason,reviewed_at=now(),reviewed_by=p_actor where id=r.id returning * into r;
 elsif p_action='withdraw' then
  update event_photos set status='withdrawn',withdrawn_at=now(),publication_consent=false,publication_consent_at=null,audience=null where id=r.id returning * into r;
  insert into event_photo_cleanup(photo_id,object_path) values(r.id,r.object_path) on conflict(object_path) do update set photo_id=excluded.photo_id,status=case when event_photo_cleanup.status='deleted' then 'deleted' else 'pending' end;
 end if;
 insert into event_photo_audit(photo_id,actor_id,action,reason) values(r.id,p_actor,case when p_action='consent' then case when p_consent then 'consent_public_web' else 'revoke_public_consent' end else p_action end,p_reason);
 return jsonb_build_object('id',r.id,'status',r.status,'publication_consent',r.publication_consent,'audience',r.audience,'review_reason',r.review_reason,'storage_deleted',r.storage_deleted_at is not null);
end$$;
-- Service-only orphan enqueue after a failed upload transaction. Existing live photos cannot be queued.
create function public.queue_event_photo_cleanup(p_path text,p_intent boolean default false)
returns void language plpgsql security definer set search_path=public as $$begin
 if p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.png$' then raise exception 'INVALID_PHOTO_PATH';end if;
 if exists(select 1 from event_photos where object_path=p_path and status<>'withdrawn') then raise exception 'PHOTO_STILL_ACTIVE';end if;
 insert into event_photo_cleanup(object_path,status) values(p_path,case when p_intent then 'intent' else 'pending' end) on conflict(object_path) do update set status=case when event_photo_cleanup.status='intent' and not p_intent then 'pending' else event_photo_cleanup.status end;
end$$;
create function public.record_event_photo_cleanup(p_id uuid,p_deleted boolean)
returns void language plpgsql security definer set search_path=public as $$declare q event_photo_cleanup;begin
 select * into q from event_photo_cleanup where id=p_id;
 if q.photo_id is not null then perform 1 from event_photos where id=q.photo_id for update;end if;
 select * into q from event_photo_cleanup where id=p_id for update;
 if not found or q.status='deleted' then return;end if;
 if exists(select 1 from event_photos where object_path=q.object_path and status<>'withdrawn') then raise exception 'PHOTO_STILL_ACTIVE';end if;
 update event_photo_cleanup set attempts=attempts+1,last_attempt_at=now(),status=case when p_deleted then 'deleted' else 'pending' end,deleted_at=case when p_deleted then now() else null end where id=p_id;
 if p_deleted and q.photo_id is not null then
  update event_photos set storage_deleted_at=now(),caption='',review_reason=null where id=q.photo_id and status='withdrawn';
  insert into event_photo_audit(photo_id,action) values(q.photo_id,'storage_deleted');
 end if;
end$$;
revoke all on function public.change_event_photo(uuid,uuid,text,boolean,text,text,boolean),public.queue_event_photo_cleanup(text,boolean),public.record_event_photo_cleanup(uuid,boolean) from public,anon,authenticated;
grant execute on function public.change_event_photo(uuid,uuid,text,boolean,text,text,boolean),public.queue_event_photo_cleanup(text,boolean),public.record_event_photo_cleanup(uuid,boolean) to service_role;

-- Recover intents only after a safety window; claiming serializes with metadata insertion.
create function public.pending_event_photo_cleanup()
returns table(id uuid,object_path text) language plpgsql security definer set search_path=public as $$begin
 update event_photo_cleanup q set status='retained' where q.status='intent' and exists(select 1 from event_photos p where p.object_path=q.object_path and p.status<>'withdrawn');
 update event_photo_cleanup q set status='pending' where q.status='intent' and q.created_at<now()-interval '10 minutes' and not exists(select 1 from event_photos p where p.object_path=q.object_path and p.status<>'withdrawn');
 return query select q.id,q.object_path from event_photo_cleanup q where q.status='pending' order by q.last_attempt_at nulls first,q.created_at,q.id limit 25;
end$$;
create function public.enqueue_deleted_event_photo() returns trigger language plpgsql security definer set search_path=public as $$begin
 insert into event_photo_cleanup(photo_id,object_path) values(old.id,old.object_path) on conflict(object_path) do update set photo_id=excluded.photo_id,status=case when event_photo_cleanup.status='deleted' then 'deleted' else 'pending' end;
 insert into event_photo_audit(photo_id,action) values(old.id,'database_row_deleted');
 return old;
end$$;
create trigger enqueue_deleted_event_photo before delete on public.event_photos for each row execute function public.enqueue_deleted_event_photo();
revoke all on function public.pending_event_photo_cleanup() from public,anon,authenticated;
grant execute on function public.pending_event_photo_cleanup() to service_role;

create or replace function public.add_pending_event_photo(p_id uuid,p_user uuid,p_event uuid,p_path text,p_caption text,p_width integer,p_height integer,p_bytes integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events;begin
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published or e.status<>'scheduled' then raise exception 'PHOTO_EVENT_UNAVAILABLE';end if;
 if not exists(select 1 from event_registrations where event_id=p_event and user_id=p_user and status='registered' and eligibility_status='approved') then raise exception 'REGISTRATION_REQUIRED';end if;
 perform 1 from event_photo_cleanup where object_path=p_path and status='intent' for update;
 if not found then raise exception 'UPLOAD_INTENT_EXPIRED';end if;
 if p_path<>p_event::text||'/'||p_user::text||'/'||p_id::text||'.png' then raise exception 'INVALID_PHOTO_PATH';end if;
 if (select count(*) from event_photos where user_id=p_user and event_id=p_event and storage_deleted_at is null)>=10 then raise exception 'PHOTO_LIMIT';end if;
 insert into event_photos(id,event_id,user_id,object_path,caption,width,height,byte_size) values(p_id,p_event,p_user,p_path,p_caption,p_width,p_height,p_bytes);
 update event_photo_cleanup set status='retained',photo_id=p_id where object_path=p_path and status='intent';
 return jsonb_build_object('id',p_id,'status','pending');
end$$;
create index event_photos_event_status_created on public.event_photos(event_id,status,created_at desc,id);
create index event_photo_cleanup_status_created on public.event_photo_cleanup(status,created_at,id);
