begin;
-- F9 event_series: group events into a series and clone a previous event. Incremental, runs after 001-013.
create table public.event_series (
 id uuid primary key default gen_random_uuid(),title text not null check(length(btrim(title)) between 1 and 80),
 description text not null default '' check(length(description)<=1000),slug text not null unique check(slug ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
 created_by uuid references public.profiles(id) on delete set null,created_at timestamptz not null default now(),archived boolean not null default false
);
alter table public.public_events add column if not exists series_id uuid references public.event_series(id) on delete set null;
create index if not exists public_events_series on public.public_events(series_id,starts_at);
alter table public.event_series enable row level security;
revoke all on public.event_series from public,anon,authenticated;
grant all on public.event_series to service_role;
grant select on public.event_series to authenticated;
-- Members see active series; admins also see archived ones. Writes only via RPCs.
create policy event_series_read on public.event_series for select to authenticated using(
 is_feature_enabled('event_series') and is_verified() and (not archived or is_admin()));

-- Free text (title/description) must pass the server PII guard first, so create/update are service_role only (event-series-api).
create function public.create_event_series(p_actor uuid,p_title text,p_description text,p_slug text default null) returns jsonb language plpgsql security definer set search_path=public as $$declare s event_series;begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 p_title:=btrim(coalesce(p_title,''));p_description:=coalesce(p_description,'');
 if length(p_title) not between 1 and 80 or length(p_description)>1000 then raise exception 'INVALID_SERIES';end if;
 p_slug:=coalesce(nullif(btrim(p_slug),''),'series-'||substr(md5(gen_random_uuid()::text),1,10));
 if p_slug !~ '^[a-z0-9][a-z0-9-]{1,38}$' then raise exception 'INVALID_SLUG';end if;
 begin
  insert into event_series(title,description,slug,created_by) values(p_title,p_description,p_slug,p_actor) returning * into s;
 exception when unique_violation then raise exception 'SLUG_TAKEN';end;
 return to_jsonb(s);
end$$;
create function public.update_event_series(p_actor uuid,p_id uuid,p_title text,p_description text,p_archived boolean) returns jsonb language plpgsql security definer set search_path=public as $$declare s event_series;begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 p_title:=btrim(coalesce(p_title,''));p_description:=coalesce(p_description,'');
 if length(p_title) not between 1 and 80 or length(p_description)>1000 then raise exception 'INVALID_SERIES';end if;
 update event_series set title=p_title,description=p_description,archived=coalesce(p_archived,archived) where id=p_id returning * into s;
 if not found then raise exception 'SERIES_NOT_FOUND';end if;
 return to_jsonb(s);
end$$;

create function public.assign_event_series(p_event uuid,p_series uuid) returns void language plpgsql security definer set search_path=public as $$begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_series is not null and not exists(select 1 from event_series where id=p_series) then raise exception 'SERIES_NOT_FOUND';end if;
 update public_events set series_id=p_series where id=p_event;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
end$$;

-- Member view: series with counts of PUBLISHED events only (public_events itself stays unreadable to browsers).
create function public.list_event_series() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'description',s.description,'slug',s.slug,'archived',s.archived,'created_at',s.created_at,
  'upcoming',(select count(*) from public_events e where e.series_id=s.id and e.is_published and e.ends_at>=now()),
  'past',(select count(*) from public_events e where e.series_id=s.id and e.is_published and e.ends_at<now())) order by s.archived,s.created_at desc)
  from event_series s where not s.archived or is_admin()),'[]');
end$$;
create function public.event_series_events(p_series uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not exists(select 1 from event_series where id=p_series and (not archived or is_admin())) then raise exception 'SERIES_NOT_FOUND';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'title',e.title,'location',e.location,'starts_at',e.starts_at,'ends_at',e.ends_at,'status',e.status,
  'is_past',e.ends_at<now()) order by e.starts_at desc) from public_events e where e.series_id=p_series and e.is_published),'[]');
end$$;
-- Admin: every event (including drafts) with its series, for the assignment / clone panel.
create function public.event_series_admin_events() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('event_series') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'title',e.title,'starts_at',e.starts_at,'ends_at',e.ends_at,'is_published',e.is_published,'series_id',e.series_id) order by e.starts_at desc) from public_events e),'[]');
end$$;

-- Clone configuration into a new UNPUBLISHED draft. Never copies registrations, check-ins, photos, staff, guests or tickets.
create function public.clone_event(p_source uuid,p_starts_at timestamptz,p_ends_at timestamptz) returns uuid language plpgsql security definer set search_path=public as $$declare e public_events;d interval;shift integer;ag jsonb:='[]';it jsonb;t text;m integer;n public_events;f event_feedback_forms;begin
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
 insert into public_events(title,description,location,starts_at,ends_at,registration_closes_at,capacity,waitlist_enabled,status,is_published,checkin_opens_at,checkin_closes_at,agenda,series_id)
 values(e.title,e.description,e.location,p_starts_at,p_ends_at,least(e.registration_closes_at+d,p_starts_at),e.capacity,e.waitlist_enabled,'scheduled',false,e.checkin_opens_at+d,e.checkin_closes_at+d,ag,e.series_id)
 returning * into n;
 select * into f from event_feedback_forms where event_id=p_source;
 if found then
  insert into event_feedback_forms(event_id,questions,opens_at,closes_at,is_anonymous,created_by,published_at)
  values(n.id,f.questions,p_ends_at+(f.opens_at-e.ends_at),p_ends_at+(f.closes_at-e.ends_at),f.is_anonymous,auth.uid(),null);
 end if;
 return n.id;
end$$;

revoke all on function public.create_event_series(uuid,text,text,text),public.update_event_series(uuid,uuid,text,text,boolean),public.assign_event_series(uuid,uuid),public.list_event_series(),public.event_series_events(uuid),public.event_series_admin_events(),public.clone_event(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.create_event_series(uuid,text,text,text),public.update_event_series(uuid,uuid,text,text,boolean) to service_role;
grant execute on function public.assign_event_series(uuid,uuid),public.list_event_series(),public.event_series_events(uuid),public.event_series_admin_events(),public.clone_event(uuid,timestamptz,timestamptz) to authenticated,service_role;
commit;
