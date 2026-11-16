-- Apply after 001, including to existing deployments. No content is deleted.
begin;
revoke select on public.spaces, public.space_slides, public.space_qa,
  public.qa_public, public.pain_points, public.meetup_sessions,
  public.announcements from anon;

drop policy if exists space_read on public.spaces;
create policy space_read on public.spaces for select to authenticated
using (public.is_verified() and (visibility = 'public' or owner_id = auth.uid()));

drop policy if exists sessions_read on public.meetup_sessions;
create policy sessions_read on public.meetup_sessions for select to authenticated
using (public.is_verified());

drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select to authenticated
using (public.is_verified());

drop policy if exists pain_read on public.pain_points;
create policy pain_read on public.pain_points for select to authenticated
using (public.is_verified());

-- Preserve anonymous author masking; the view owner bypasses underlying RLS,
-- so explicitly require a verified caller, or the trusted API's service role.
create or replace view public.qa_public as
select q.id, q.space_id, q.question_text, q.is_anonymous,
  case when q.is_anonymous then '匿名同仁' else p.display_name end as author_name,
  q.speaker_reply, q.is_resolved, q.upvotes, q.created_at
from public.space_qa q
join public.profiles p on p.id = q.author_id
join public.spaces s on s.id = q.space_id
where s.visibility = 'public'
  and (public.is_verified() or current_user = 'service_role');
revoke all on public.qa_public from anon;
grant select on public.qa_public to authenticated, service_role;
commit;
