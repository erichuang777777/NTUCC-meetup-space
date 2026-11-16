create extension if not exists pgcrypto with schema extensions;
create table public.profiles(id uuid primary key references auth.users on delete cascade,email text unique not null,display_name text not null,department text not null default '',role text not null default 'member' check(role in ('member','admin')),passcode_verified boolean not null default false,created_at timestamptz not null default now());
create table public.user_api_tokens(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles on delete cascade,token_prefix text not null,token_hash text unique not null,last_used_at timestamptz,created_at timestamptz default now());
create table public.meetup_sessions(id uuid primary key default gen_random_uuid(),title text not null,session_date date not null,start_time time not null default '12:30',location text not null default '',credits text not null default '',is_active boolean not null default false);
create unique index one_active_session on meetup_sessions(is_active) where is_active;
create table public.announcements(id uuid primary key default gen_random_uuid(),title text not null,category text not null check(category in ('場地異動','資安紅線','教育學分','活動公告')),content text not null,is_pinned boolean default false,author_id uuid references profiles,created_at timestamptz default now());
create table public.registrations(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles on delete cascade,session_id uuid not null references meetup_sessions on delete cascade,meal_preference text not null default '葷食' check(meal_preference in ('葷食','素食','不需餐盒')),checked_in boolean not null default false,checked_in_at timestamptz,created_at timestamptz default now(),unique(user_id,session_id));
create table public.spaces(id uuid primary key default gen_random_uuid(),owner_id uuid not null references profiles on delete cascade,title text not null,category_tag text not null default '實戰展示' check(category_tag in ('實戰展示','踩坑避雷')),summary text not null,highlights jsonb not null default '[]',visibility text not null default 'private' check(visibility in ('private','public')),slide_count integer not null default 0 check(slide_count=0 or slide_count between 10 and 15),reference_links jsonb not null default '[]',votes integer not null default 0,vibe_counts jsonb not null default '{"mindblown":0,"need_this":0,"pii_safe":0,"want_link":0}',session_id uuid references meetup_sessions,slot_order integer check(slot_order>=0),created_at timestamptz default now(),updated_at timestamptz default now());
create unique index unique_slot on spaces(session_id,slot_order) where slot_order is not null;
create table public.space_slides(space_id uuid primary key references spaces on delete cascade,html_slides text not null);
create table public.space_qa(id uuid primary key default gen_random_uuid(),space_id uuid not null references spaces on delete cascade,author_id uuid not null references profiles,is_anonymous boolean not null default false,question_text text not null,speaker_reply text,is_resolved boolean not null default false,upvotes integer not null default 0,created_at timestamptz default now());
create table public.pain_points(id uuid primary key default gen_random_uuid(),proposer_id uuid not null references profiles,title text not null,department text not null default '',scenario text not null,time_cost text,ideal_outcome text,upvotes integer not null default 0,created_at timestamptz default now());
create table public.user_votes(user_id uuid not null references profiles on delete cascade,target_type text not null check(target_type in ('space','qa','pain_point')),target_id uuid not null,created_at timestamptz default now(),primary key(user_id,target_type,target_id));
create table public.pii_override_logs(id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles,source_channel text not null check(source_channel in ('web_ui','rest_api','mcp_server')),matched_types jsonb not null,created_at timestamptz default now());
create table public.vibe_events(id uuid primary key default gen_random_uuid(),space_id uuid not null references spaces on delete cascade,user_id uuid not null references profiles,kind text not null check(kind in ('mindblown','need_this','pii_safe','want_link')),created_at timestamptz default now());
create index spaces_public on spaces(visibility,created_at desc);
create index qa_space on space_qa(space_id,upvotes desc);
create index registrations_session on registrations(session_id);
create index vibes_space on vibe_events(space_id,created_at desc);

create function public.new_profile() returns trigger language plpgsql security definer set search_path=public as $$begin insert into profiles(id,email,display_name) values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name',split_part(new.email,'@',1)));return new;end$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.new_profile();
create function public.is_verified() returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from profiles where id=auth.uid() and passcode_verified)$$;
create function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from profiles where id=auth.uid() and role='admin' and passcode_verified)$$;
-- Passcode is provisioned in Vault, never in the frontend or this migration.
create table public.passcode_attempts(user_id uuid primary key references profiles on delete cascade,attempts integer not null default 0,window_start timestamptz not null default now());
create function public.verify_ntucc_passcode(input_code text) returns boolean language plpgsql security definer set search_path=public,extensions as $$declare expected text; attempts_count integer;begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED';end if;
 insert into passcode_attempts(user_id,attempts) values(auth.uid(),1) on conflict(user_id) do update set attempts=case when passcode_attempts.window_start<now()-interval '15 minutes' then 1 else passcode_attempts.attempts+1 end,window_start=case when passcode_attempts.window_start<now()-interval '15 minutes' then now() else passcode_attempts.window_start end returning attempts into attempts_count;
 if attempts_count>10 then return false;end if;
 select decrypted_secret into expected from vault.decrypted_secrets where name='ntucc_passcode' limit 1;
 if expected is null or expected<>input_code then return false;end if;
 update profiles set passcode_verified=true where id=auth.uid();return true;
end$$;
revoke all on function public.verify_ntucc_passcode(text) from public,anon;
grant execute on function public.verify_ntucc_passcode(text) to authenticated;

-- All content mutations go through the server's PII guard. No browser INSERT/UPDATE grants.
do $$declare t text;begin foreach t in array array['profiles','user_api_tokens','meetup_sessions','announcements','registrations','spaces','space_slides','space_qa','pain_points','user_votes','pii_override_logs','vibe_events','passcode_attempts'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon, authenticated',t);end loop;end$$;
grant select on profiles,user_api_tokens,meetup_sessions,announcements,registrations,spaces,space_slides,pain_points,user_votes,pii_override_logs,vibe_events to authenticated;
grant select on meetup_sessions,announcements,spaces,pain_points to anon;
create policy own_profile on profiles for select to authenticated using(id=auth.uid());
create policy own_token on user_api_tokens for select to authenticated using(user_id=auth.uid());
-- Token hash remains inaccessible even to its owner.
revoke select on user_api_tokens from authenticated;
grant select(id,user_id,token_prefix,last_used_at,created_at) on user_api_tokens to authenticated;
create policy sessions_read on meetup_sessions for select using(true);
create policy announcements_read on announcements for select using(true);
create policy space_read on spaces for select using(visibility='public' or owner_id=auth.uid());
create policy slides_read on space_slides for select to authenticated using(is_verified() and exists(select 1 from spaces where id=space_id and (visibility='public' or owner_id=auth.uid())));
create policy registration_read on registrations for select to authenticated using(is_verified() and (user_id=auth.uid() or is_admin()));
create policy pain_read on pain_points for select using(true);
create policy vote_read on user_votes for select to authenticated using(user_id=auth.uid());
create policy logs_read on pii_override_logs for select to authenticated using(user_id=auth.uid());
create policy vibe_read on vibe_events for select to authenticated using(is_verified() and exists(select 1 from spaces where id=space_id and visibility='public'));
-- Anonymous questions never expose author_id through a public view or realtime stream.
create view public.qa_public as select q.id,q.space_id,q.question_text,q.is_anonymous,case when q.is_anonymous then '匿名同仁' else p.display_name end as author_name,q.speaker_reply,q.is_resolved,q.upvotes,q.created_at from space_qa q join profiles p on p.id=q.author_id join spaces s on s.id=q.space_id where s.visibility='public';
grant select on qa_public to anon,authenticated;

create function public.save_space(p_id uuid,p_owner uuid,p_fields jsonb,p_html text,p_count integer) returns uuid language plpgsql security definer set search_path=public as $$declare result uuid;begin
 if not exists(select 1 from profiles where id=p_owner and passcode_verified) then raise exception 'PASSCODE_REQUIRED';end if;
 if p_id is null then insert into spaces(owner_id,title,summary,category_tag,visibility,highlights,reference_links,slide_count) values(p_owner,p_fields->>'title',p_fields->>'summary',p_fields->>'category_tag',p_fields->>'visibility',p_fields->'highlights',p_fields->'reference_links',coalesce(p_count,0)) returning id into result;
 else update spaces set title=p_fields->>'title',summary=p_fields->>'summary',category_tag=p_fields->>'category_tag',visibility=p_fields->>'visibility',highlights=p_fields->'highlights',reference_links=p_fields->'reference_links',slide_count=coalesce(p_count,slide_count),updated_at=now() where id=p_id and owner_id=p_owner returning id into result;if result is null then raise exception 'SPACE_NOT_FOUND';end if;end if;
 if p_html is not null then insert into space_slides values(result,p_html) on conflict(space_id) do update set html_slides=excluded.html_slides;end if;return result;
end$$;
create function public.cast_vote(p_user uuid,p_type text,p_target uuid) returns void language plpgsql security definer set search_path=public as $$declare inserted integer;begin
 if not exists(select 1 from profiles where id=p_user and passcode_verified) then raise exception 'PASSCODE_REQUIRED';end if;
 if p_type='space' then perform 1 from spaces where id=p_target and visibility='public';elsif p_type='qa' then perform 1 from space_qa q join spaces s on s.id=q.space_id where q.id=p_target and s.visibility='public';elsif p_type='pain_point' then perform 1 from pain_points where id=p_target;else raise exception 'INVALID_TARGET';end if;
 if not found then raise exception 'TARGET_NOT_FOUND';end if;
 insert into user_votes values(p_user,p_type,p_target,now()) on conflict do nothing;get diagnostics inserted=row_count;
 if inserted=1 then if p_type='space' then update spaces set votes=votes+1 where id=p_target;elsif p_type='qa' then update space_qa set upvotes=upvotes+1 where id=p_target;else update pain_points set upvotes=upvotes+1 where id=p_target;end if;end if;
end$$;
create function public.add_vibe(p_user uuid,p_space uuid,p_kind text) returns void language plpgsql security definer set search_path=public as $$begin
 if p_kind not in ('mindblown','need_this','pii_safe','want_link') or not exists(select 1 from profiles where id=p_user and passcode_verified) then raise exception 'INVALID_VIBE';end if;
 perform pg_advisory_xact_lock(hashtext(p_user::text));
 if (select count(*) from vibe_events where user_id=p_user and created_at>now()-interval '1 minute')>=30 then raise exception 'RATE_LIMITED';end if;
 update spaces set vibe_counts=jsonb_set(vibe_counts,array[p_kind],to_jsonb(coalesce((vibe_counts->>p_kind)::int,0)+1)) where id=p_space and visibility='public';if not found then raise exception 'SPACE_NOT_FOUND';end if;
 insert into vibe_events(space_id,user_id,kind) values(p_space,p_user,p_kind);end$$;
revoke all on function save_space(uuid,uuid,jsonb,text,integer),cast_vote(uuid,text,uuid),add_vibe(uuid,uuid,text) from public,anon,authenticated;
grant execute on function save_space(uuid,uuid,jsonb,text,integer),cast_vote(uuid,text,uuid),add_vibe(uuid,uuid,text) to service_role;
-- Realtime publishes only public metadata; private drafts and anonymous identities are never broadcast.
alter publication supabase_realtime add table public.vibe_events;
alter publication supabase_realtime add table public.registrations;
create function public.activate_session(p_fields jsonb) returns uuid language plpgsql security definer set search_path=public as $$declare result uuid;begin
 perform pg_advisory_xact_lock(927310);
 update meetup_sessions set is_active=false where is_active;
 insert into meetup_sessions(title,session_date,start_time,location,credits,is_active) values(p_fields->>'title',(p_fields->>'session_date')::date,(p_fields->>'start_time')::time,p_fields->>'location',p_fields->>'credits',true) returning id into result;return result;
end$$;
revoke all on function activate_session(jsonb) from public,anon,authenticated;
grant execute on function activate_session(jsonb) to service_role;
-- Server-side quotas for billable AI calls. Atomic per-user window avoids parallel bypass.
create table public.api_rate_limits(user_id uuid not null references profiles on delete cascade,action text not null,window_start timestamptz not null default now(),hits integer not null default 1,primary key(user_id,action));
alter table api_rate_limits enable row level security;
revoke all on api_rate_limits from anon,authenticated;
create function public.consume_quota(p_user uuid,p_action text,p_limit integer) returns boolean language plpgsql security definer set search_path=public as $$declare count_now integer;begin
 insert into api_rate_limits(user_id,action) values(p_user,p_action) on conflict(user_id,action) do update set hits=case when api_rate_limits.window_start<now()-interval '1 hour' then 1 else api_rate_limits.hits+1 end,window_start=case when api_rate_limits.window_start<now()-interval '1 hour' then now() else api_rate_limits.window_start end returning hits into count_now;
 return count_now<=p_limit;end$$;
revoke all on function consume_quota(uuid,text,integer) from public,anon,authenticated;
grant execute on function consume_quota(uuid,text,integer) to service_role;
