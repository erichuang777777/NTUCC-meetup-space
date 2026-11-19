begin;
-- F2 member_directory: opt-in member directory with expertise tags. Gated by is_feature_enabled('member_directory').
-- Incremental: safe to run once after 001-013. Turning the flag off hides everything but deletes nothing.
create table public.member_directory_profiles (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 listed boolean not null default false,
 bio text not null default '' check(length(bio)<=500),
 expertise_tags text[] not null default '{}' check(cardinality(expertise_tags)<=10),
 open_to_questions boolean not null default false,
 question_topics text not null default '' check(length(question_topics)<=200),
 updated_at timestamptz not null default now()
);
create index member_directory_listed on public.member_directory_profiles(listed) where listed;
create index member_directory_tags on public.member_directory_profiles using gin(expertise_tags);
alter table public.member_directory_profiles enable row level security;
revoke all on public.member_directory_profiles from public,anon,authenticated;
grant select on public.member_directory_profiles to authenticated;

-- True when either side of the pair has blocked the other (contact_blocks from 004).
create function public.directory_blocked(p_other uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from contact_blocks where (owner_id=auth.uid() and blocked_user_id=p_other) or (owner_id=p_other and blocked_user_id=auth.uid()))$$;

-- Owner sees own row (even unlisted); others (admins included) only listed rows, never across a block.
create policy directory_read on public.member_directory_profiles for select to authenticated using(
 public.is_feature_enabled('member_directory') and public.is_verified() and (
  user_id=auth.uid() or (listed and not public.directory_blocked(user_id))));

-- Same semantics as public/pii.ts: national ID and MRN-with-context patterns.
create function public.directory_has_pii(p_text text) returns boolean language sql immutable set search_path=public as $$
 select coalesce(p_text ~* '[A-Z][12][0-9]{8}' or p_text ~* '(病歷號|MRN|Chart[[:space:]]*No\.?|病患編號)[:：[:space:]#-]*[0-9]{6,10}',false)$$;

create function public.upsert_my_directory_profile(p_listed boolean,p_bio text,p_tags text[],p_open boolean,p_topics text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare bio_v text:=trim(coalesce(p_bio,''));topics_v text:=trim(coalesce(p_topics,''));tags_v text[];t text;
begin
 if not is_feature_enabled('member_directory') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if length(bio_v)>500 then raise exception 'INVALID_BIO';end if;
 if length(topics_v)>200 then raise exception 'INVALID_TOPICS';end if;
 -- normalize: trim, collapse inner whitespace, drop empties, de-duplicate case-insensitively (first spelling wins)
 select coalesce(array_agg(tag order by first_pos),'{}') into tags_v from(
  select distinct on(lower(tag)) tag,first_pos from(
   select regexp_replace(trim(x),'[[:space:]]+',' ','g') tag,ord first_pos from unnest(coalesce(p_tags,'{}')) with ordinality u(x,ord)) n
  where tag<>'' order by lower(tag),first_pos) d;
 if cardinality(tags_v)>10 then raise exception 'INVALID_TAGS';end if;
 foreach t in array tags_v loop if length(t)>20 then raise exception 'INVALID_TAGS';end if;end loop;
 if directory_has_pii(bio_v) or directory_has_pii(topics_v) or directory_has_pii(array_to_string(tags_v,' ')) then raise exception 'PII_DETECTED';end if;
 insert into member_directory_profiles(user_id,listed,bio,expertise_tags,open_to_questions,question_topics,updated_at)
 values(auth.uid(),coalesce(p_listed,false),bio_v,tags_v,coalesce(p_open,false),topics_v,now())
 on conflict(user_id) do update set listed=excluded.listed,bio=excluded.bio,expertise_tags=excluded.expertise_tags,
  open_to_questions=excluded.open_to_questions,question_topics=excluded.question_topics,updated_at=now();
 return jsonb_build_object('listed',coalesce(p_listed,false),'bio',bio_v,'expertise_tags',to_jsonb(tags_v),'open_to_questions',coalesce(p_open,false),'question_topics',topics_v);
end$$;

create function public.search_member_directory(p_query text default null,p_department text default null,p_tag text default null,p_limit int default 24,p_offset int default 0)
returns table(user_id uuid,display_name text,department text,bio text,expertise_tags text[],open_to_questions boolean,question_topics text)
language plpgsql stable security definer set search_path=public as $$
declare q text:=nullif(trim(coalesce(p_query,'')),'');pat text;
begin
 if not is_feature_enabled('member_directory') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if q is not null then pat:='%'||replace(replace(replace(q,'\','\\'),'%','\%'),'_','\_')||'%';end if;
 return query select d.user_id,p.display_name,p.department,d.bio,d.expertise_tags,d.open_to_questions,d.question_topics
  from member_directory_profiles d join profiles p on p.id=d.user_id
  where d.listed and p.passcode_verified and d.user_id<>auth.uid() and not directory_blocked(d.user_id)
   and (p_department is null or p_department='' or p.department=p_department)
   and (p_tag is null or p_tag='' or exists(select 1 from unnest(d.expertise_tags) x where lower(x)=lower(p_tag)))
   and (pat is null or p.display_name ilike pat or d.bio ilike pat or d.question_topics ilike pat or exists(select 1 from unnest(d.expertise_tags) x where x ilike pat))
  order by p.display_name,d.user_id limit least(greatest(coalesce(p_limit,24),1),50) offset greatest(coalesce(p_offset,0),0);
end$$;

create function public.member_directory_tags() returns table(tag text,member_count bigint)
language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('member_directory') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return query select min(x) tag,count(distinct d.user_id) member_count
  from member_directory_profiles d join profiles p on p.id=d.user_id,unnest(d.expertise_tags) x
  where d.listed and p.passcode_verified and not directory_blocked(d.user_id)
  group by lower(x) order by member_count desc,lower(x) limit 100;
end$$;

create function public.member_directory_departments() returns table(department text)
language plpgsql stable security definer set search_path=public as $$begin
 if not is_feature_enabled('member_directory') then raise exception 'FEATURE_DISABLED';end if;
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 return query select distinct p.department from member_directory_profiles d join profiles p on p.id=d.user_id
  where d.listed and p.passcode_verified and p.department<>'' and not directory_blocked(d.user_id) order by 1;
end$$;

revoke all on function public.directory_blocked(uuid),public.directory_has_pii(text),
 public.upsert_my_directory_profile(boolean,text,text[],boolean,text),
 public.search_member_directory(text,text,text,int,int),public.member_directory_tags(),public.member_directory_departments() from public,anon,authenticated;
grant execute on function public.directory_blocked(uuid),public.directory_has_pii(text),
 public.upsert_my_directory_profile(boolean,text,text[],boolean,text),
 public.search_member_directory(text,text,text,int,int),public.member_directory_tags(),public.member_directory_departments() to authenticated,service_role;
commit;
