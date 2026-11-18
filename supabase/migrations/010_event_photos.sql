-- Private pending photos only; this migration does not publish an album.
create table public.event_photos (
 id uuid primary key, event_id uuid not null references public.public_events on delete cascade,
 user_id uuid not null references auth.users on delete cascade,
 object_path text not null unique, caption text not null default '',
 status text not null default 'pending' check(status='pending'),
 consent_at timestamptz not null default now(),created_at timestamptz not null default now(),
 width integer not null check(width between 1 and 1600),height integer not null check(height between 1 and 1600),
 byte_size integer not null check(byte_size between 1 and 1000000)
);
alter table public.event_photos enable row level security;
revoke all on public.event_photos from public,anon,authenticated;
grant all on public.event_photos to service_role;
-- Fails closed if Storage is absent. Test DB must install a disposable Storage stub.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('event-photos','event-photos',false,1000000,array['image/png'])
on conflict(id) do update set public=false,file_size_limit=1000000,allowed_mime_types=array['image/png'];
-- Private bucket alone is insufficient if an older broad authenticated policy exists.
create policy event_photos_no_browser_objects on storage.objects as restrictive for all to anon,authenticated
using(bucket_id<>'event-photos') with check(bucket_id<>'event-photos');
create function public.add_pending_event_photo(p_id uuid,p_user uuid,p_event uuid,p_path text,p_caption text,p_width integer,p_height integer,p_bytes integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e public_events;begin
 select * into e from public_events where id=p_event for no key update;
 if not found or not e.is_published or e.status<>'scheduled' then raise exception 'PHOTO_EVENT_UNAVAILABLE';end if;
 if not exists(select 1 from event_registrations where event_id=p_event and user_id=p_user and status='registered' and eligibility_status='approved') then raise exception 'REGISTRATION_REQUIRED';end if;
 if p_path<>p_event::text||'/'||p_user::text||'/'||p_id::text||'.png' then raise exception 'INVALID_PHOTO_PATH';end if;
 if (select count(*) from event_photos where user_id=p_user and event_id=p_event)>=10 then raise exception 'PHOTO_LIMIT';end if;
 insert into event_photos(id,event_id,user_id,object_path,caption,width,height,byte_size) values(p_id,p_event,p_user,p_path,p_caption,p_width,p_height,p_bytes);
 return jsonb_build_object('id',p_id,'status','pending');
end$$;
revoke all on function public.add_pending_event_photo(uuid,uuid,uuid,text,text,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.add_pending_event_photo(uuid,uuid,uuid,text,text,integer,integer,integer) to service_role;
