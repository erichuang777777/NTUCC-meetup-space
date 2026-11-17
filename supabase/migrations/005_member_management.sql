begin;
create table public.member_invitations (
 id uuid primary key default gen_random_uuid(),email text not null check(email=lower(trim(email))),
 role text not null default 'member' check(role in ('member','admin')),
 token_hash text unique not null check(token_hash ~ '^[a-f0-9]{64}$'),
 invited_by uuid not null references public.profiles,created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '7 days',accepted_at timestamptz,
 accepted_by uuid references public.profiles,revoked_at timestamptz
);
create index member_invites_email on public.member_invitations(email,created_at desc);
create table public.member_admin_events (
 id uuid primary key default gen_random_uuid(),actor_id uuid not null references public.profiles,
 target_id uuid references public.profiles,invitation_id uuid references public.member_invitations,
 event text not null check(event in ('role_changed','invite_created','invite_revoked','invite_accepted')),
 details jsonb not null default '{}',created_at timestamptz not null default now()
);
alter table public.member_invitations enable row level security;
alter table public.member_admin_events enable row level security;
revoke all on public.member_invitations,public.member_admin_events from public,anon,authenticated;
grant select(id,email,role,invited_by,created_at,expires_at,accepted_at,accepted_by,revoked_at) on public.member_invitations to authenticated;
grant select on public.member_admin_events to authenticated;
create policy admin_invites_read on public.member_invitations for select to authenticated using(public.is_admin());
create policy admin_events_read on public.member_admin_events for select to authenticated using(public.is_admin());

create function public.set_member_role(p_actor uuid,p_target uuid,p_role text) returns jsonb language plpgsql security definer set search_path=public as $$declare previous text;target_verified boolean;begin
 perform pg_advisory_xact_lock(hashtextextended('ntucc-member-management',0));
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 if p_role not in ('member','admin') then raise exception 'INVALID_ROLE';end if;
 if p_actor=p_target then raise exception 'SELF_ROLE_CHANGE_FORBIDDEN';end if;
 select role,passcode_verified into previous,target_verified from profiles where id=p_target for update;
 if not found then raise exception 'MEMBER_NOT_VERIFIED';end if;
 if previous='admin' and target_verified and p_role='member' and (select count(*) from profiles where role='admin' and passcode_verified)<=1 then raise exception 'LAST_ADMIN';end if;
 update profiles set role=p_role where id=p_target;
 if previous<>p_role then insert into member_admin_events(actor_id,target_id,event,details) values(p_actor,p_target,'role_changed',jsonb_build_object('from',previous,'to',p_role));end if;
 return jsonb_build_object('id',p_target,'role',p_role);
end$$;
create function public.create_member_invitation(p_actor uuid,p_email text,p_role text,p_hash text) returns uuid language plpgsql security definer set search_path=public as $$declare result uuid;begin
 perform pg_advisory_xact_lock(hashtextextended('ntucc-member-management',0));
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 if p_role not in ('member','admin') or p_email is null or p_email<>lower(trim(p_email)) or length(p_email)>254 or position('@' in p_email)<2 then raise exception 'INVALID_INVITATION';end if;
 if not consume_quota(p_actor,'member_invitation',20) then raise exception 'RATE_LIMITED';end if;
 update member_invitations set revoked_at=now() where email=p_email and accepted_at is null and revoked_at is null;
 insert into member_invitations(email,role,token_hash,invited_by) values(p_email,p_role,p_hash,p_actor) returning id into result;
 insert into member_admin_events(actor_id,invitation_id,event) values(p_actor,result,'invite_created');return result;
end$$;
create function public.revoke_member_invitation(p_actor uuid,p_id uuid) returns void language plpgsql security definer set search_path=public as $$begin
 perform pg_advisory_xact_lock(hashtextextended('ntucc-member-management',0));
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 update member_invitations set revoked_at=now() where id=p_id and accepted_at is null and revoked_at is null;
 if not found then raise exception 'INVITATION_NOT_PENDING';end if;
 insert into member_admin_events(actor_id,invitation_id,event) values(p_actor,p_id,'invite_revoked');end$$;
create function public.accept_member_invitation(p_user uuid,p_hash text) returns jsonb language plpgsql security definer set search_path=public as $$declare invitation member_invitations%rowtype;account_email text;begin
 perform pg_advisory_xact_lock(hashtextextended('ntucc-member-management',0));
 select lower(email) into account_email from auth.users where id=p_user and email_confirmed_at is not null
 and (raw_app_meta_data->>'provider'='google' or coalesce(raw_app_meta_data->'providers','[]'::jsonb)?'google');
 if account_email is null then raise exception 'GOOGLE_LOGIN_REQUIRED';end if;
 select * into invitation from member_invitations where token_hash=p_hash for update;
 if not found or invitation.revoked_at is not null or invitation.expires_at<=now() then raise exception 'INVITATION_INVALID';end if;
 if account_email<>invitation.email then raise exception 'INVITE_ACCOUNT_MISMATCH';end if;
 if invitation.accepted_at is not null then
  if invitation.accepted_by=p_user then return jsonb_build_object('accepted',true,'duplicate',true);end if;
  raise exception 'INVITATION_INVALID';
 end if;
 update profiles set passcode_verified=true,role=case when role='admin' then role else invitation.role end where id=p_user;
 if not found then raise exception 'PROFILE_NOT_FOUND';end if;
 update member_invitations set accepted_at=now(),accepted_by=p_user where id=invitation.id;
 insert into member_admin_events(actor_id,target_id,invitation_id,event) values(p_user,p_user,invitation.id,'invite_accepted');
 return jsonb_build_object('accepted',true,'duplicate',false);
end$$;
revoke all on function public.set_member_role(uuid,uuid,text),public.create_member_invitation(uuid,text,text,text),public.revoke_member_invitation(uuid,uuid),public.accept_member_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.set_member_role(uuid,uuid,text),public.create_member_invitation(uuid,text,text,text),public.revoke_member_invitation(uuid,uuid),public.accept_member_invitation(uuid,text) to service_role;
commit;
