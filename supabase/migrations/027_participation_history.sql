begin;
-- F14 participation_history: personal participation timeline (own data only) + opt-in aggregate summary in the member directory.
-- Incremental: runs after 001-023 (uses 015 member_directory_profiles/directory_blocked, 018 content_hidden_for).
-- Other features' sections (talks, hosted events, feedback, polls) are included only while their own flag is on; nothing is deleted when flags go off.
create table public.participation_visibility (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 show_in_directory boolean not null default false,
 updated_at timestamptz not null default now()
);
alter table public.participation_visibility enable row level security;
revoke all on public.participation_visibility from public,anon,authenticated;
grant all on public.participation_visibility to service_role;
grant select on public.participation_visibility to authenticated;
create policy participation_visibility_own on public.participation_visibility for select to authenticated using(
 public.is_feature_enabled('participation_history') and public.is_verified() and user_id=auth.uid());

create function public.set_participation_visibility(p_show boolean) returns jsonb language plpgsql security definer set search_path=public as $$begin
 if not is_feature_enabled('participation_history') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 insert into participation_visibility(user_id,show_in_directory,updated_at) values(auth.uid(),coalesce(p_show,false),now())
 on conflict(user_id) do update set show_in_directory=excluded.show_in_directory,updated_at=now();
 return jsonb_build_object('show_in_directory',coalesce(p_show,false));
end$$;

-- Caller's own timeline, newest first. kind: event_registration | meetup_registration | space | talk_proposal | hosted_event | feedback.
create function public.my_participation(p_limit int default 50,p_offset int default 0)
returns table(kind text,item_id uuid,title text,occurred_at timestamptz,status text,checked_in boolean)
language plpgsql stable security definer set search_path=public as $$
declare me uuid:=auth.uid();
begin
 if not is_feature_enabled('participation_history') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return query select * from(
  select 'event_registration'::text k,e.id i,e.title t,e.starts_at o,r.status s,(r.checked_in_at is not null) c
   from event_registrations r join public_events e on e.id=r.event_id where r.user_id=me
  union all
  select 'meetup_registration',m.id,m.title,(m.session_date::timestamp at time zone 'Asia/Taipei'),'registered',coalesce(g.checked_in,false)
   from registrations g join meetup_sessions m on m.id=g.session_id where g.user_id=me
  union all
  select 'space',s.id,s.title,s.created_at,s.visibility,false from spaces s where s.owner_id=me
  union all
  select 'talk_proposal',tp.id,tp.title,tp.created_at,tp.status,false from talk_proposals tp where tp.proposer_id=me and is_feature_enabled('talk_proposals')
  union all
  select 'hosted_event',h.id,h.title,h.starts_at,h.status,false from hosted_event_requests h where h.host_id=me and is_feature_enabled('member_hosted_events')
  union all
  select 'feedback',e.id,e.title,fr.created_at,'submitted',false
   from event_feedback_responses fr join event_feedback_forms f on f.id=fr.form_id join public_events e on e.id=f.event_id
   where fr.respondent_id=me and is_feature_enabled('event_feedback')
 ) x(k,i,t,o,s,c) order by o desc,i
 limit least(greatest(coalesce(p_limit,50),1),200) offset greatest(coalesce(p_offset,0),0);
end$$;

create function public.my_participation_summary() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare me uuid:=auth.uid();
begin
 if not is_feature_enabled('participation_history') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return jsonb_build_object(
  'events_registered',(select count(*) from event_registrations where user_id=me and status='registered')+(select count(*) from registrations where user_id=me),
  'events_attended',(select count(*) from event_registrations where user_id=me and status='registered' and checked_in_at is not null)+(select count(*) from registrations where user_id=me and checked_in),
  'events_waitlisted',(select count(*) from event_registrations where user_id=me and status='waitlisted'),
  'spaces',(select count(*) from spaces where owner_id=me),
  'talk_proposals',case when is_feature_enabled('talk_proposals') then (select count(*) from talk_proposals where proposer_id=me) else 0 end,
  'talks_scheduled',case when is_feature_enabled('talk_proposals') then (select count(*) from talk_proposals where proposer_id=me and status='scheduled') else 0 end,
  'hosted_events',case when is_feature_enabled('member_hosted_events') then (select count(*) from hosted_event_requests where host_id=me) else 0 end,
  'feedback_submitted',case when is_feature_enabled('event_feedback') then (select count(*) from event_feedback_responses where respondent_id=me) else 0 end,
  'polls_voted',case when is_feature_enabled('polls') then (select count(distinct poll_id) from poll_votes where voter_id=me) else 0 end,
  'threads',(select count(*) from discussion_threads where author_id=me),
  'replies',(select count(*) from discussion_replies where author_id=me),
  'show_in_directory',coalesce((select show_in_directory from participation_visibility where user_id=me),false));
end$$;

-- Aggregate counts only (never event-level data). Returns null unless the target opted in AND is listed in the directory,
-- both flags are on, the target is a verified member, and neither side has blocked the other.
create function public.member_participation_summary(p_user uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
 if not is_feature_enabled('participation_history') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not is_feature_enabled('member_directory') or p_user is null then return null;end if;
 if p_user<>auth.uid() and directory_blocked(p_user) then return null;end if;
 if not exists(select 1 from participation_visibility v join member_directory_profiles d on d.user_id=v.user_id join profiles p on p.id=v.user_id
  where v.user_id=p_user and v.show_in_directory and d.listed and p.passcode_verified) then return null;end if;
 return jsonb_build_object(
  'events_attended',(select count(*) from event_registrations where user_id=p_user and status='registered' and checked_in_at is not null)+(select count(*) from registrations where user_id=p_user and checked_in),
  'talks_given',(select count(*) from talk_proposals where proposer_id=p_user and status='scheduled' and is_feature_enabled('talk_proposals'))
   +(select count(*) from spaces s where s.owner_id=p_user and s.visibility='public' and not content_hidden_for('space',s.id,auth.uid())),
  'threads_started',(select count(*) from discussion_threads t join spaces s on s.id=t.space_id where t.author_id=p_user and not t.is_hidden and s.visibility='public'
   and not content_hidden_for('thread',t.id,auth.uid())));
end$$;

revoke all on function public.set_participation_visibility(boolean),public.my_participation(int,int),public.my_participation_summary(),public.member_participation_summary(uuid) from public,anon,authenticated;
grant execute on function public.set_participation_visibility(boolean),public.my_participation(int,int),public.my_participation_summary(),public.member_participation_summary(uuid) to authenticated,service_role;
commit;
