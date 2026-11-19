begin;
-- F6 forum_plus: @mentions, helpful votes, accepted answer, follow threads, featured threads.
-- Incremental: runs after 001-018. Flag key: forum_plus. Existing views/outputs are untouched;
-- new data is read through flag-gated RPCs so 018's moderation hide conditions stay intact.
alter table public.discussion_threads add column is_featured boolean not null default false;
alter table public.discussion_threads add column accepted_reply_id uuid references public.discussion_replies(id) on delete set null;

create table public.discussion_mentions (
 source_type text not null check(source_type in ('thread','reply')),source_id uuid not null,
 mentioned_user uuid not null references public.profiles(id) on delete cascade,created_at timestamptz not null default now(),
 primary key(source_type,source_id,mentioned_user)
);
create index discussion_mentions_user on public.discussion_mentions(mentioned_user,created_at desc);
create table public.discussion_reactions (
 target_type text not null check(target_type in ('thread','reply')),target_id uuid not null,
 user_id uuid not null references public.profiles(id) on delete cascade,created_at timestamptz not null default now(),
 primary key(target_type,target_id,user_id)
);
create table public.discussion_follows (
 thread_id uuid not null references public.discussion_threads(id) on delete cascade,
 user_id uuid not null references public.profiles(id) on delete cascade,created_at timestamptz not null default now(),
 primary key(thread_id,user_id)
);
create index discussion_follows_user on public.discussion_follows(user_id);
alter table public.discussion_mentions enable row level security;
alter table public.discussion_reactions enable row level security;
alter table public.discussion_follows enable row level security;
revoke all on public.discussion_mentions,public.discussion_reactions,public.discussion_follows from public,anon,authenticated;
grant select on public.discussion_mentions,public.discussion_reactions,public.discussion_follows to authenticated;
grant all on public.discussion_mentions,public.discussion_reactions,public.discussion_follows to service_role;
create policy mentions_own on public.discussion_mentions for select to authenticated using(public.is_verified() and public.is_feature_enabled('forum_plus') and mentioned_user=auth.uid());
create policy reactions_read on public.discussion_reactions for select to authenticated using(public.is_verified() and public.is_feature_enabled('forum_plus'));
create policy follows_own on public.discussion_follows for select to authenticated using(public.is_verified() and public.is_feature_enabled('forum_plus') and user_id=auth.uid());

create function public.forum_blocked(p_a uuid,p_b uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from contact_blocks where (owner_id=p_a and blocked_user_id=p_b) or (owner_id=p_b and blocked_user_id=p_a))
$$;
create function public.forum_thread_link(p_thread uuid) returns text language sql stable security definer set search_path=public as $$
 select '#project/'||space_id||'/thread/'||id from discussion_threads where id=p_thread
$$;

-- Resolve @<display_name> against verified members. Ambiguous (duplicate names) or unknown names are ignored,
-- and the most specific (longest) name wins. Returns the users that were recorded and notified.
create function public.forum_plus_process_mentions(p_type text,p_source uuid,p_author uuid,p_text text,p_thread uuid) returns uuid[] language plpgsql security definer set search_path=public as $$declare r record;res uuid[]:='{}';ins integer;begin
 if p_text is null or strpos(p_text,'@')=0 then return res;end if;
 for r in select p.id from profiles p where p.passcode_verified and p.display_name<>'' and strpos(p_text,'@'||p.display_name)>0
   and (select count(*) from profiles q where q.passcode_verified and q.display_name=p.display_name)=1
   and not exists(select 1 from profiles o where o.passcode_verified and length(o.display_name)>length(p.display_name) and left(o.display_name,length(p.display_name))=p.display_name and strpos(p_text,'@'||o.display_name)>0)
 loop
  if r.id=p_author or forum_blocked(r.id,p_author) or not content_visible_to(p_type,p_source,r.id) then continue;end if;
  insert into discussion_mentions(source_type,source_id,mentioned_user) values(p_type,p_source,r.id) on conflict do nothing;
  get diagnostics ins=row_count;
  if ins>0 then
   res:=res||r.id;
   perform notify(r.id,'forum_mention','有人在討論中提到你',(select display_name from profiles where id=p_author),forum_thread_link(p_thread),jsonb_build_object('thread_id',p_thread,'source_type',p_type,'source_id',p_source));
  end if;
 end loop;
 return res;
end$$;
create function public.forum_plus_thread_created() returns trigger language plpgsql security definer set search_path=public as $$begin
 if not is_feature_enabled('forum_plus') then return new;end if;
 insert into discussion_follows(thread_id,user_id) values(new.id,new.author_id) on conflict do nothing;
 if not new.is_hidden then perform forum_plus_process_mentions('thread',new.id,new.author_id,new.title||' '||new.body,new.id);end if;
 return new;
end$$;
create trigger forum_plus_thread_created after insert on public.discussion_threads for each row execute function public.forum_plus_thread_created();
create function public.forum_plus_reply_created() returns trigger language plpgsql security definer set search_path=public as $$declare t discussion_threads;mentioned uuid[];f record;begin
 if not is_feature_enabled('forum_plus') or new.is_hidden then return new;end if;
 select * into t from discussion_threads where id=new.thread_id;
 if not found then return new;end if;
 mentioned=forum_plus_process_mentions('reply',new.id,new.author_id,new.body,new.thread_id);
 -- followers, except the replier, the thread author (F1 discussion_reply covers them) and users already notified by a mention
 for f in select user_id from discussion_follows where thread_id=new.thread_id and user_id<>new.author_id and user_id<>t.author_id and not (user_id=any(mentioned)) loop
  if forum_blocked(f.user_id,new.author_id) or not content_visible_to('reply',new.id,f.user_id) then continue;end if;
  perform notify(f.user_id,'forum_followed_reply','你追蹤的討論有新回覆',(select display_name from profiles where id=new.author_id),forum_thread_link(new.thread_id),jsonb_build_object('thread_id',new.thread_id,'reply_id',new.id));
 end loop;
 return new;
end$$;
create trigger forum_plus_reply_created after insert on public.discussion_replies for each row execute function public.forum_plus_reply_created();

create function public.forum_plus_guard() returns void language plpgsql stable security definer set search_path=public as $$begin
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not is_feature_enabled('forum_plus') then raise exception 'FEATURE_DISABLED';end if;
end$$;
create function public.mention_suggestions(p_prefix text) returns table(display_name text,department text) language plpgsql stable security definer set search_path=public as $$begin
 perform forum_plus_guard();
 return query select p.display_name,p.department from profiles p where p.passcode_verified and p.id<>auth.uid() and length(coalesce(p_prefix,''))>0
  and p.display_name ilike replace(replace(replace(left(p_prefix,40),'\','\\'),'%','\%'),'_','\_')||'%' order by p.display_name limit 8;
end$$;
create function public.toggle_helpful(p_type text,p_id uuid) returns integer language plpgsql security definer set search_path=public as $$declare n integer;del integer;begin
 perform forum_plus_guard();
 if p_type not in ('thread','reply') then raise exception 'INVALID_TARGET';end if;
 if not content_visible_to(p_type,p_id,auth.uid()) then raise exception 'NOT_FOUND';end if;
 delete from discussion_reactions where target_type=p_type and target_id=p_id and user_id=auth.uid();
 get diagnostics del=row_count;
 if del=0 then insert into discussion_reactions(target_type,target_id,user_id) values(p_type,p_id,auth.uid());end if;
 select count(*) into n from discussion_reactions where target_type=p_type and target_id=p_id;
 return n;
end$$;
create function public.toggle_follow_thread(p_thread uuid) returns boolean language plpgsql security definer set search_path=public as $$declare del integer;begin
 perform forum_plus_guard();
 if not content_visible_to('thread',p_thread,auth.uid()) then raise exception 'NOT_FOUND';end if;
 delete from discussion_follows where thread_id=p_thread and user_id=auth.uid();
 get diagnostics del=row_count;
 if del>0 then return false;end if;
 insert into discussion_follows(thread_id,user_id) values(p_thread,auth.uid());return true;
end$$;
create function public.set_accepted_reply(p_thread uuid,p_reply uuid) returns uuid language plpgsql security definer set search_path=public as $$declare t discussion_threads;ra uuid;begin
 perform forum_plus_guard();
 select * into t from discussion_threads where id=p_thread;
 if not found then raise exception 'NOT_FOUND';end if;
 if t.author_id<>auth.uid() and not is_admin() then raise exception 'FORBIDDEN';end if;
 if p_reply is null then update discussion_threads set accepted_reply_id=null where id=p_thread;return null;end if;
 select author_id into ra from discussion_replies where id=p_reply and thread_id=p_thread and not is_hidden;
 if not found then raise exception 'INVALID_REPLY';end if;
 if t.accepted_reply_id is distinct from p_reply then
  update discussion_threads set accepted_reply_id=p_reply,is_resolved=true where id=p_thread;
  if ra<>auth.uid() and not forum_blocked(ra,auth.uid()) then
   perform notify(ra,'forum_accepted','你的回覆被選為最佳解答',t.title,forum_thread_link(p_thread),jsonb_build_object('thread_id',p_thread,'reply_id',p_reply));
  end if;
 end if;
 return p_reply;
end$$;
create function public.set_thread_flags(p_thread uuid,p_pinned boolean,p_featured boolean) returns void language plpgsql security definer set search_path=public as $$begin
 perform forum_plus_guard();
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 update discussion_threads set is_pinned=coalesce(p_pinned,is_pinned),is_featured=coalesce(p_featured,is_featured) where id=p_thread;
 if not found then raise exception 'NOT_FOUND';end if;
end$$;
-- Read helpers for the UI (visibility/moderation aware; the *_read views are left as-is).
create function public.forum_plus_threads(p_ids uuid[]) returns table(id uuid,is_pinned boolean,is_featured boolean,accepted_reply_id uuid,helpful_count integer,helpful_mine boolean,following boolean) language plpgsql stable security definer set search_path=public as $$begin
 perform forum_plus_guard();
 return query select t.id,t.is_pinned,t.is_featured,t.accepted_reply_id,
  (select count(*)::integer from discussion_reactions x where x.target_type='thread' and x.target_id=t.id),
  exists(select 1 from discussion_reactions x where x.target_type='thread' and x.target_id=t.id and x.user_id=auth.uid()),
  exists(select 1 from discussion_follows f where f.thread_id=t.id and f.user_id=auth.uid())
  from discussion_threads t where t.id=any(p_ids) and content_visible_to('thread',t.id,auth.uid());
end$$;
create function public.forum_plus_replies(p_ids uuid[]) returns table(id uuid,helpful_count integer,helpful_mine boolean) language plpgsql stable security definer set search_path=public as $$begin
 perform forum_plus_guard();
 return query select r.id,
  (select count(*)::integer from discussion_reactions x where x.target_type='reply' and x.target_id=r.id),
  exists(select 1 from discussion_reactions x where x.target_type='reply' and x.target_id=r.id and x.user_id=auth.uid())
  from discussion_replies r where r.id=any(p_ids) and content_visible_to('reply',r.id,auth.uid());
end$$;
revoke all on function public.forum_blocked(uuid,uuid),public.forum_thread_link(uuid),public.forum_plus_process_mentions(text,uuid,uuid,text,uuid),public.forum_plus_thread_created(),public.forum_plus_reply_created(),public.forum_plus_guard(),
 public.mention_suggestions(text),public.toggle_helpful(text,uuid),public.toggle_follow_thread(uuid),public.set_accepted_reply(uuid,uuid),public.set_thread_flags(uuid,boolean,boolean),public.forum_plus_threads(uuid[]),public.forum_plus_replies(uuid[]) from public,anon,authenticated;
grant execute on function public.mention_suggestions(text),public.toggle_helpful(text,uuid),public.toggle_follow_thread(uuid),public.set_accepted_reply(uuid,uuid),public.set_thread_flags(uuid,boolean,boolean),public.forum_plus_threads(uuid[]),public.forum_plus_replies(uuid[]) to authenticated,service_role;
commit;
