begin;
-- F1 notifications: preferences, opt-out aware notify(), triggers for existing features, event reminders.
-- Incremental: runs after 001-013. Flag key: notifications.
create table public.notification_preferences (
 user_id uuid not null references public.profiles(id) on delete cascade,
 type text not null check(length(type) between 1 and 64),enabled boolean not null default true,
 updated_at timestamptz not null default now(),primary key(user_id,type)
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public,anon,authenticated;
grant select,insert,update,delete on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;
create policy notification_prefs_own on public.notification_preferences for all to authenticated
 using(user_id=auth.uid() and public.is_verified() and public.is_feature_enabled('notifications'))
 with check(user_id=auth.uid() and public.is_verified() and public.is_feature_enabled('notifications'));

-- 013's read policy ignores the flag; a restrictive policy hides rows (without deleting them) while the flag is off.
create policy notifications_flag_gate on public.notifications as restrictive for select to authenticated using(public.is_feature_enabled('notifications'));

create or replace function public.notify(p_user uuid,p_type text,p_title text,p_body text default null,p_link text default null,p_payload jsonb default '{}') returns uuid language plpgsql security definer set search_path=public as $$declare result uuid;begin
 if not is_feature_enabled('notifications') then return null;end if;
 if p_link is not null and p_link !~ '^[/#]' then raise exception 'INVALID_LINK';end if;
 if exists(select 1 from notification_preferences where user_id=p_user and type=p_type and not enabled) then return null;end if;
 insert into notifications(user_id,type,title,body,link,payload) values(p_user,p_type,p_title,p_body,p_link,coalesce(p_payload,'{}')) returning id into result;
 return result;
end$$;
create or replace function public.mark_notifications_read(p_ids uuid[]) returns integer language plpgsql security definer set search_path=public as $$declare n integer;begin
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not is_feature_enabled('notifications') then return 0;end if;
 update notifications set read_at=now() where user_id=auth.uid() and id=any(p_ids) and read_at is null;
 get diagnostics n=row_count;return n;
end$$;
create or replace function public.mark_all_notifications_read() returns integer language plpgsql security definer set search_path=public as $$declare n integer;begin
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not is_feature_enabled('notifications') then return 0;end if;
 update notifications set read_at=now() where user_id=auth.uid() and read_at is null;
 get diagnostics n=row_count;return n;
end$$;
revoke all on function public.notify(uuid,text,text,text,text,jsonb),public.mark_notifications_read(uuid[]),public.mark_all_notifications_read() from public,anon,authenticated;
grant execute on function public.notify(uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.mark_notifications_read(uuid[]),public.mark_all_notifications_read() to authenticated,service_role;

-- Trigger: new private message -> recipient (skips blocked pairs; body is only the sender's display name).
create function public.notify_private_message() returns trigger language plpgsql security definer set search_path=public as $$declare c private_conversations;rcpt uuid;begin
 if not is_feature_enabled('notifications') then return new;end if;
 select * into c from private_conversations where id=new.conversation_id;
 if not found then return new;end if;
 rcpt=case when c.member_low=new.sender_id then c.member_high else c.member_low end;
 if exists(select 1 from contact_blocks where (owner_id=rcpt and blocked_user_id=new.sender_id) or (owner_id=new.sender_id and blocked_user_id=rcpt)) then return new;end if;
 perform notify(rcpt,'private_message','新私訊',(select display_name from profiles where id=new.sender_id),'#messages',jsonb_build_object('conversation_id',new.conversation_id));
 return new;
end$$;
create trigger private_messages_notify after insert on public.private_messages for each row execute function public.notify_private_message();

-- Trigger: reply to a discussion thread -> thread author (not for self-replies or hidden replies).
create function public.notify_discussion_reply() returns trigger language plpgsql security definer set search_path=public as $$declare t discussion_threads;begin
 if not is_feature_enabled('notifications') or new.is_hidden then return new;end if;
 select * into t from discussion_threads where id=new.thread_id;
 if not found or t.author_id=new.author_id then return new;end if;
 perform notify(t.author_id,'discussion_reply','你的討論串有新回覆',(select display_name from profiles where id=new.author_id),'#project/'||t.space_id||'/thread/'||t.id,jsonb_build_object('thread_id',t.id,'reply_id',new.id));
 return new;
end$$;
create trigger discussion_replies_notify after insert on public.discussion_replies for each row execute function public.notify_discussion_reply();

-- Trigger: registration review result -> member registrant (guest registrations have no user_id).
create function public.notify_registration_review() returns trigger language plpgsql security definer set search_path=public as $$declare ev text;approved boolean;begin
 if not is_feature_enabled('notifications') or new.user_id is null then return new;end if;
 approved=old.eligibility_status='pending' and new.eligibility_status='approved' and new.status='registered';
 if not approved and not((old.eligibility_status='pending' and new.eligibility_status='rejected') or (new.status='rejected' and old.status is distinct from 'rejected')) then return new;end if;
 select title into ev from public_events where id=new.event_id;
 perform notify(new.user_id,'registration_review',case when approved then '報名已通過審核' else '報名未通過審核' end,ev,'#registration',jsonb_build_object('event_id',new.event_id,'approved',approved));
 return new;
end$$;
create trigger event_registrations_review_notify after update of status,eligibility_status on public.event_registrations for each row when(new.status is distinct from old.status or new.eligibility_status is distinct from old.eligibility_status) execute function public.notify_registration_review();

-- Event reminders: each (event,user) is reminded once, even if the user opted out of the type.
create table public.event_reminders_sent (
 event_id uuid not null references public.public_events on delete cascade,
 user_id uuid not null references auth.users on delete cascade,
 sent_at timestamptz not null default now(),primary key(event_id,user_id)
);
alter table public.event_reminders_sent enable row level security;
revoke all on public.event_reminders_sent from public,anon,authenticated;
grant all on public.event_reminders_sent to service_role;
create function public.queue_event_reminders(p_window interval default '24 hours') returns integer language plpgsql security definer set search_path=public as $$declare r record;n integer:=0;begin
 if not is_feature_enabled('notifications') then return 0;end if;
 if p_window<=interval '0' or p_window>interval '7 days' then raise exception 'INVALID_WINDOW';end if;
 for r in select e.id event_id,e.title,e.starts_at,g.user_id from public_events e join event_registrations g on g.event_id=e.id
  where e.status='scheduled' and e.is_published and e.starts_at>now() and e.starts_at<=now()+p_window
  and g.status='registered' and g.eligibility_status='approved' and g.user_id is not null
  and exists(select 1 from profiles p where p.id=g.user_id and p.passcode_verified)
  and not exists(select 1 from event_reminders_sent s where s.event_id=e.id and s.user_id=g.user_id) loop
  insert into event_reminders_sent(event_id,user_id) values(r.event_id,r.user_id) on conflict do nothing;
  if found then
   perform notify(r.user_id,'event_reminder','活動即將開始',r.title,'#registration',jsonb_build_object('event_id',r.event_id,'starts_at',r.starts_at));
   n=n+1;
  end if;
 end loop;
 return n;
end$$;
revoke all on function public.queue_event_reminders(interval),public.notify_private_message(),public.notify_discussion_reply(),public.notify_registration_review() from public,anon,authenticated;
grant execute on function public.queue_event_reminders(interval) to service_role;
commit;
