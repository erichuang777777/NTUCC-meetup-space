begin;
-- F5 content_reports: member reports, admin moderation queue, RLS-level hiding. Incremental: run after 001-013.
-- Every policy / RPC checks is_feature_enabled('content_reports'); with the flag off, visibility is exactly as before.
create table public.content_reports (
 id uuid primary key default gen_random_uuid(),reporter_id uuid not null references public.profiles(id) on delete cascade,
 target_type text not null check(target_type in ('thread','reply','qa','pain_point','space')),target_id uuid not null,
 reason text not null check(reason in ('pii','harassment','spam','incorrect','other')),detail text check(detail is null or length(detail)<=500),
 status text not null default 'open' check(status in ('open','dismissed','actioned')),
 handled_by uuid references public.profiles(id),handled_at timestamptz,resolution_note text check(resolution_note is null or length(resolution_note)<=500),
 created_at timestamptz not null default now()
);
create unique index content_reports_one_open on public.content_reports(reporter_id,target_type,target_id) where status='open';
create index content_reports_queue on public.content_reports(status,created_at);
create index content_reports_reporter_day on public.content_reports(reporter_id,created_at desc);
create table public.content_moderation (
 target_type text not null check(target_type in ('thread','reply','qa','pain_point','space')),target_id uuid not null,
 hidden boolean not null default true,hidden_by uuid references public.profiles(id),hidden_at timestamptz not null default now(),reason text check(reason is null or length(reason)<=500),
 primary key(target_type,target_id)
);
create table public.moderation_events (
 id uuid primary key default gen_random_uuid(),target_type text not null,target_id uuid not null,
 action text not null check(action in ('hide','unhide','dismiss','action')),actor_id uuid references public.profiles(id),
 report_id uuid references public.content_reports(id) on delete set null,note text,created_at timestamptz not null default now()
);
create index moderation_events_created on public.moderation_events(created_at desc);
alter table public.content_reports enable row level security;
alter table public.content_moderation enable row level security;
alter table public.moderation_events enable row level security;
revoke all on public.content_reports,public.content_moderation,public.moderation_events from public,anon,authenticated;
grant select on public.content_reports,public.content_moderation,public.moderation_events to authenticated;
create policy reports_read on public.content_reports for select to authenticated using(public.is_feature_enabled('content_reports') and public.is_verified() and (reporter_id=auth.uid() or public.is_admin()));
create policy moderation_admin_read on public.content_moderation for select to authenticated using(public.is_feature_enabled('content_reports') and public.is_admin());
create policy moderation_events_admin_read on public.moderation_events for select to authenticated using(public.is_feature_enabled('content_reports') and public.is_admin());

-- Ancestor chain of a target with the author who is exempt from hiding of that element.
create function public.content_chain(p_type text,p_id uuid) returns table(t text,i uuid,a uuid) language sql stable security definer set search_path=public as $$
 select 'space'::text,s.id,s.owner_id from spaces s where p_type='space' and s.id=p_id
 union all select 'pain_point',p.id,p.proposer_id from pain_points p where p_type='pain_point' and p.id=p_id
 union all select 'qa',q.id,q.author_id from space_qa q where p_type='qa' and q.id=p_id
 union all select 'space',s.id,s.owner_id from space_qa q join spaces s on s.id=q.space_id where p_type='qa' and q.id=p_id
 union all select 'thread',th.id,th.author_id from discussion_threads th where p_type='thread' and th.id=p_id
 union all select 'space',s.id,s.owner_id from discussion_threads th join spaces s on s.id=th.space_id where p_type='thread' and th.id=p_id
 union all select 'reply',r.id,r.author_id from discussion_replies r where p_type='reply' and r.id=p_id
 union all select 'thread',th.id,th.author_id from discussion_replies r join discussion_threads th on th.id=r.thread_id where p_type='reply' and r.id=p_id
 union all select 'space',s.id,s.owner_id from discussion_replies r join discussion_threads th on th.id=r.thread_id join spaces s on s.id=th.space_id where p_type='reply' and r.id=p_id
$$;
-- True when the target (or an ancestor) is hidden and p_viewer is neither admin nor author of the hidden element. Flag off => false.
create function public.content_hidden_for(p_type text,p_id uuid,p_viewer uuid) returns boolean language plpgsql stable security definer set search_path=public as $$declare r record;begin
 if not is_feature_enabled('content_reports') then return false;end if;
 if exists(select 1 from profiles where id=p_viewer and role='admin' and passcode_verified) then return false;end if;
 for r in select * from content_chain(p_type,p_id) loop
  if r.a is distinct from p_viewer and exists(select 1 from content_moderation m where m.target_type=r.t and m.target_id=r.i and m.hidden) then return true;end if;
 end loop;
 return false;
end$$;
create function public.content_hidden_from_viewer(p_type text,p_id uuid) returns boolean language sql stable security definer set search_path=public as $$select public.content_hidden_for(p_type,p_id,auth.uid())$$;
-- Server-side (service role) filter: which of p_ids are hidden from p_viewer.
create function public.moderation_hidden_ids(p_type text,p_ids uuid[],p_viewer uuid) returns setof uuid language sql stable security definer set search_path=public as $$
 select x from unnest(p_ids) x where public.content_hidden_for(p_type,x,p_viewer)
$$;
-- Ids (among p_ids) that are hidden from others but still visible to the caller (author/admin), so the UI can show "已隱藏".
create function public.moderation_hidden_visible(p_type text,p_ids uuid[]) returns setof uuid language sql stable security definer set search_path=public as $$
 select x from unnest(p_ids) x where public.is_feature_enabled('content_reports') and public.is_verified()
  and exists(select 1 from content_chain(p_type,x) c join content_moderation m on m.target_type=c.t and m.target_id=c.i and m.hidden where c.a=auth.uid() or public.is_admin())
$$;

-- Restrictive policies: hidden content is invisible to everyone but its author and admins.
create policy moderation_hide on public.spaces as restrictive for select to authenticated using(not public.content_hidden_from_viewer('space',id));
create policy moderation_hide on public.discussion_threads as restrictive for select to authenticated using(not public.content_hidden_from_viewer('thread',id));
create policy moderation_hide on public.discussion_replies as restrictive for select to authenticated using(not public.content_hidden_from_viewer('reply',id));
create policy moderation_hide on public.pain_points as restrictive for select to authenticated using(not public.content_hidden_from_viewer('pain_point',id));
create policy moderation_hide on public.space_qa as restrictive for select to authenticated using(not public.content_hidden_from_viewer('qa',id));
-- Owner-privilege views bypass RLS, so wrap their current definitions (service_role is filtered by the server helper instead).
do $$declare v record;d text;begin
 for v in select * from (values('qa_public','qa'),('discussion_threads_read','thread'),('discussion_replies_read','reply')) as x(n,t) loop
  d:=regexp_replace(pg_get_viewdef(('public.'||v.n)::regclass,true),';\s*$','');
  if position('content_hidden_from_viewer' in d)>0 then continue;end if;
  execute format('create or replace view public.%I as select * from (%s) v where (current_user=''service_role'' or not public.content_hidden_from_viewer(%L,v.id))',v.n,d,v.t);
 end loop;
end$$;

-- Best-effort DB-side PII guard for free text (mirrors public/pii.ts); the UI masks via ctx.review first.
create function public.report_text_has_pii(p_text text) returns boolean language sql immutable set search_path=public as $$
 select coalesce(p_text ~* '[A-Z][12][0-9]{8}' or p_text ~* '(病歷號|MRN|Chart\s*No\.?|病患編號)[:：\s#-]*[0-9]{6,10}' or p_text ~ '(病患|病人|個案|患者)[一-龥]{2,4}'
  or p_text ~* '(\m[0-9]{1,2}[A-Z]-[0-9]{1,2}\M|ICU-[0-9]{2})' or p_text ~ '09[0-9]{2}[-\s]?[0-9]{3}[-\s]?[0-9]{3}',false)
$$;
create function public.content_visible_to(p_type text,p_id uuid,p_viewer uuid) returns boolean language sql stable security definer set search_path=public as $$
 select not public.content_hidden_for(p_type,p_id,p_viewer) and case p_type
  when 'space' then exists(select 1 from spaces s where s.id=p_id and s.visibility='public')
  when 'pain_point' then exists(select 1 from pain_points where id=p_id)
  when 'qa' then exists(select 1 from space_qa q join spaces s on s.id=q.space_id where q.id=p_id and s.visibility='public')
  when 'thread' then exists(select 1 from discussion_threads t join spaces s on s.id=t.space_id where t.id=p_id and not t.is_hidden and (s.visibility='public' or s.owner_id=p_viewer))
  when 'reply' then exists(select 1 from discussion_replies r join discussion_threads t on t.id=r.thread_id join spaces s on s.id=t.space_id where r.id=p_id and not r.is_hidden and not t.is_hidden and (s.visibility='public' or s.owner_id=p_viewer))
  else false end
$$;
create function public.content_preview(p_type text,p_id uuid) returns jsonb language sql stable security definer set search_path=public as $$
 select coalesce((select to_jsonb(x) from (
  select 'space' as type,s.id,s.title as title,left(s.summary,300) as body,s.owner_id as author_id,(select display_name from profiles where id=s.owner_id) as author_name,s.id as space_id from spaces s where p_type='space' and s.id=p_id
  union all select 'pain_point',p.id,p.title,left(p.scenario,300),p.proposer_id,(select display_name from profiles where id=p.proposer_id),null from pain_points p where p_type='pain_point' and p.id=p_id
  union all select 'qa',q.id,null,left(q.question_text,300),q.author_id,case when q.is_anonymous then '匿名同仁' else (select display_name from profiles where id=q.author_id) end,q.space_id from space_qa q where p_type='qa' and q.id=p_id
  union all select 'thread',t.id,t.title,left(t.body,300),t.author_id,(select display_name from profiles where id=t.author_id),t.space_id from discussion_threads t where p_type='thread' and t.id=p_id
  union all select 'reply',r.id,null,left(r.body,300),r.author_id,(select display_name from profiles where id=r.author_id),(select space_id from discussion_threads where id=r.thread_id) from discussion_replies r where p_type='reply' and r.id=p_id
 ) x),'{}'::jsonb)||jsonb_build_object('hidden',exists(select 1 from content_moderation where target_type=p_type and target_id=p_id and hidden))
$$;

create function public.report_content(p_type text,p_id uuid,p_reason text,p_detail text default null) returns uuid language plpgsql security definer set search_path=public as $$declare me uuid:=auth.uid();author uuid;rid uuid;begin
 if not is_feature_enabled('content_reports') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if p_type is null or p_type not in ('thread','reply','qa','pain_point','space') then raise exception 'INVALID_TARGET_TYPE';end if;
 if p_reason is null or p_reason not in ('pii','harassment','spam','incorrect','other') then raise exception 'INVALID_REASON';end if;
 p_detail:=nullif(btrim(coalesce(p_detail,'')),'');
 if length(p_detail)>500 then raise exception 'DETAIL_TOO_LONG';end if;
 if report_text_has_pii(p_detail) then raise exception 'PII_DETECTED';end if;
 if p_id is null or not content_visible_to(p_type,p_id,me) then raise exception 'TARGET_NOT_FOUND';end if;
 select a into author from content_chain(p_type,p_id) where t=p_type and i=p_id;
 if author=me then raise exception 'CANNOT_REPORT_OWN';end if;
 perform pg_advisory_xact_lock(hashtext('content_reports:'||me::text));
 if (select count(*) from content_reports where reporter_id=me and created_at>now()-interval '1 day')>=20 then raise exception 'REPORT_RATE_LIMITED';end if;
 begin insert into content_reports(reporter_id,target_type,target_id,reason,detail) values(me,p_type,p_id,p_reason,p_detail) returning id into rid;
 exception when unique_violation then raise exception 'ALREADY_REPORTED';end;
 return rid;
end$$;

-- Internal: close open reports on a target as actioned and tell each reporter.
create function public.close_reports_for(p_type text,p_id uuid,p_actor uuid,p_note text) returns integer language plpgsql security definer set search_path=public as $$declare r record;n integer:=0;begin
 for r in update content_reports set status='actioned',handled_by=p_actor,handled_at=now(),resolution_note=p_note where target_type=p_type and target_id=p_id and status='open' returning id,reporter_id loop
  insert into moderation_events(target_type,target_id,action,actor_id,report_id,note) values(p_type,p_id,'action',p_actor,r.id,p_note);
  perform notify(r.reporter_id,'report_handled','您的檢舉已處理','管理員已審核並處置您檢舉的內容，感謝協助維護社群。',null,jsonb_build_object('report_id',r.id,'status','actioned'));
  n:=n+1;
 end loop;
 return n;
end$$;

create function public.moderate_content(p_type text,p_id uuid,p_hidden boolean,p_note text default null) returns jsonb language plpgsql security definer set search_path=public as $$declare me uuid:=auth.uid();author uuid;closed integer:=0;begin
 if not is_feature_enabled('content_reports') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_type is null or p_type not in ('thread','reply','qa','pain_point','space') then raise exception 'INVALID_TARGET_TYPE';end if;
 if p_hidden is null then raise exception 'INVALID_HIDDEN';end if;
 p_note:=nullif(btrim(coalesce(p_note,'')),'');
 if length(p_note)>500 then raise exception 'NOTE_TOO_LONG';end if;
 if report_text_has_pii(p_note) then raise exception 'PII_DETECTED';end if;
 select a into author from content_chain(p_type,p_id) where t=p_type and i=p_id;
 if not found then raise exception 'TARGET_NOT_FOUND';end if;
 insert into content_moderation(target_type,target_id,hidden,hidden_by,hidden_at,reason) values(p_type,p_id,p_hidden,me,now(),p_note)
  on conflict(target_type,target_id) do update set hidden=excluded.hidden,hidden_by=excluded.hidden_by,hidden_at=excluded.hidden_at,reason=excluded.reason;
 insert into moderation_events(target_type,target_id,action,actor_id,note) values(p_type,p_id,case when p_hidden then 'hide' else 'unhide' end,me,p_note);
 if p_hidden then
  closed:=close_reports_for(p_type,p_id,me,p_note);
  if author is distinct from me then perform notify(author,'content_hidden','您的內容已被管理員隱藏','管理員已隱藏您發表的內容；如有疑問請聯絡版務管理員。',null,jsonb_build_object('target_type',p_type,'target_id',p_id));end if;
 end if;
 return jsonb_build_object('target_type',p_type,'target_id',p_id,'hidden',p_hidden,'reports_closed',closed);
end$$;

create function public.resolve_report(p_id uuid,p_status text,p_note text default null) returns jsonb language plpgsql security definer set search_path=public as $$declare me uuid:=auth.uid();r content_reports;begin
 if not is_feature_enabled('content_reports') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_status is null or p_status not in ('dismissed','actioned') then raise exception 'INVALID_STATUS';end if;
 p_note:=nullif(btrim(coalesce(p_note,'')),'');
 if length(p_note)>500 then raise exception 'NOTE_TOO_LONG';end if;
 if report_text_has_pii(p_note) then raise exception 'PII_DETECTED';end if;
 select * into r from content_reports where id=p_id for update;
 if not found then raise exception 'REPORT_NOT_FOUND';end if;
 if r.status<>'open' then raise exception 'ALREADY_RESOLVED';end if;
 update content_reports set status=p_status,handled_by=me,handled_at=now(),resolution_note=p_note where id=p_id;
 insert into moderation_events(target_type,target_id,action,actor_id,report_id,note) values(r.target_type,r.target_id,case when p_status='dismissed' then 'dismiss' else 'action' end,me,p_id,p_note);
 perform notify(r.reporter_id,'report_handled','您的檢舉已處理',case when p_status='dismissed' then '管理員已審核您的檢舉，目前未對該內容採取處置。' else '管理員已審核並處置您檢舉的內容，感謝協助維護社群。' end,null,jsonb_build_object('report_id',p_id,'status',p_status));
 return jsonb_build_object('id',p_id,'status',p_status);
end$$;

-- Admin queue / history with target previews (admins cannot otherwise read hidden or private content bodies).
create function public.admin_report_queue(p_status text default 'open',p_limit integer default 50,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('content_reports') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 return coalesce((select jsonb_agg(row) from(
  select jsonb_build_object('id',r.id,'target_type',r.target_type,'target_id',r.target_id,'reason',r.reason,'detail',r.detail,'status',r.status,'created_at',r.created_at,
   'handled_at',r.handled_at,'resolution_note',r.resolution_note,'reporter_name',(select display_name from profiles where id=r.reporter_id),'preview',content_preview(r.target_type,r.target_id)) as row
  from content_reports r where p_status is null or r.status=p_status order by r.created_at desc limit least(greatest(p_limit,1),200) offset greatest(p_offset,0)) q),'[]'::jsonb);
end$$;
create function public.admin_moderation_history(p_limit integer default 50) returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('content_reports') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 return coalesce((select jsonb_agg(row) from(
  select jsonb_build_object('id',e.id,'target_type',e.target_type,'target_id',e.target_id,'action',e.action,'note',e.note,'created_at',e.created_at,'actor_name',(select display_name from profiles where id=e.actor_id)) as row
  from moderation_events e order by e.created_at desc limit least(greatest(p_limit,1),200)) q),'[]'::jsonb);
end$$;

revoke all on function public.content_chain(text,uuid),public.content_hidden_for(text,uuid,uuid),public.content_hidden_from_viewer(text,uuid),public.moderation_hidden_ids(text,uuid[],uuid),
 public.moderation_hidden_visible(text,uuid[]),public.report_text_has_pii(text),public.content_visible_to(text,uuid,uuid),public.content_preview(text,uuid),
 public.report_content(text,uuid,text,text),public.close_reports_for(text,uuid,uuid,text),public.moderate_content(text,uuid,boolean,text),public.resolve_report(uuid,text,text),
 public.admin_report_queue(text,integer,integer),public.admin_moderation_history(integer) from public,anon,authenticated;
-- policies/views call the 2-arg helper as the invoking role; everything else stays internal.
grant execute on function public.content_hidden_from_viewer(text,uuid) to authenticated,service_role;
grant execute on function public.moderation_hidden_ids(text,uuid[],uuid) to service_role;
grant execute on function public.moderation_hidden_visible(text,uuid[]),public.report_content(text,uuid,text,text),public.moderate_content(text,uuid,boolean,text),public.resolve_report(uuid,text,text),
 public.admin_report_queue(text,integer,integer),public.admin_moderation_history(integer) to authenticated;
commit;
