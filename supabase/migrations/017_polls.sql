begin;
-- F4 polls (flag: polls). Incremental, after 001-013. All writes go through security definer RPCs.
create table public.poll_settings (
 id boolean primary key default true check(id),members_can_create boolean not null default false,
 updated_by uuid references public.profiles(id),updated_at timestamptz not null default now()
);
insert into public.poll_settings(id) values(true) on conflict do nothing;
create table public.polls (
 id uuid primary key default gen_random_uuid(),creator_id uuid not null references public.profiles(id) on delete cascade,
 title text not null check(length(title) between 1 and 120),description text not null default '' check(length(description)<=1000),
 kind text not null check(kind in ('single','multiple')),max_choices integer not null default 1 check(max_choices>=1),
 is_anonymous boolean not null default false,
 show_results text not null default 'always' check(show_results in ('always','after_vote','after_close')),
 closes_at timestamptz,attached_type text check(attached_type in ('announcement','event','thread')),attached_id uuid,
 status text not null default 'open' check(status in ('open','closed')),created_at timestamptz not null default now(),
 check(kind<>'single' or max_choices=1),check((attached_type is null)=(attached_id is null))
);
create index polls_attached on public.polls(attached_type,attached_id) where attached_id is not null;
create index polls_created on public.polls(created_at desc);
create table public.poll_options (
 id uuid primary key default gen_random_uuid(),poll_id uuid not null references public.polls(id) on delete cascade,
 label text not null check(length(label) between 1 and 100),position integer not null check(position between 0 and 9),
 unique(poll_id,position),unique(id,poll_id)
);
create table public.poll_votes (
 poll_id uuid not null,option_id uuid not null,voter_id uuid not null references public.profiles(id) on delete cascade,
 created_at timestamptz not null default now(),primary key(poll_id,option_id,voter_id),
 foreign key(option_id,poll_id) references public.poll_options(id,poll_id) on delete cascade
);
create index poll_votes_voter on public.poll_votes(voter_id,poll_id);
alter table public.poll_settings enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
revoke all on public.poll_settings,public.polls,public.poll_options,public.poll_votes from public,anon,authenticated;
grant select on public.poll_settings,public.polls,public.poll_options,public.poll_votes to authenticated;
create policy poll_settings_read on public.poll_settings for select to authenticated using(public.is_feature_enabled('polls') and public.is_verified());
create policy polls_read on public.polls for select to authenticated using(public.is_feature_enabled('polls') and public.is_verified());
create policy poll_options_read on public.poll_options for select to authenticated using(public.is_feature_enabled('polls') and public.is_verified());
-- A voter sees only their own rows; nobody (admins included) can list other voters directly.
create policy poll_votes_own_read on public.poll_votes for select to authenticated using(public.is_feature_enabled('polls') and public.is_verified() and voter_id=auth.uid());

-- Server-side PII check (SPEC 4.2): Taiwan national ID pattern, MRN with context.
create function public.polls_has_pii(p_text text) returns boolean language sql immutable set search_path=public as $$
 select coalesce(p_text ~* '[A-Z][12][0-9]{8}' or p_text ~* '(病歷號|MRN|Chart\s*No\.?|病患編號)[:：\s#-]*[0-9]{6,10}',false)$$;

create function public.poll_is_closed(p public.polls) returns boolean language sql stable set search_path=public as $$
 select p.status='closed' or (p.closes_at is not null and p.closes_at<=now())$$;

create function public.set_poll_settings(p_members_can_create boolean) returns jsonb language plpgsql security definer set search_path=public as $$begin
 if not is_feature_enabled('polls') then raise exception 'FEATURE_DISABLED';end if;
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if p_members_can_create is null then raise exception 'INVALID_POLL';end if;
 update poll_settings set members_can_create=p_members_can_create,updated_by=auth.uid(),updated_at=now() where id;
 return jsonb_build_object('members_can_create',p_members_can_create);
end$$;

create function public.create_poll(p_title text,p_description text,p_kind text,p_max_choices integer,p_is_anonymous boolean,p_show_results text,p_closes_at timestamptz,p_attached_type text,p_attached_id uuid,p_options text[]) returns uuid language plpgsql security definer set search_path=public as $$
declare pid uuid;lbl text;i integer;n integer;mx integer;t text;d text;
begin
 if not is_feature_enabled('polls') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not is_admin() and not coalesce((select members_can_create from poll_settings where id),false) then raise exception 'CREATE_NOT_ALLOWED';end if;
 t:=btrim(coalesce(p_title,''));d:=btrim(coalesce(p_description,''));
 n:=coalesce(array_length(p_options,1),0);
 if length(t) not between 1 and 120 or length(d)>1000 or p_kind not in ('single','multiple') or p_show_results not in ('always','after_vote','after_close') then raise exception 'INVALID_POLL';end if;
 if n not between 2 and 10 then raise exception 'INVALID_OPTIONS';end if;
 for i in 1..n loop
  lbl:=btrim(coalesce(p_options[i],''));
  if length(lbl) not between 1 and 100 then raise exception 'INVALID_OPTIONS';end if;
 end loop;
 if (select count(distinct btrim(o)) from unnest(p_options) o)<>n then raise exception 'INVALID_OPTIONS';end if;
 mx:=case when p_kind='single' then 1 else coalesce(p_max_choices,n) end;
 if mx<1 or mx>n or (p_kind='multiple' and mx<2) then raise exception 'INVALID_POLL';end if;
 if p_closes_at is not null and p_closes_at<=now() then raise exception 'INVALID_POLL';end if;
 if (p_attached_type is null)<>(p_attached_id is null) or p_attached_type not in ('announcement','event','thread') then raise exception 'INVALID_ATTACHMENT';end if;
 if p_attached_type='announcement' and not exists(select 1 from public_announcements where id=p_attached_id) then raise exception 'INVALID_ATTACHMENT';end if;
 if p_attached_type='event' and not exists(select 1 from public_events where id=p_attached_id) then raise exception 'INVALID_ATTACHMENT';end if;
 if p_attached_type='thread' and not exists(select 1 from discussion_threads where id=p_attached_id) then raise exception 'INVALID_ATTACHMENT';end if;
 if polls_has_pii(t) or polls_has_pii(d) or exists(select 1 from unnest(p_options) o where polls_has_pii(o)) then raise exception 'PII_DETECTED';end if;
 insert into polls(creator_id,title,description,kind,max_choices,is_anonymous,show_results,closes_at,attached_type,attached_id)
  values(auth.uid(),t,d,p_kind,mx,coalesce(p_is_anonymous,false),p_show_results,p_closes_at,p_attached_type,p_attached_id) returning id into pid;
 for i in 1..n loop insert into poll_options(poll_id,label,position) values(pid,btrim(p_options[i]),i-1);end loop;
 return pid;
end$$;

create function public.cast_poll_vote(p_poll uuid,p_options uuid[]) returns jsonb language plpgsql security definer set search_path=public as $$
declare p polls;n integer;
begin
 if not is_feature_enabled('polls') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 -- Serialise concurrent votes by the same voter on the same poll so the replace-selection is atomic.
 perform pg_advisory_xact_lock(hashtextextended(p_poll::text||auth.uid()::text,17));
 select * into p from polls where id=p_poll;
 if not found then raise exception 'POLL_NOT_FOUND';end if;
 if poll_is_closed(p) then raise exception 'POLL_CLOSED';end if;
 n:=coalesce(array_length(p_options,1),0);
 if n<1 or n>p.max_choices or (select count(distinct o) from unnest(p_options) o)<>n then raise exception 'INVALID_CHOICES';end if;
 if (select count(*) from poll_options where poll_id=p_poll and id=any(p_options))<>n then raise exception 'INVALID_CHOICES';end if;
 delete from poll_votes where poll_id=p_poll and voter_id=auth.uid();
 insert into poll_votes(poll_id,option_id,voter_id) select p_poll,o,auth.uid() from unnest(p_options) o;
 return jsonb_build_object('poll_id',p_poll,'options',to_jsonb(p_options));
end$$;

create function public.close_poll(p_poll uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare p polls;
begin
 if not is_feature_enabled('polls') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 select * into p from polls where id=p_poll for update;
 if not found then raise exception 'POLL_NOT_FOUND';end if;
 if not is_admin() and p.creator_id<>auth.uid() then raise exception 'FORBIDDEN';end if;
 update polls set status='closed' where id=p_poll;
 return jsonb_build_object('poll_id',p_poll,'status','closed');
end$$;

-- Results honour show_results. Voter identities only appear for non-anonymous polls; anonymous polls
-- only ever reveal the caller's own selection (my_options).
create function public.poll_results(p_poll uuid) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p polls;closed boolean;voted boolean;visible boolean;res jsonb;
begin
 if not is_feature_enabled('polls') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 select * into p from polls where id=p_poll;
 if not found then raise exception 'POLL_NOT_FOUND';end if;
 closed:=poll_is_closed(p);
 voted:=exists(select 1 from poll_votes where poll_id=p_poll and voter_id=auth.uid());
 visible:=case p.show_results when 'always' then true when 'after_vote' then voted or closed else closed end;
 res:=jsonb_build_object('poll_id',p.id,'is_closed',closed,'is_anonymous',p.is_anonymous,'show_results',p.show_results,'visible',visible,'has_voted',voted,
  'my_options',coalesce((select jsonb_agg(option_id) from poll_votes where poll_id=p_poll and voter_id=auth.uid()),'[]'));
 if not visible then
  return res||jsonb_build_object('options',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'label',o.label,'position',o.position) order by o.position),'[]') from poll_options o where o.poll_id=p_poll));
 end if;
 return res||jsonb_build_object(
  'total_voters',(select count(distinct voter_id) from poll_votes where poll_id=p_poll),
  'options',(select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'label',o.label,'position',o.position,'votes',(select count(*) from poll_votes v where v.option_id=o.id),
    'voters',case when p.is_anonymous then null else coalesce((select jsonb_agg(pr.display_name order by pr.display_name) from poll_votes v join profiles pr on pr.id=v.voter_id where v.option_id=o.id),'[]') end) order by o.position),'[]')
   from poll_options o where o.poll_id=p_poll));
end$$;
revoke all on function public.polls_has_pii(text),public.poll_is_closed(public.polls),public.set_poll_settings(boolean),public.create_poll(text,text,text,integer,boolean,text,timestamptz,text,uuid,text[]),public.cast_poll_vote(uuid,uuid[]),public.close_poll(uuid),public.poll_results(uuid) from public,anon,authenticated;
grant execute on function public.polls_has_pii(text),public.poll_is_closed(public.polls),public.set_poll_settings(boolean),public.create_poll(text,text,text,integer,boolean,text,timestamptz,text,uuid,text[]),public.cast_poll_vote(uuid,uuid[]),public.close_poll(uuid),public.poll_results(uuid) to authenticated,service_role;
commit;
