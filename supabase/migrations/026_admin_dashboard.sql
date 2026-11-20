begin;
-- F13 admin_dashboard: admin-only aggregate RPCs. Aggregates only; no individual-level data, titles only for content.
-- Incremental: run after 013-023. Flag off => every RPC raises FEATURE_DISABLED. Stores nothing.

-- event_registrations had no creation time; needed to count registrations per period. Backfill from updated_at.
alter table public.event_registrations add column if not exists created_at timestamptz;
update public.event_registrations set created_at=updated_at where created_at is null;
alter table public.event_registrations alter column created_at set default now();
alter table public.event_registrations alter column created_at set not null;

-- Indexes that serve the date-range aggregates only.
create index if not exists event_registrations_created on public.event_registrations(created_at);
create index if not exists event_registrations_checked_in on public.event_registrations(checked_in_at) where checked_in_at is not null;
create index if not exists profiles_created on public.profiles(created_at);
create index if not exists discussion_threads_created on public.discussion_threads(created_at);
create index if not exists discussion_replies_created on public.discussion_replies(created_at);
create index if not exists pain_points_created on public.pain_points(created_at);
create index if not exists user_votes_type_created on public.user_votes(target_type,created_at);
create index if not exists vibe_events_created on public.vibe_events(created_at);
create index if not exists notifications_created on public.notifications(created_at);
create index if not exists poll_votes_created on public.poll_votes(created_at);

-- Internal visibility helpers: public + not hidden (is_hidden column or 018 moderation, regardless of the content_reports flag).
create function public.dash_space_ok(p_id uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from spaces s where s.id=p_id and s.visibility='public'
  and not exists(select 1 from content_moderation m where m.target_type='space' and m.target_id=s.id and m.hidden))
$$;
create function public.dash_thread_ok(p_id uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from discussion_threads t where t.id=p_id and not t.is_hidden
  and not exists(select 1 from content_moderation m where m.target_type='thread' and m.target_id=t.id and m.hidden)
  and public.dash_space_ok(t.space_id))
$$;
create function public.dash_reply_ok(p_id uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from discussion_replies r where r.id=p_id and not r.is_hidden
  and not exists(select 1 from content_moderation m where m.target_type='reply' and m.target_id=r.id and m.hidden)
  and public.dash_thread_ok(r.thread_id))
$$;
create function public.dash_pain_ok(p_id uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from pain_points p where p.id=p_id
  and not exists(select 1 from content_moderation m where m.target_type='pain_point' and m.target_id=p.id and m.hidden))
$$;
-- Shared guard: flag, admin, range (max 2 years). Returns [lo,hi) as timestamptz in Asia/Taipei.
create function public.dash_guard(p_from date,p_to date) returns timestamptz[] language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('admin_dashboard') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>730 then raise exception 'INVALID_RANGE';end if;
 return array[p_from::timestamp at time zone 'Asia/Taipei',(p_to+1)::timestamp at time zone 'Asia/Taipei'];
end$$;

create function public.dashboard_overview(p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path=public as $$declare
 g timestamptz[]:=dash_guard(p_from,p_to);lo timestamptz:=g[1];hi timestamptz:=g[2];r jsonb;n integer;m integer;avg_r numeric;begin
 r:=jsonb_build_object('from',p_from,'to',p_to,
  'verified_members',(select count(*) from profiles where passcode_verified and created_at<hi),
  'new_members',(select count(*) from profiles where passcode_verified and created_at>=lo and created_at<hi),
  'events_held',(select count(*) from public_events where is_published and status='scheduled' and ends_at>=lo and ends_at<hi and ends_at<=now()),
  'registrations_member',(select count(*) from event_registrations where status='registered' and user_id is not null and created_at>=lo and created_at<hi),
  'registrations_guest',(select count(*) from event_registrations where status='registered' and user_id is null and created_at>=lo and created_at<hi));
 select count(*),count(*) filter(where er.checked_in_at is not null) into n,m from event_registrations er join public_events e on e.id=er.event_id
  where er.status='registered' and e.is_published and e.status='scheduled' and e.ends_at>=lo and e.ends_at<hi and e.ends_at<=now();
 r:=r||jsonb_build_object('held_registrations',n,'checked_in',m,'checkin_rate',case when n>0 then round(m::numeric/n,4) end,
  'public_spaces_created',(select count(*) from spaces s where s.visibility='public' and s.created_at>=lo and s.created_at<hi and dash_space_ok(s.id)),
  'threads',(select count(*) from discussion_threads t where t.created_at>=lo and t.created_at<hi and dash_thread_ok(t.id)),
  'replies',(select count(*) from discussion_replies d where d.created_at>=lo and d.created_at<hi and dash_reply_ok(d.id)),
  'pain_points',(select count(*) from pain_points p where p.created_at>=lo and p.created_at<hi and dash_pain_ok(p.id)),
  'pain_point_votes',(select count(*) from user_votes v where v.target_type='pain_point' and v.created_at>=lo and v.created_at<hi and dash_pain_ok(v.target_id)));
 r:=r||jsonb_build_object('waitlisted',case when is_feature_enabled('event_waitlist') then (select count(*) from event_registrations where status='waitlisted' and waitlisted_at>=lo and waitlisted_at<hi) end);
 r:=r||jsonb_build_object('polls',case when is_feature_enabled('polls') then jsonb_build_object(
   'created',(select count(*) from polls where created_at>=lo and created_at<hi),
   'votes',(select count(*) from poll_votes where created_at>=lo and created_at<hi)) end);
 if is_feature_enabled('event_feedback') then
  select count(*),round(avg(val),2) into n,avg_r from (
   select (a.answers->>(q->>'id'))::numeric val from event_feedback_responses a join event_feedback_forms f on f.id=a.form_id
   cross join lateral jsonb_array_elements(f.questions) q
   where a.created_at>=lo and a.created_at<hi and q->>'type'='rating' and (a.answers->>(q->>'id')) ~ '^[1-5]$') s;
  r:=r||jsonb_build_object('feedback',jsonb_build_object(
   'forms_published',(select count(*) from event_feedback_forms where published_at>=lo and published_at<hi),
   'responses',(select count(*) from event_feedback_responses where created_at>=lo and created_at<hi),
   'rating_count',n,'average_rating',avg_r));
 else r:=r||jsonb_build_object('feedback',null);end if;
 r:=r||jsonb_build_object('notifications',case when is_feature_enabled('notifications') then (select jsonb_build_object('sent',count(*),'read',count(*) filter(where read_at is not null),
   'read_rate',case when count(*)>0 then round(count(*) filter(where read_at is not null)::numeric/count(*),4) end) from notifications where created_at>=lo and created_at<hi) end);
 r:=r||jsonb_build_object('reports',case when is_feature_enabled('content_reports') then jsonb_build_object(
   'opened',(select count(*) from content_reports where created_at>=lo and created_at<hi),
   'handled',(select count(*) from content_reports where handled_at>=lo and handled_at<hi)) end);
 r:=r||jsonb_build_object('talk_proposals',case when is_feature_enabled('talk_proposals') then
   (select coalesce(jsonb_object_agg(status,c),'{}') from (select status,count(*) c from talk_proposals where created_at>=lo and created_at<hi group by status) s) end);
 r:=r||jsonb_build_object('hosted_event_requests',case when is_feature_enabled('member_hosted_events') then
   (select coalesce(jsonb_object_agg(status,c),'{}') from (select status,count(*) c from hosted_event_requests where created_at>=lo and created_at<hi group by status) s) end);
 return r;
end$$;

-- Departments with fewer than 5 verified members are merged into one 「其他（人數少於 5）」 row.
create function public.dashboard_department_participation(p_from date,p_to date) returns jsonb language plpgsql stable security definer set search_path=public as $$declare
 g timestamptz[]:=dash_guard(p_from,p_to);lo timestamptz:=g[1];hi timestamptz:=g[2];begin
 return coalesce((select jsonb_agg(jsonb_build_object('department',d,'members',members,'registrations',regs,'checkins',cks,'spaces',sp,'threads',th) order by small,members desc,d) from (
  select case when members>=5 then dept else '其他（人數少於 5）' end d,(members<5) small,
   sum(members)::int members,sum(regs)::int regs,sum(cks)::int cks,sum(sp)::int sp,sum(th)::int th
  from (select coalesce(nullif(btrim(p.department),''),'未填寫') dept,count(*) members,
    sum((select count(*) from event_registrations er where er.user_id=p.id and er.status='registered' and er.created_at>=lo and er.created_at<hi)) regs,
    sum((select count(*) from event_registrations er where er.user_id=p.id and er.status='registered' and er.checked_in_at>=lo and er.checked_in_at<hi)) cks,
    sum((select count(*) from spaces s where s.owner_id=p.id and s.created_at>=lo and s.created_at<hi and dash_space_ok(s.id))) sp,
    sum((select count(*) from discussion_threads t where t.author_id=p.id and t.created_at>=lo and t.created_at<hi and dash_thread_ok(t.id))) th
   from profiles p where p.passcode_verified and p.created_at<hi group by 1) a
  group by 1,2) b),'[]');
end$$;

-- Titles only; hidden/private content excluded. Scores count activity inside the range.
create function public.dashboard_top_content(p_from date,p_to date,p_limit integer default 10) returns jsonb language plpgsql stable security definer set search_path=public as $$declare
 g timestamptz[]:=dash_guard(p_from,p_to);lo timestamptz:=g[1];hi timestamptz:=g[2];lim integer:=least(greatest(coalesce(p_limit,10),1),50);begin
 return jsonb_build_object(
  'spaces',coalesce((select jsonb_agg(jsonb_build_object('title',title,'votes',votes,'vibes',vibes) order by votes+vibes desc,title) from (
    select s.title,(select count(*) from user_votes v where v.target_type='space' and v.target_id=s.id and v.created_at>=lo and v.created_at<hi)::int votes,
     (select count(*) from vibe_events e where e.space_id=s.id and e.created_at>=lo and e.created_at<hi)::int vibes
    from spaces s where dash_space_ok(s.id)) x where votes+vibes>0 limit lim),'[]'),
  'pain_points',coalesce((select jsonb_agg(jsonb_build_object('title',title,'votes',votes) order by votes desc,title) from (
    select p.title,(select count(*) from user_votes v where v.target_type='pain_point' and v.target_id=p.id and v.created_at>=lo and v.created_at<hi)::int votes
    from pain_points p where dash_pain_ok(p.id)) x where votes>0 limit lim),'[]'),
  'threads',coalesce((select jsonb_agg(jsonb_build_object('title',title,'replies',replies) order by replies desc,title) from (
    select t.title,(select count(*) from discussion_replies d where d.thread_id=t.id and d.created_at>=lo and d.created_at<hi and dash_reply_ok(d.id))::int replies
    from discussion_threads t where dash_thread_ok(t.id)) x where replies>0 limit lim),'[]'));
end$$;

create function public.dashboard_timeseries(p_metric text,p_from date,p_to date,p_bucket text default 'week') returns jsonb language plpgsql stable security definer set search_path=public as $$declare
 g timestamptz[]:=dash_guard(p_from,p_to);lo timestamptz:=g[1];hi timestamptz:=g[2];res jsonb;begin
 if p_metric is null or p_metric not in ('registrations','checkins','threads','members') then raise exception 'INVALID_METRIC';end if;
 if p_bucket is null or p_bucket not in ('week','month') then raise exception 'INVALID_BUCKET';end if;
 with ev as (
  select case p_metric
   when 'registrations' then (select array_agg(created_at) from event_registrations where status='registered' and created_at>=lo and created_at<hi)
   when 'checkins' then (select array_agg(checked_in_at) from event_registrations where status='registered' and checked_in_at>=lo and checked_in_at<hi)
   when 'members' then (select array_agg(created_at) from profiles where passcode_verified and created_at>=lo and created_at<hi)
   else (select array_agg(t.created_at) from discussion_threads t where t.created_at>=lo and t.created_at<hi and dash_thread_ok(t.id)) end ts),
 b as (select generate_series(date_trunc(p_bucket,p_from::timestamp),date_trunc(p_bucket,p_to::timestamp),('1 '||p_bucket)::interval)::date d),
 c as (select date_trunc(p_bucket,x at time zone 'Asia/Taipei')::date d,count(*) n from ev,unnest(ev.ts) x group by 1)
 select jsonb_agg(jsonb_build_object('bucket',b.d,'value',coalesce(c.n,0)) order by b.d) into res from b left join c using(d);
 return jsonb_build_object('metric',p_metric,'bucket',p_bucket,'points',coalesce(res,'[]'));
end$$;

revoke all on function public.dash_space_ok(uuid),public.dash_thread_ok(uuid),public.dash_reply_ok(uuid),public.dash_pain_ok(uuid),public.dash_guard(date,date) from public,anon,authenticated;
revoke all on function public.dashboard_overview(date,date),public.dashboard_department_participation(date,date),public.dashboard_top_content(date,date,integer),public.dashboard_timeseries(text,date,date,text) from public,anon,authenticated;
grant execute on function public.dashboard_overview(date,date),public.dashboard_department_participation(date,date),public.dashboard_top_content(date,date,integer),public.dashboard_timeseries(text,date,date,text) to authenticated;
commit;
