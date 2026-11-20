begin;
-- F11 event_archive: curated post-event review pages + browsable archive list. Incremental, runs after 001-023 (uses 018 report_text_has_pii/content_hidden_for).
-- Members only (is_verified); admin curates through RPCs. No table is directly readable by anon; photos stay behind the existing event-photos public endpoint rules.
create table public.event_archives (
 event_id uuid primary key references public.public_events(id) on delete cascade,
 summary text not null default '' check(length(summary)<=3000),
 highlights jsonb not null default '[]' check(jsonb_typeof(highlights)='array' and jsonb_array_length(highlights)<=10),
 slides_links jsonb not null default '[]' check(jsonb_typeof(slides_links)='array' and jsonb_array_length(slides_links)<=20),
 related_space_ids uuid[] not null default '{}' check(cardinality(related_space_ids)<=20),
 published boolean not null default false,published_at timestamptz,
 updated_by uuid references public.profiles(id) on delete set null,updated_at timestamptz not null default now()
);
create index event_archives_published on public.event_archives(published_at desc) where published;
alter table public.event_archives enable row level security;
revoke all on public.event_archives from public,anon,authenticated;
grant all on public.event_archives to service_role;
grant select on public.event_archives to authenticated;
-- Direct reads: admin only (curation drafts). Members read published archives only through event_archive_page/list_event_archives.
create policy event_archives_admin_read on public.event_archives for select to authenticated using(is_feature_enabled('event_archive') and is_admin());

create function public.event_archive_validate(p_summary text,p_highlights jsonb,p_slides jsonb,p_related uuid[]) returns void language plpgsql stable set search_path=public as $$declare x jsonb;begin
 if length(coalesce(p_summary,''))>3000 then raise exception 'INVALID_ARCHIVE';end if;
 if p_highlights is null or jsonb_typeof(p_highlights)<>'array' or jsonb_array_length(p_highlights)>10 then raise exception 'INVALID_ARCHIVE';end if;
 for x in select * from jsonb_array_elements(p_highlights) loop
  if jsonb_typeof(x)<>'string' or length(btrim(x#>>'{}')) not between 1 and 200 then raise exception 'INVALID_ARCHIVE';end if;
  if report_text_has_pii(x#>>'{}') then raise exception 'PII_DETECTED';end if;
 end loop;
 if p_slides is null or jsonb_typeof(p_slides)<>'array' or jsonb_array_length(p_slides)>20 then raise exception 'INVALID_ARCHIVE';end if;
 for x in select * from jsonb_array_elements(p_slides) loop
  if jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k<>all(array['title','url'])) then raise exception 'INVALID_ARCHIVE';end if;
  if jsonb_typeof(x->'title')<>'string' or length(btrim(x->>'title')) not between 1 and 100 then raise exception 'INVALID_ARCHIVE';end if;
  if jsonb_typeof(x->'url')<>'string' or length(x->>'url')>500 or (x->>'url')!~'^https://[^\s<>"'']+$' then raise exception 'INVALID_URL';end if;
  if report_text_has_pii(x->>'title') or report_text_has_pii(x->>'url') then raise exception 'PII_DETECTED';end if;
 end loop;
 if p_related is null or cardinality(p_related)>20 or (select count(distinct r) from unnest(p_related) r)<>cardinality(p_related) then raise exception 'INVALID_ARCHIVE';end if;
 if exists(select 1 from unnest(p_related) r where not exists(select 1 from spaces s where s.id=r and s.visibility='public')) then raise exception 'SPACE_NOT_FOUND';end if;
 if report_text_has_pii(p_summary) then raise exception 'PII_DETECTED';end if;
end$$;

create function public.save_event_archive(p_event uuid,p_summary text,p_highlights jsonb,p_slides jsonb,p_related uuid[],p_publish boolean default false) returns jsonb language plpgsql security definer set search_path=public as $$declare a event_archives;s text:=btrim(coalesce(p_summary,''));begin
 if not is_feature_enabled('event_archive') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if not exists(select 1 from public_events where id=p_event) then raise exception 'EVENT_NOT_FOUND';end if;
 p_highlights:=coalesce(p_highlights,'[]');p_slides:=coalesce(p_slides,'[]');p_related:=coalesce(p_related,'{}');
 perform event_archive_validate(s,p_highlights,p_slides,p_related);
 insert into event_archives(event_id,summary,highlights,slides_links,related_space_ids,published,published_at,updated_by,updated_at)
 values(p_event,s,p_highlights,p_slides,p_related,coalesce(p_publish,false),case when coalesce(p_publish,false) then now() end,auth.uid(),now())
 on conflict(event_id) do update set summary=excluded.summary,highlights=excluded.highlights,slides_links=excluded.slides_links,related_space_ids=excluded.related_space_ids,
  published=excluded.published,published_at=case when excluded.published then coalesce(event_archives.published_at,now()) else event_archives.published_at end,updated_by=auth.uid(),updated_at=now()
 returning * into a;
 return to_jsonb(a);
end$$;

-- Draft only (not saved): highlights from agenda + scheduled talks (max 10, de-duplicated); related spaces = latest public, non-hidden space of each scheduled talk's proposer.
create function public.generate_event_archive_draft(p_event uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$declare e public_events;h jsonb;rel uuid[];begin
 if not is_feature_enabled('event_archive') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 select * into e from public_events where id=p_event;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 select coalesce(jsonb_agg(t order by ord),'[]') into h from (
  select t,ord from (select distinct on (t) t,ord from (
   select ord::bigint,left(btrim(a->>'title')||case when btrim(coalesce(a->>'speaker',''))<>'' then '（'||btrim(a->>'speaker')||'）' else '' end,200) as t
    from jsonb_array_elements(e.agenda) with ordinality g(a,ord) where btrim(coalesce(a->>'title',''))<>''
   union all
   select 1000+row_number() over(order by tp.updated_at),left(btrim(tp.title),200) from talk_proposals tp where tp.scheduled_event_id=p_event and tp.status='scheduled') q order by t,ord) d
  order by ord limit 10) z;
 select coalesce(array_agg(id),'{}') into rel from (select distinct on (s.owner_id) s.id from talk_proposals tp join spaces s on s.owner_id=tp.proposer_id and s.visibility='public'
  where tp.scheduled_event_id=p_event and tp.status='scheduled' and not content_hidden_for('space',s.id,null) order by s.owner_id,s.created_at desc limit 20) r;
 return jsonb_build_object('summary',left(coalesce(e.description,''),3000),'highlights',h,'related_space_ids',to_jsonb(rel),'slides_links','[]'::jsonb);
end$$;

create function public.event_archive_page(p_event uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$declare e public_events;a event_archives;f event_feedback_forms;cnt integer;fb jsonb:=null;spaces_j jsonb;photos_j jsonb:='[]';ser text;begin
 if not is_feature_enabled('event_archive') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 select * into e from public_events where id=p_event and is_published;
 if not found then raise exception 'ARCHIVE_NOT_FOUND';end if;
 select * into a from event_archives where event_id=p_event;
 if not found or (not a.published and not is_admin()) then raise exception 'ARCHIVE_NOT_FOUND';end if;
 select title into ser from event_series where id=e.series_id;
 -- content_hidden_for(..., null): hidden for everyone, so the page is identical for all members (admin preview included)
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'summary',s.summary,'category_tag',s.category_tag,
   'qa',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'question_text',q.question_text,'speaker_reply',q.speaker_reply,'upvotes',q.upvotes) order by q.upvotes desc,q.created_at,q.id)
     from (select * from space_qa x where x.space_id=s.id and not content_hidden_for('qa',x.id,null) order by x.upvotes desc,x.created_at,x.id limit 5) q),'[]')) order by array_position(a.related_space_ids,s.id)),'[]') into spaces_j
  from spaces s where s.id=any(a.related_space_ids) and s.visibility='public' and not content_hidden_for('space',s.id,null);
 -- same rules as the public photo endpoint: published + consent + public_web, and the event itself is public
 if e.audience='public' then
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'url','/api/v1/event-photos/public/'||p.id) order by p.created_at desc,p.id),'[]') into photos_j
   from (select id,created_at from event_photos where event_id=p_event and status='published' and publication_consent and audience='public_web' order by created_at desc,id limit 24) p;
 end if;
 if is_feature_enabled('event_feedback') then
  select * into f from event_feedback_forms where event_id=p_event and published_at is not null;
  if found then
   select count(*) into cnt from event_feedback_responses where form_id=f.id;
   -- rating averages only from 3+ responses so a lone respondent cannot be inferred; never any text answers
   fb:=jsonb_build_object('response_count',cnt,'ratings',case when cnt<3 then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('label',q->>'label','average',(select round(avg((r.answers->>(q->>'id'))::numeric),2) from event_feedback_responses r where r.form_id=f.id and r.answers ? (q->>'id')),
     'answered',(select count(*) from event_feedback_responses r where r.form_id=f.id and r.answers ? (q->>'id'))))
    from jsonb_array_elements(f.questions) q where q->>'type'='rating'),'[]') end);
  end if;
 end if;
 return jsonb_build_object('event',jsonb_build_object('id',e.id,'title',e.title,'description',e.description,'location',e.location,'starts_at',e.starts_at,'ends_at',e.ends_at,'audience',e.audience,'series_id',e.series_id,'series_title',ser),
  'agenda',e.agenda,'summary',a.summary,'highlights',a.highlights,'slides_links',a.slides_links,'published',a.published,'published_at',a.published_at,
  'spaces',spaces_j,'photos',photos_j,'feedback',fb);
end$$;

create function public.list_event_archives(p_series uuid default null,p_query text default null,p_limit integer default 20,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path=public as $$declare q text:=nullif(btrim(coalesce(p_query,'')),'');begin
 if not is_feature_enabled('event_archive') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 p_limit:=least(greatest(coalesce(p_limit,20),1),50);p_offset:=greatest(coalesce(p_offset,0),0);
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.starts_at desc,x.event_id) from (
  select e.id as event_id,e.title,e.starts_at,e.series_id,s.title as series_title,left(a.summary,200) as summary,jsonb_array_length(a.highlights) as highlight_count,a.published_at
  from event_archives a join public_events e on e.id=a.event_id left join event_series s on s.id=e.series_id
  where a.published and e.is_published and (p_series is null or e.series_id=p_series)
   and (q is null or position(lower(q) in lower(e.title))>0)
  order by e.starts_at desc,e.id limit p_limit offset p_offset) x),'[]');
end$$;

-- Admin: events with archive status (for the curation panel).
create function public.event_archive_admin_list() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('event_archive') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('event_id',e.id,'title',e.title,'starts_at',e.starts_at,'is_published',e.is_published,'has_archive',a.event_id is not null,'published',coalesce(a.published,false),
  'summary',a.summary,'highlights',coalesce(a.highlights,'[]'),'slides_links',coalesce(a.slides_links,'[]'),'related_space_ids',to_jsonb(coalesce(a.related_space_ids,'{}'))) order by e.starts_at desc)
  from public_events e left join event_archives a on a.event_id=e.id),'[]');
end$$;

revoke all on function public.event_archive_validate(text,jsonb,jsonb,uuid[]),public.save_event_archive(uuid,text,jsonb,jsonb,uuid[],boolean),public.generate_event_archive_draft(uuid),public.event_archive_page(uuid),
 public.list_event_archives(uuid,text,integer,integer),public.event_archive_admin_list() from public,anon,authenticated;
grant execute on function public.save_event_archive(uuid,text,jsonb,jsonb,uuid[],boolean),public.generate_event_archive_draft(uuid),public.event_archive_page(uuid),
 public.list_event_archives(uuid,text,integer,integer),public.event_archive_admin_list() to authenticated,service_role;
commit;
