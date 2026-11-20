begin;
-- F12 global_search: one RPC searching every source the caller may already read. Incremental, runs after 001-023.
-- Gated by is_feature_enabled('global_search'); a source that has its own feature flag is skipped while that flag is off.
-- Visibility is re-implemented explicitly (the function is security definer): see the per-source comments.
create extension if not exists pg_trgm with schema extensions;

-- Trigram indexes serve the ILIKE '%q%' predicates (also fine for CJK text, where word FTS does not tokenize).
create index if not exists gs_announcements_title_trgm on public.announcements using gin(title extensions.gin_trgm_ops);
create index if not exists gs_announcements_content_trgm on public.announcements using gin(content extensions.gin_trgm_ops);
create index if not exists gs_public_announcements_title_trgm on public.public_announcements using gin(title extensions.gin_trgm_ops);
create index if not exists gs_public_announcements_content_trgm on public.public_announcements using gin(content extensions.gin_trgm_ops);
create index if not exists gs_public_events_title_trgm on public.public_events using gin(title extensions.gin_trgm_ops);
create index if not exists gs_public_events_description_trgm on public.public_events using gin(description extensions.gin_trgm_ops);
create index if not exists gs_spaces_title_trgm on public.spaces using gin(title extensions.gin_trgm_ops);
create index if not exists gs_spaces_summary_trgm on public.spaces using gin(summary extensions.gin_trgm_ops);
create index if not exists gs_threads_title_trgm on public.discussion_threads using gin(title extensions.gin_trgm_ops);
create index if not exists gs_threads_body_trgm on public.discussion_threads using gin(body extensions.gin_trgm_ops);
create index if not exists gs_replies_body_trgm on public.discussion_replies using gin(body extensions.gin_trgm_ops);
create index if not exists gs_pain_points_title_trgm on public.pain_points using gin(title extensions.gin_trgm_ops);
create index if not exists gs_pain_points_scenario_trgm on public.pain_points using gin(scenario extensions.gin_trgm_ops);
create index if not exists gs_talk_proposals_title_trgm on public.talk_proposals using gin(title extensions.gin_trgm_ops);
create index if not exists gs_talk_proposals_abstract_trgm on public.talk_proposals using gin(abstract extensions.gin_trgm_ops);
create index if not exists gs_directory_bio_trgm on public.member_directory_profiles using gin(bio extensions.gin_trgm_ops);

-- ≤160 chars of already-visible text around the first (case-insensitive) match; start of text when there is no match.
create function public.global_search_snippet(p_text text,p_q text) returns text language sql immutable set search_path=public as $$
 with t as(select regexp_replace(coalesce(p_text,''),'\s+',' ','g') s),
 p as(select s,greatest(coalesce(nullif(strpos(lower(s),lower(p_q)),0),1)-40,1) st from t)
 select case when st>1 then '…' else '' end||substr(s,st,156)||case when length(s)>st+155 then '…' else '' end from p
$$;

create function public.global_search(p_query text,p_types text[] default null,p_limit int default 20,p_offset int default 0)
returns table(type text,id uuid,title text,snippet text,link text,created_at timestamptz,score double precision)
language plpgsql stable security definer set search_path=public,extensions as $$
declare me uuid:=auth.uid();q text:=btrim(coalesce(p_query,''));pat text;lim int:=least(greatest(coalesce(p_limit,20),1),50);off int:=greatest(coalesce(p_offset,0),0);
 dir boolean;tp boolean;
begin
 if not is_feature_enabled('global_search') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if length(q)<2 then raise exception 'QUERY_TOO_SHORT';end if;
 if length(q)>100 then raise exception 'QUERY_TOO_LONG';end if;
 pat:='%'||replace(replace(replace(q,'\','\\'),'%','\%'),'_','\_')||'%';
 dir:=is_feature_enabled('member_directory');tp:=is_feature_enabled('talk_proposals');
 return query
 with src as(
  -- member announcements: RLS announcements_read = any verified member
  (select 'announcement'::text ty,a.id,a.title,a.content body,'#announcements'::text lk,a.created_at from announcements a
   where (p_types is null or 'announcement'=any(p_types)) and (a.title ilike pat or a.content ilike pat) order by a.created_at desc limit 200)
  union all
  -- public editorial announcements: published only
  (select 'announcement',a.id,a.title,a.content,'#events',a.created_at from public_announcements a
   where a.is_published and (p_types is null or 'announcement'=any(p_types)) and (a.title ilike pat or a.content ilike pat) order by a.created_at desc limit 200)
  union all
  -- events: published only; verified members may see both audiences (members-only is closed to anonymous callers, who cannot reach this RPC)
  (select 'event',e.id,e.title,btrim(e.description||' '||e.location),'#event/'||e.id,e.starts_at from public_events e
   where e.is_published and (p_types is null or 'event'=any(p_types)) and (e.title ilike pat or e.description ilike pat or e.location ilike pat) order by e.starts_at desc limit 200)
  union all
  -- spaces: public visibility only, not moderation-hidden for the caller (018)
  (select 'space',s.id,s.title,s.summary,'#project/'||s.id,s.created_at from spaces s
   where s.visibility='public' and (p_types is null or 'space'=any(p_types)) and (s.title ilike pat or s.summary ilike pat) and content_visible_to('space',s.id,me) order by s.created_at desc limit 200)
  union all
  -- threads: not hidden, parent space public or owned by caller, not moderation-hidden (same rule as thread_read policy + 018)
  (select 'thread',t.id,t.title,t.body,'#project/'||t.space_id||'/thread/'||t.id,t.created_at from discussion_threads t
   where not t.is_hidden and (p_types is null or 'thread'=any(p_types)) and (t.title ilike pat or t.body ilike pat) and content_visible_to('thread',t.id,me) order by t.created_at desc limit 200)
  union all
  -- replies: reply and parent thread not hidden, space rule as for threads; title is the parent thread title
  (select 'reply',r.id,t.title,r.body,'#project/'||t.space_id||'/thread/'||t.id,r.created_at from discussion_replies r join discussion_threads t on t.id=r.thread_id
   where not r.is_hidden and not t.is_hidden and (p_types is null or 'reply'=any(p_types)) and r.body ilike pat and content_visible_to('reply',r.id,me) order by r.created_at desc limit 200)
  union all
  -- pain points: any verified member, minus moderation-hidden
  (select 'pain_point',p.id,p.title,btrim(p.scenario||' '||coalesce(p.ideal_outcome,'')),'#pain',p.created_at from pain_points p
   where (p_types is null or 'pain_point'=any(p_types)) and (p.title ilike pat or p.scenario ilike pat or p.ideal_outcome ilike pat) and content_visible_to('pain_point',p.id,me) order by p.created_at desc limit 200)
  union all
  -- talk proposals: only accepted/scheduled (list_accepted_talks semantics); flag talk_proposals
  (select 'talk',t.id,t.title,t.abstract,'#talk_proposals',coalesce(t.reviewed_at,t.created_at) from talk_proposals t
   where tp and t.status in ('accepted','scheduled') and (p_types is null or 'talk'=any(p_types)) and (t.title ilike pat or t.abstract ilike pat) order by 6 desc limit 200)
  union all
  -- member directory: listed + verified + never across a contact block (search_member_directory semantics); flag member_directory
  (select 'member',d.user_id,p.display_name,btrim(d.bio||' '||array_to_string(d.expertise_tags,' ')||' '||d.question_topics),'#member_directory',d.updated_at from member_directory_profiles d join profiles p on p.id=d.user_id
   where dir and d.listed and p.passcode_verified and not directory_blocked(d.user_id) and (p_types is null or 'member'=any(p_types))
    and (p.display_name ilike pat or d.bio ilike pat or d.question_topics ilike pat or array_to_string(d.expertise_tags,' ') ilike pat) order by d.updated_at desc limit 200)
 )
 select s.ty,s.id,s.title,global_search_snippet(s.body,q),s.lk,s.created_at,
  (greatest(word_similarity(q,s.title),word_similarity(q,coalesce(s.body,'')))
   +case when s.title ilike pat then 1.0 else 0 end+case when coalesce(s.body,'') ilike pat then 0.5 else 0 end
   +0.3/(1+greatest(extract(epoch from now()-s.created_at),0)/86400/30))::double precision sc
 from src s order by sc desc,s.created_at desc,s.id limit lim offset off;
end$$;
revoke all on function public.global_search_snippet(text,text),public.global_search(text,text[],int,int) from public,anon,authenticated;
grant execute on function public.global_search(text,text[],int,int) to authenticated,service_role;
commit;
