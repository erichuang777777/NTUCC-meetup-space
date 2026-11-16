begin;
alter table public.profiles add column accepts_messages boolean not null default true;
alter table public.user_api_tokens add column scopes text[] not null default array['projects:read','projects:write','discussions:read','discussions:write'];
alter table public.user_api_tokens add constraint allowed_token_scopes check(scopes <@ array['projects:read','projects:write','discussions:read','discussions:write','messages:read','messages:write']);
grant select(scopes) on public.user_api_tokens to authenticated;
create table public.contact_blocks (
 owner_id uuid not null references public.profiles on delete cascade,
 blocked_user_id uuid not null references public.profiles on delete cascade,
 created_at timestamptz not null default now(), primary key(owner_id,blocked_user_id),check(owner_id<>blocked_user_id)
);
create table public.private_conversations (
 id uuid primary key default gen_random_uuid(),
 member_low uuid not null references public.profiles on delete cascade,
 member_high uuid not null references public.profiles on delete cascade,
 created_at timestamptz not null default now(),last_message_at timestamptz not null default now(),
 unique(member_low,member_high),check(member_low<member_high)
);
create table public.private_messages (
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.private_conversations on delete cascade,
 sender_id uuid not null references public.profiles on delete cascade,
 body text not null check(length(body) between 1 and 6000),project_id uuid references public.spaces on delete set null,
 client_request_id uuid,created_at timestamptz not null default now(),unique(sender_id,client_request_id)
);
create index private_conversation_low on public.private_conversations(member_low,last_message_at desc);
create index private_conversation_high on public.private_conversations(member_high,last_message_at desc);
create index private_messages_page on public.private_messages(conversation_id,created_at desc,id);
alter table public.contact_blocks enable row level security;
alter table public.private_conversations enable row level security;
alter table public.private_messages enable row level security;
revoke all on public.contact_blocks,public.private_conversations,public.private_messages from public,anon,authenticated;
grant select on public.contact_blocks,public.private_conversations,public.private_messages to authenticated;
create policy own_blocks on public.contact_blocks for select to authenticated using(public.is_verified() and owner_id=auth.uid());
create policy own_conversations on public.private_conversations for select to authenticated using(public.is_verified() and auth.uid() in(member_low,member_high));
create policy own_messages on public.private_messages for select to authenticated using(public.is_verified() and exists(select 1 from public.private_conversations c where c.id=conversation_id));

-- Service-only RPCs preserve participant checks even when called with a privileged key.
create function public.send_private_message(p_sender uuid,p_recipient uuid,p_body text,p_project uuid default null,p_request uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare low_id uuid;high_id uuid;conversation uuid;message_id uuid;previous private_messages%rowtype;begin
 if p_sender=p_recipient or not exists(select 1 from profiles where id=p_sender and passcode_verified) then raise exception 'CONTACT_UNAVAILABLE';end if;
 low_id=least(p_sender,p_recipient);high_id=greatest(p_sender,p_recipient);
 perform pg_advisory_xact_lock(hashtextextended(low_id::text||high_id::text,0));
 perform 1 from profiles where id=p_recipient and passcode_verified and accepts_messages for share;
 if not found or exists(select 1 from contact_blocks where (owner_id=p_sender and blocked_user_id=p_recipient) or (owner_id=p_recipient and blocked_user_id=p_sender)) then raise exception 'CONTACT_UNAVAILABLE';end if;
 if length(trim(p_body)) not between 1 and 6000 then raise exception 'INVALID_MESSAGE';end if;
 if p_project is not null and not exists(select 1 from spaces where id=p_project and visibility='public') then raise exception 'PROJECT_NOT_FOUND';end if;
 select id into conversation from private_conversations where member_low=low_id and member_high=high_id;
 if p_request is not null then
  select * into previous from private_messages where sender_id=p_sender and client_request_id=p_request;
  if found then
   if previous.conversation_id is distinct from conversation or previous.body<>p_body or previous.project_id is distinct from p_project then raise exception 'IDEMPOTENCY_CONFLICT';end if;
   return jsonb_build_object('conversation_id',previous.conversation_id,'message_id',previous.id,'duplicate',true);
  end if;
 end if;
 if not consume_quota(p_sender,'private_message',30) then raise exception 'RATE_LIMITED';end if;
 insert into private_conversations(member_low,member_high) values(low_id,high_id) on conflict(member_low,member_high) do update set last_message_at=now() returning id into conversation;
 insert into private_messages(conversation_id,sender_id,body,project_id,client_request_id) values(conversation,p_sender,p_body,p_project,p_request) returning id into message_id;
 return jsonb_build_object('conversation_id',conversation,'message_id',message_id,'duplicate',false);
end$$;
create function public.set_contact_block(p_owner uuid,p_target uuid,p_blocked boolean) returns void language plpgsql security definer set search_path=public as $$begin
 if p_owner=p_target or not exists(select 1 from profiles where id=p_owner and passcode_verified) or not exists(select 1 from profiles where id=p_target and passcode_verified) then raise exception 'CONTACT_UNAVAILABLE';end if;
 perform pg_advisory_xact_lock(hashtextextended(least(p_owner,p_target)::text||greatest(p_owner,p_target)::text,0));
 if p_blocked then insert into contact_blocks(owner_id,blocked_user_id) values(p_owner,p_target) on conflict do nothing;
 else delete from contact_blocks where owner_id=p_owner and blocked_user_id=p_target;end if;
end$$;
revoke all on function public.send_private_message(uuid,uuid,text,uuid,uuid),public.set_contact_block(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.send_private_message(uuid,uuid,text,uuid,uuid),public.set_contact_block(uuid,uuid,boolean) to service_role;
commit;
