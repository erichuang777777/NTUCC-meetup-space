begin;
-- F3 event_feedback: post-event survey for checked-in member attendees. Incremental, runs after 001-013.
create table public.event_feedback_forms (
 id uuid primary key default gen_random_uuid(),event_id uuid not null unique references public.public_events on delete cascade,
 questions jsonb not null default '[]',opens_at timestamptz not null,closes_at timestamptz not null,
 is_anonymous boolean not null default false,created_by uuid references public.profiles(id),
 published_at timestamptz,updated_at timestamptz not null default now(),
 check(closes_at>opens_at),check(jsonb_typeof(questions)='array')
);
create table public.event_feedback_responses (
 id uuid primary key default gen_random_uuid(),form_id uuid not null references public.event_feedback_forms on delete cascade,
 respondent_id uuid not null references public.profiles(id) on delete cascade,answers jsonb not null,
 created_at timestamptz not null default now(),unique(form_id,respondent_id),check(jsonb_typeof(answers)='object')
);
alter table public.event_feedback_forms enable row level security;
alter table public.event_feedback_responses enable row level security;
revoke all on public.event_feedback_forms,public.event_feedback_responses from public,anon,authenticated;
grant all on public.event_feedback_forms,public.event_feedback_responses to service_role;
grant select on public.event_feedback_forms,public.event_feedback_responses to authenticated;

create function public.is_event_staff(p_event uuid) returns boolean language sql stable security definer set search_path=public as $$select is_verified() and exists(select 1 from event_staff where event_id=p_event and user_id=auth.uid())$$;
create function public.is_feedback_attendee(p_event uuid,p_user uuid) returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from event_registrations r join profiles p on p.id=r.user_id where r.event_id=p_event and r.user_id=p_user and r.status='registered' and r.checked_in_at is not null and p.passcode_verified)$$;
revoke all on function public.is_event_staff(uuid),public.is_feedback_attendee(uuid,uuid) from public,anon,authenticated;
grant execute on function public.is_event_staff(uuid) to authenticated,service_role;
grant execute on function public.is_feedback_attendee(uuid,uuid) to authenticated,service_role;

-- Forms: admin/staff of the event, or a checked-in attendee once published. Responses: only the respondent's own row.
-- (Admins/staff see responses only through the aggregate RPCs so anonymous forms cannot leak identities.)
create policy feedback_forms_read on public.event_feedback_forms for select to authenticated using(
 is_feature_enabled('event_feedback') and is_verified() and (is_admin() or is_event_staff(event_id)
 or (published_at is not null and is_feedback_attendee(event_id,auth.uid()))));
create policy feedback_responses_own on public.event_feedback_responses for select to authenticated using(
 is_feature_enabled('event_feedback') and is_verified() and respondent_id=auth.uid());

create function public.validate_feedback_questions(p_q jsonb) returns void language plpgsql immutable set search_path=public as $$declare q jsonb;ids text[]:='{}';o jsonb;begin
 if p_q is null or jsonb_typeof(p_q)<>'array' or jsonb_array_length(p_q)<1 or jsonb_array_length(p_q)>15 then raise exception 'INVALID_QUESTIONS';end if;
 for q in select * from jsonb_array_elements(p_q) loop
  if jsonb_typeof(q)<>'object' or exists(select 1 from jsonb_object_keys(q) k where k<>all(array['id','type','label','options','required'])) then raise exception 'INVALID_QUESTIONS';end if;
  if jsonb_typeof(q->'id')<>'string' or (q->>'id')!~'^[a-z0-9_-]{1,40}$' or (q->>'id')=any(ids) then raise exception 'INVALID_QUESTIONS';end if;
  ids:=ids||(q->>'id');
  if jsonb_typeof(q->'label')<>'string' or length(btrim(q->>'label')) not between 1 and 200 then raise exception 'INVALID_QUESTIONS';end if;
  if q ? 'required' and jsonb_typeof(q->'required')<>'boolean' then raise exception 'INVALID_QUESTIONS';end if;
  if jsonb_typeof(q->'type')<>'string' or (q->>'type') not in ('rating','single','text') then raise exception 'INVALID_QUESTIONS';end if;
  if q->>'type'='single' then
   if jsonb_typeof(q->'options')<>'array' or jsonb_array_length(q->'options') not between 2 and 10 then raise exception 'INVALID_QUESTIONS';end if;
   for o in select * from jsonb_array_elements(q->'options') loop
    if jsonb_typeof(o)<>'string' or length(btrim(o#>>'{}')) not between 1 and 100 then raise exception 'INVALID_QUESTIONS';end if;
   end loop;
   if(select count(distinct x) from jsonb_array_elements_text(q->'options') x)<>jsonb_array_length(q->'options') then raise exception 'INVALID_QUESTIONS';end if;
  elsif q ? 'options' then raise exception 'INVALID_QUESTIONS';end if;
 end loop;
end$$;
revoke all on function public.validate_feedback_questions(jsonb) from public,anon,authenticated;
grant execute on function public.validate_feedback_questions(jsonb) to service_role;

-- Free text (question labels) must pass the server PII guard first, so this is service_role only (called by event-feedback-api).
create function public.upsert_event_feedback_form(p_actor uuid,p_event uuid,p_questions jsonb,p_opens timestamptz,p_closes timestamptz,p_anonymous boolean) returns jsonb language plpgsql security definer set search_path=public as $$declare e public_events;f event_feedback_forms;begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 select * into e from public_events where id=p_event;
 if not found then raise exception 'EVENT_NOT_FOUND';end if;
 perform validate_feedback_questions(p_questions);
 p_opens:=coalesce(p_opens,e.ends_at);
 if p_closes is null or p_closes<=p_opens then raise exception 'INVALID_WINDOW';end if;
 select * into f from event_feedback_forms where event_id=p_event for update;
 if found then
  if exists(select 1 from event_feedback_responses where form_id=f.id) and (f.questions<>p_questions or f.is_anonymous<>coalesce(p_anonymous,false)) then raise exception 'FORM_LOCKED';end if;
  update event_feedback_forms set questions=p_questions,opens_at=p_opens,closes_at=p_closes,is_anonymous=coalesce(p_anonymous,false),updated_at=now() where id=f.id returning * into f;
 else
  insert into event_feedback_forms(event_id,questions,opens_at,closes_at,is_anonymous,created_by) values(p_event,p_questions,p_opens,p_closes,coalesce(p_anonymous,false),p_actor) returning * into f;
 end if;
 return to_jsonb(f);
end$$;

-- Admin publishes; each checked-in member attendee is notified exactly once (re-publish is a no-op).
create function public.publish_event_feedback(p_event uuid) returns jsonb language plpgsql security definer set search_path=public as $$declare f event_feedback_forms;ev_title text;r record;n integer:=0;begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 select * into f from event_feedback_forms where event_id=p_event for update;
 if not found then raise exception 'FORM_NOT_FOUND';end if;
 if f.published_at is not null then return jsonb_build_object('published_at',f.published_at,'notified',0);end if;
 update event_feedback_forms set published_at=now(),updated_at=now() where id=f.id returning * into f;
 select pe.title into ev_title from public_events pe where pe.id=p_event;
 for r in select distinct er.user_id from event_registrations er join profiles p on p.id=er.user_id where er.event_id=p_event and er.status='registered' and er.checked_in_at is not null and p.passcode_verified loop
  perform notify(r.user_id,'event_feedback','活動回饋問卷開放填寫','「'||ev_title||'」的回饋問卷已開放，歡迎分享你的想法。','#event_feedback',jsonb_build_object('event_id',p_event,'form_id',f.id));
  n:=n+1;
 end loop;
 return jsonb_build_object('published_at',f.published_at,'notified',n);
end$$;

-- Submission goes through the Netlify function (PII guard on text answers): service_role only.
create function public.submit_event_feedback(p_user uuid,p_event uuid,p_answers jsonb) returns jsonb language plpgsql security definer set search_path=public as $$declare f event_feedback_forms;q jsonb;v jsonb;res event_feedback_responses;begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 select * into f from event_feedback_forms where event_id=p_event;
 if not found or f.published_at is null then raise exception 'FEEDBACK_UNAVAILABLE';end if;
 if not is_feedback_attendee(p_event,p_user) then raise exception 'NOT_ELIGIBLE';end if;
 if clock_timestamp()<f.opens_at then raise exception 'FEEDBACK_NOT_OPEN';end if;
 if clock_timestamp()>f.closes_at then raise exception 'FEEDBACK_CLOSED';end if;
 if jsonb_typeof(p_answers)<>'object' or exists(select 1 from jsonb_object_keys(p_answers) k where not exists(select 1 from jsonb_array_elements(f.questions) x where x->>'id'=k)) then raise exception 'INVALID_ANSWERS';end if;
 for q in select * from jsonb_array_elements(f.questions) loop
  v:=p_answers->(q->>'id');
  if v is null or v='null'::jsonb or (jsonb_typeof(v)='string' and btrim(v#>>'{}')='') then
   if coalesce((q->>'required')::boolean,false) then raise exception 'INVALID_ANSWERS';end if;
   continue;
  end if;
  if q->>'type'='rating' then
   if jsonb_typeof(v)<>'number' or (v#>>'{}')!~'^[1-5]$' then raise exception 'INVALID_ANSWERS';end if;
  elsif q->>'type'='single' then
   if jsonb_typeof(v)<>'string' or not (q->'options') @> to_jsonb(v#>>'{}') then raise exception 'INVALID_ANSWERS';end if;
  else
   if jsonb_typeof(v)<>'string' or length(v#>>'{}')>2000 then raise exception 'INVALID_ANSWERS';end if;
  end if;
 end loop;
 if exists(select 1 from event_feedback_responses where form_id=f.id and respondent_id=p_user) then raise exception 'ALREADY_SUBMITTED';end if;
 begin
  insert into event_feedback_responses(form_id,respondent_id,answers) values(f.id,p_user,p_answers) returning * into res;
 exception when unique_violation then raise exception 'ALREADY_SUBMITTED';end;
 return jsonb_build_object('id',res.id,'created_at',res.created_at);
end$$;

-- Member view: published forms of events the caller was checked in to (with open/closed state and own-submission flag).
create function public.my_event_feedback_forms() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('event_id',e.id,'event_title',e.title,'starts_at',e.starts_at,'form_id',f.id,'questions',f.questions,'opens_at',f.opens_at,'closes_at',f.closes_at,'is_anonymous',f.is_anonymous,
  'submitted',exists(select 1 from event_feedback_responses x where x.form_id=f.id and x.respondent_id=auth.uid()),
  'state',case when clock_timestamp()<f.opens_at then 'upcoming' when clock_timestamp()>f.closes_at then 'closed' else 'open' end) order by f.opens_at desc)
  from event_feedback_forms f join public_events e on e.id=f.event_id where f.published_at is not null and is_feedback_attendee(e.id,auth.uid())),'[]');
end$$;

-- Admin/staff: events with their form status.
create function public.event_feedback_admin_list() returns jsonb language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('event_id',e.id,'title',e.title,'starts_at',e.starts_at,'ends_at',e.ends_at,'can_edit',is_admin(),
  'form',case when f.id is null then null else jsonb_build_object('id',f.id,'questions',f.questions,'opens_at',f.opens_at,'closes_at',f.closes_at,'is_anonymous',f.is_anonymous,'published_at',f.published_at) end) order by e.starts_at desc)
  from public_events e left join event_feedback_forms f on f.event_id=e.id where is_admin() or is_event_staff(e.id)),'[]');
end$$;

create function public.event_feedback_summary(p_event uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$declare f event_feedback_forms;q jsonb;acc jsonb:='[]';item jsonb;cnt integer;begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 if not (is_admin() or is_event_staff(p_event)) then raise exception 'STAFF_REQUIRED';end if;
 select * into f from event_feedback_forms where event_id=p_event;
 if not found then raise exception 'FORM_NOT_FOUND';end if;
 select count(*) into cnt from event_feedback_responses where form_id=f.id;
 for q in select * from jsonb_array_elements(f.questions) loop
  item:=jsonb_build_object('id',q->>'id','type',q->>'type','label',q->>'label');
  if q->>'type'='rating' then
   item:=item||(select jsonb_build_object('answered',count(*),'average',round(avg((a.answers->>(q->>'id'))::numeric),2),
    'distribution',jsonb_build_object('1',count(*) filter(where a.answers->>(q->>'id')='1'),'2',count(*) filter(where a.answers->>(q->>'id')='2'),'3',count(*) filter(where a.answers->>(q->>'id')='3'),'4',count(*) filter(where a.answers->>(q->>'id')='4'),'5',count(*) filter(where a.answers->>(q->>'id')='5')))
    from event_feedback_responses a where a.form_id=f.id and a.answers ? (q->>'id'));
  elsif q->>'type'='single' then
   item:=item||jsonb_build_object('counts',(select coalesce(jsonb_object_agg(s.o,s.n),'{}') from (select o.value as o,(select count(*) from event_feedback_responses a where a.form_id=f.id and a.answers->>(q->>'id')=o.value) as n from jsonb_array_elements_text(q->'options') o(value)) s));
  else
   -- hash order on purpose: avoids linking text to submission order
   item:=item||jsonb_build_object('texts',(select coalesce(jsonb_agg(a.answers->>(q->>'id') order by md5(a.id::text)),'[]') from event_feedback_responses a where a.form_id=f.id and btrim(coalesce(a.answers->>(q->>'id'),''))<>''));
  end if;
  acc:=acc||item;
 end loop;
 return jsonb_build_object('event_id',p_event,'is_anonymous',f.is_anonymous,'published_at',f.published_at,'response_count',cnt,
  'eligible_count',(select count(*) from event_registrations where event_id=p_event and status='registered' and checked_in_at is not null and user_id is not null),'questions',acc);
end$$;

-- Anonymous forms: no respondent fields and no timestamps, rows in hash order. Named forms include the respondent.
create function public.event_feedback_export(p_event uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$declare f event_feedback_forms;begin
 if not is_feature_enabled('event_feedback') then raise exception 'FEATURE_DISABLED';end if;
 if not (is_admin() or is_event_staff(p_event)) then raise exception 'STAFF_REQUIRED';end if;
 select * into f from event_feedback_forms where event_id=p_event;
 if not found then raise exception 'FORM_NOT_FOUND';end if;
 return jsonb_build_object('is_anonymous',f.is_anonymous,'questions',f.questions,'rows',coalesce((
  select jsonb_agg(case when f.is_anonymous then jsonb_build_object('answers',a.answers)
   else jsonb_build_object('respondent_id',a.respondent_id,'respondent_name',p.display_name,'submitted_at',a.created_at,'answers',a.answers) end order by md5(a.id::text))
  from event_feedback_responses a join profiles p on p.id=a.respondent_id where a.form_id=f.id),'[]'));
end$$;

revoke all on function public.upsert_event_feedback_form(uuid,uuid,jsonb,timestamptz,timestamptz,boolean),public.publish_event_feedback(uuid),public.submit_event_feedback(uuid,uuid,jsonb),public.my_event_feedback_forms(),public.event_feedback_admin_list(),public.event_feedback_summary(uuid),public.event_feedback_export(uuid) from public,anon,authenticated;
grant execute on function public.upsert_event_feedback_form(uuid,uuid,jsonb,timestamptz,timestamptz,boolean),public.submit_event_feedback(uuid,uuid,jsonb) to service_role;
grant execute on function public.publish_event_feedback(uuid),public.my_event_feedback_forms(),public.event_feedback_admin_list(),public.event_feedback_summary(uuid),public.event_feedback_export(uuid) to authenticated,service_role;
commit;
