begin;
alter table public.spaces add column cover_image text;
alter table public.spaces add column has_cover boolean generated always as (cover_image is not null) stored;
alter table public.spaces add constraint cover_image_size check (cover_image is null or (length(cover_image) <= 220000 and cover_image ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'));
create table public.discussion_threads (
 id uuid primary key default gen_random_uuid(), space_id uuid not null references public.spaces on delete cascade,
 author_id uuid not null references public.profiles, title text not null check(length(title) between 1 and 160),
 body text not null check(length(body) between 1 and 6000), kind text not null default 'question' check(kind in ('question','experience','resource')),
 is_pinned boolean not null default false, is_resolved boolean not null default false, is_hidden boolean not null default false,
 reply_count integer not null default 0, created_at timestamptz not null default now(), last_activity_at timestamptz not null default now()
);
create table public.discussion_replies (
 id uuid primary key default gen_random_uuid(), thread_id uuid not null references public.discussion_threads on delete cascade,
 author_id uuid not null references public.profiles, body text not null check(length(body) between 1 and 6000),
 is_hidden boolean not null default false, created_at timestamptz not null default now()
);
create index discussion_threads_space on public.discussion_threads(space_id,is_hidden,is_pinned desc,last_activity_at desc,id);
create index discussion_replies_thread on public.discussion_replies(thread_id,is_hidden,created_at,id);
alter table public.discussion_threads enable row level security;
alter table public.discussion_replies enable row level security;
revoke all on public.discussion_threads,public.discussion_replies from public,anon,authenticated;
grant select on public.discussion_threads,public.discussion_replies to authenticated;
create policy thread_read on public.discussion_threads for select to authenticated using (
 public.is_verified() and not is_hidden and exists(select 1 from public.spaces s where s.id=space_id and (s.visibility='public' or s.owner_id=auth.uid()))
);
create policy reply_read on public.discussion_replies for select to authenticated using (
 public.is_verified() and not is_hidden and exists(select 1 from public.discussion_threads t where t.id=thread_id)
);
-- Views expose names without opening the profiles table. Explicit caller checks
-- preserve private-space isolation even though the view owner can bypass RLS.
create view public.discussion_threads_read as
 select t.*,p.display_name as author_name from public.discussion_threads t join public.profiles p on p.id=t.author_id join public.spaces s on s.id=t.space_id
 where not t.is_hidden and (current_user='service_role' or (public.is_verified() and (s.visibility='public' or s.owner_id=auth.uid())));
create view public.discussion_replies_read as
 select r.*,p.display_name as author_name from public.discussion_replies r join public.profiles p on p.id=r.author_id join public.discussion_threads t on t.id=r.thread_id join public.spaces s on s.id=t.space_id
 where not r.is_hidden and not t.is_hidden and (current_user='service_role' or (public.is_verified() and (s.visibility='public' or s.owner_id=auth.uid())));
revoke all on public.discussion_threads_read,public.discussion_replies_read from public,anon;
grant select on public.discussion_threads_read,public.discussion_replies_read to authenticated,service_role;

create function public.refresh_thread_activity() returns trigger language plpgsql security definer set search_path=public as $$declare target uuid;begin
 target=case when tg_op='DELETE' then old.thread_id else new.thread_id end;
 -- Serialize reply mutations on the parent row; a fresh statement snapshot then
 -- recomputes counts correctly even for concurrent replies/moderation.
 perform 1 from discussion_threads where id=target for update;
 update discussion_threads t set reply_count=(select count(*) from discussion_replies r where r.thread_id=target and not r.is_hidden),last_activity_at=greatest(t.created_at,coalesce((select max(created_at) from discussion_replies r where r.thread_id=target and not r.is_hidden),t.created_at)) where t.id=target;
 return null;end$$;
create trigger update_thread_activity after insert or update or delete on public.discussion_replies for each row execute function public.refresh_thread_activity();

-- Extend the existing transactional save RPC; owner, schedule and visibility
-- semantics are unchanged. Missing cover_image in old clients retains the cover.
create or replace function public.save_space(p_id uuid,p_owner uuid,p_fields jsonb,p_html text,p_count integer) returns uuid language plpgsql security definer set search_path=public as $$declare result uuid;begin
 if not exists(select 1 from profiles where id=p_owner and passcode_verified) then raise exception 'PASSCODE_REQUIRED';end if;
 if p_id is null then insert into spaces(owner_id,title,summary,category_tag,visibility,highlights,reference_links,slide_count,cover_image) values(p_owner,p_fields->>'title',p_fields->>'summary',p_fields->>'category_tag',p_fields->>'visibility',p_fields->'highlights',p_fields->'reference_links',coalesce(p_count,0),p_fields->>'cover_image') returning id into result;
 else update spaces set title=p_fields->>'title',summary=p_fields->>'summary',category_tag=p_fields->>'category_tag',visibility=p_fields->>'visibility',highlights=p_fields->'highlights',reference_links=p_fields->'reference_links',slide_count=coalesce(p_count,slide_count),cover_image=case when p_fields?'cover_image' then p_fields->>'cover_image' else cover_image end,updated_at=now() where id=p_id and owner_id=p_owner returning id into result;if result is null then raise exception 'SPACE_NOT_FOUND';end if;end if;
 if p_html is not null then insert into space_slides values(result,p_html) on conflict(space_id) do update set html_slides=excluded.html_slides;end if;return result;end$$;
commit;
