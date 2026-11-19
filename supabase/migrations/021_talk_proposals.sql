begin;
-- F8 talk_proposals: call for talks / speaker sign-up. Incremental, runs after 001-013 (uses 014 notify, 018 report_text_has_pii).
-- Writes by proposers go through netlify/functions/talk-proposals-api.ts (PII guard) -> service_role-only RPCs.
create table public.talk_proposals (
 id uuid primary key default gen_random_uuid(),proposer_id uuid not null references public.profiles(id) on delete cascade,
 title text not null check(length(btrim(title)) between 1 and 120),abstract text not null check(length(btrim(abstract)) between 1 and 1500),
 category_tag text not null check(category_tag in ('實戰展示','踩坑避雷')),duration_minutes integer not null check(duration_minutes in (5,10,15,20)),
 preferred_event_id uuid references public.public_events(id) on delete set null,pain_point_id uuid references public.pain_points(id) on delete set null,
 status text not null default 'draft' check(status in ('draft','submitted','accepted','returned','scheduled','withdrawn')),
 reviewer_note text check(reviewer_note is null or length(reviewer_note)<=1000),reviewed_by uuid references public.profiles(id),reviewed_at timestamptz,
 scheduled_event_id uuid references public.public_events(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index talk_proposals_proposer on public.talk_proposals(proposer_id,created_at desc);
create index talk_proposals_status on public.talk_proposals(status,created_at);
create index talk_proposals_pain on public.talk_proposals(pain_point_id) where status in ('accepted','scheduled');
alter table public.talk_proposals enable row level security;
revoke all on public.talk_proposals from public,anon,authenticated;
grant all on public.talk_proposals to service_role;
grant select on public.talk_proposals to authenticated;
-- Proposer reads own rows; admins read everything past draft. Other members only see accepted talks via list_accepted_talks().
create policy talk_proposals_own on public.talk_proposals for select to authenticated using(public.is_feature_enabled('talk_proposals') and public.is_verified() and proposer_id=auth.uid());
create policy talk_proposals_admin on public.talk_proposals for select to authenticated using(public.is_feature_enabled('talk_proposals') and public.is_admin() and status<>'draft');

-- ---- proposer writes (service_role only; called by talk-proposals-api after the PII guard) ----
create function public.upsert_talk_proposal(p_actor uuid,p_id uuid,p_title text,p_abstract text,p_category text,p_duration integer,p_preferred_event uuid,p_pain uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare r talk_proposals;begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and passcode_verified) then raise exception 'MEMBER_REQUIRED';end if;
 if p_title is null or length(btrim(p_title)) not between 1 and 120 or p_abstract is null or length(btrim(p_abstract)) not between 1 and 1500
  or p_category is null or p_category not in ('實戰展示','踩坑避雷') or p_duration is null or p_duration not in (5,10,15,20) then raise exception 'INVALID_PROPOSAL';end if;
 if p_preferred_event is not null and not exists(select 1 from public_events where id=p_preferred_event) then raise exception 'EVENT_NOT_FOUND';end if;
 if p_pain is not null and not exists(select 1 from pain_points where id=p_pain) then raise exception 'PAIN_POINT_NOT_FOUND';end if;
 if p_id is null then
  insert into talk_proposals(proposer_id,title,abstract,category_tag,duration_minutes,preferred_event_id,pain_point_id) values(p_actor,btrim(p_title),btrim(p_abstract),p_category,p_duration,p_preferred_event,p_pain) returning * into r;
 else
  select * into r from talk_proposals where id=p_id and proposer_id=p_actor for update;
  if not found then raise exception 'PROPOSAL_NOT_FOUND';end if;
  if r.status not in ('draft','returned') then raise exception 'NOT_EDITABLE';end if;
  update talk_proposals set title=btrim(p_title),abstract=btrim(p_abstract),category_tag=p_category,duration_minutes=p_duration,preferred_event_id=p_preferred_event,pain_point_id=p_pain,updated_at=now() where id=p_id returning * into r;
 end if;
 return to_jsonb(r);
end$$;
create function public.submit_talk_proposal(p_actor uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare r talk_proposals;begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and passcode_verified) then raise exception 'MEMBER_REQUIRED';end if;
 select * into r from talk_proposals where id=p_id and proposer_id=p_actor for update;
 if not found then raise exception 'PROPOSAL_NOT_FOUND';end if;
 if r.status not in ('draft','returned') then raise exception 'INVALID_TRANSITION';end if;
 update talk_proposals set status='submitted',updated_at=now() where id=p_id returning * into r;
 return to_jsonb(r);
end$$;
-- A scheduled talk is already on a public agenda, so it cannot be withdrawn by the proposer; everything else may be.
create function public.withdraw_talk_proposal(p_actor uuid,p_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare r talk_proposals;begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and passcode_verified) then raise exception 'MEMBER_REQUIRED';end if;
 select * into r from talk_proposals where id=p_id and proposer_id=p_actor for update;
 if not found then raise exception 'PROPOSAL_NOT_FOUND';end if;
 if r.status not in ('draft','submitted','returned','accepted') then raise exception 'INVALID_TRANSITION';end if;
 update talk_proposals set status='withdrawn',updated_at=now() where id=p_id returning * into r;
 return to_jsonb(r);
end$$;
revoke all on function public.upsert_talk_proposal(uuid,uuid,text,text,text,integer,uuid,uuid),public.submit_talk_proposal(uuid,uuid),public.withdraw_talk_proposal(uuid,uuid) from public,anon,authenticated;
grant execute on function public.upsert_talk_proposal(uuid,uuid,text,text,text,integer,uuid,uuid),public.submit_talk_proposal(uuid,uuid),public.withdraw_talk_proposal(uuid,uuid) to service_role;

-- ---- admin review (authenticated; the note is free text so it gets the DB-side best-effort PII check from 018) ----
create function public.review_talk_proposal(p_id uuid,p_status text,p_note text default null) returns jsonb language plpgsql security definer set search_path=public as $$declare r talk_proposals;n text:=nullif(btrim(coalesce(p_note,'')),'');begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_status not in ('accepted','returned') then raise exception 'INVALID_STATUS';end if;
 if n is not null and length(n)>1000 then raise exception 'INVALID_NOTE';end if;
 if p_status='returned' and n is null then raise exception 'NOTE_REQUIRED';end if;
 if n is not null and report_text_has_pii(n) then raise exception 'PII_DETECTED';end if;
 select * into r from talk_proposals where id=p_id for update;
 if not found then raise exception 'PROPOSAL_NOT_FOUND';end if;
 if r.status<>'submitted' then raise exception 'INVALID_TRANSITION';end if;
 update talk_proposals set status=p_status,reviewer_note=n,reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=p_id returning * into r;
 perform notify(r.proposer_id,'talk_proposal_reviewed',case when p_status='accepted' then '投稿已被接受' else '投稿已退回，請修改' end,
  '「'||left(r.title,60)||'」'||case when p_status='accepted' then '已被接受，管理員將安排場次。' else '已退回：'||coalesce(n,'') end,'#talk_proposals',jsonb_build_object('proposal_id',r.id,'status',p_status));
 return to_jsonb(r);
end$$;
-- Schedule an accepted talk onto an event: appends an entry to public_events.agenda (009: jsonb array of {time,title,speaker}, max 30,
-- the same shape events-api validates) and records scheduled_event_id. The time is the event start (Taipei); admins can edit the agenda afterwards.
create function public.schedule_talk_proposal(p_id uuid,p_event_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare r talk_proposals;e public_events;spk text;begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 select * into r from talk_proposals where id=p_id for update;
 if not found then raise exception 'PROPOSAL_NOT_FOUND';end if;
 if r.status<>'accepted' then raise exception 'INVALID_TRANSITION';end if;
 select * into e from public_events where id=p_event_id for update;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 if jsonb_array_length(e.agenda)>=30 then raise exception 'AGENDA_FULL';end if;
 select left(display_name,100) into spk from profiles where id=r.proposer_id;
 update public_events set agenda=agenda||jsonb_build_array(jsonb_build_object('time',to_char(e.starts_at at time zone 'Asia/Taipei','HH24:MI'),'title',left(r.title,200),'speaker',spk)) where id=p_event_id;
 update talk_proposals set status='scheduled',scheduled_event_id=p_event_id,updated_at=now() where id=p_id returning * into r;
 perform notify(r.proposer_id,'talk_proposal_reviewed','投稿已排入議程','「'||left(r.title,60)||'」已排入「'||left(e.title,60)||'」的議程。','#talk_proposals',jsonb_build_object('proposal_id',r.id,'status','scheduled','event_id',p_event_id));
 return to_jsonb(r);
end$$;
-- Admin queue with proposer names (drafts and withdrawn rows are not listed).
create function public.talk_proposals_admin_list() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from (
  select t.*,p.display_name as proposer_name,e.title as preferred_event_title,sv.title as scheduled_event_title,pp.title as pain_point_title
  from talk_proposals t join profiles p on p.id=t.proposer_id left join public_events e on e.id=t.preferred_event_id left join public_events sv on sv.id=t.scheduled_event_id left join pain_points pp on pp.id=t.pain_point_id
  where t.status not in ('draft','withdrawn')) x),'[]');
end$$;
-- Transparency list for verified members: only accepted/scheduled, only title/category/duration/proposer name.
create function public.list_accepted_talks() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.reviewed_at desc nulls last) from (
  select t.id,t.title,t.category_tag,t.duration_minutes,t.status,t.pain_point_id,t.scheduled_event_id,t.reviewed_at,p.display_name as proposer_name
  from talk_proposals t join profiles p on p.id=t.proposer_id where t.status in ('accepted','scheduled')) x),'[]');
end$$;
-- Number of accepted/scheduled (non-withdrawn) talks claiming a pain point; the batch variant feeds the pain-point list in one call.
create function public.pain_point_claims(p_pain uuid) returns integer language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return(select count(*)::integer from talk_proposals where pain_point_id=p_pain and status in ('accepted','scheduled'));
end$$;
create function public.pain_point_claim_counts() returns table(pain_point_id uuid,claims integer) language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('talk_proposals') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return query select t.pain_point_id,count(*)::integer from talk_proposals t where t.pain_point_id is not null and t.status in ('accepted','scheduled') group by t.pain_point_id;
end$$;
revoke all on function public.review_talk_proposal(uuid,text,text),public.schedule_talk_proposal(uuid,uuid),public.talk_proposals_admin_list(),public.list_accepted_talks(),public.pain_point_claims(uuid),public.pain_point_claim_counts() from public,anon,authenticated;
grant execute on function public.review_talk_proposal(uuid,text,text),public.schedule_talk_proposal(uuid,uuid),public.talk_proposals_admin_list(),public.list_accepted_talks(),public.pain_point_claims(uuid),public.pain_point_claim_counts() to authenticated,service_role;
commit;
