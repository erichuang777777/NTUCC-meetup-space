begin;
-- F15 email_notifications: opt-in email preferences, service-only outbox, instant enqueue trigger, daily digests.
-- Incremental: runs after 001-014. Flag key: email_notifications. Does not change notify().
create table public.email_preferences (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 mode text not null default 'off' check(mode in ('off','instant','daily')),
 updated_at timestamptz not null default now()
);
alter table public.email_preferences enable row level security;
revoke all on public.email_preferences from public,anon,authenticated;
grant select on public.email_preferences to authenticated;
grant all on public.email_preferences to service_role;
create policy email_prefs_own_read on public.email_preferences for select to authenticated
 using(user_id=auth.uid() and public.is_verified() and public.is_feature_enabled('email_notifications'));

-- Outbox: service_role only. Bodies contain titles only (never message bodies); addresses are resolved at claim time, never stored.
create table public.email_outbox (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,
 kind text not null check(kind in ('instant','digest','test')),
 subject text not null check(length(subject)<=300),body_text text not null check(length(body_text)<=4000),
 link text check(link is null or link ~ '^[/#]'),notification_ids uuid[] not null default '{}',
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','skipped')),
 attempts integer not null default 0,last_error text check(length(last_error)<=500),
 created_at timestamptz not null default now(),sent_at timestamptz,next_attempt_at timestamptz not null default now()
);
create index email_outbox_due on public.email_outbox(next_attempt_at) where status in ('pending','sending');
create index email_outbox_user_kind on public.email_outbox(user_id,kind,created_at desc);
alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from public,anon,authenticated;
grant all on public.email_outbox to service_role;

-- Tracks notifications already covered by an email (instant or digest) so digests never duplicate.
create table public.email_notified (
 notification_id uuid primary key references public.notifications(id) on delete cascade,
 outbox_id uuid references public.email_outbox(id) on delete set null,created_at timestamptz not null default now()
);
alter table public.email_notified enable row level security;
revoke all on public.email_notified from public,anon,authenticated;
grant all on public.email_notified to service_role;

create function public.set_email_preference(p_mode text) returns jsonb language plpgsql security definer set search_path=public as $$begin
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 if not is_feature_enabled('email_notifications') then raise exception 'FEATURE_DISABLED';end if;
 if p_mode is null or p_mode not in ('off','instant','daily') then raise exception 'INVALID_MODE';end if;
 insert into email_preferences(user_id,mode) values(auth.uid(),p_mode) on conflict(user_id) do update set mode=excluded.mode,updated_at=now();
 return jsonb_build_object('mode',p_mode);
end$$;

create function public.email_trim_title(p text) returns text language sql immutable set search_path=public as $$select left(regexp_replace(coalesce(p,''),'[\r\n]+',' ','g'),120)$$;

-- AFTER INSERT on notifications: enqueue an instant email for users in 'instant' mode. Never blocks the notification itself.
create function public.enqueue_instant_email() returns trigger language plpgsql security definer set search_path=public as $$declare m text;ok boolean;oid uuid;begin
 if not is_feature_enabled('email_notifications') then return new;end if;
 select mode into m from email_preferences where user_id=new.user_id;
 if m is distinct from 'instant' then return new;end if;
 if exists(select 1 from notification_preferences where user_id=new.user_id and type=new.type and not enabled) then return new;end if;
 select passcode_verified and coalesce(email,'')<>'' into ok from profiles where id=new.user_id;
 insert into email_outbox(user_id,kind,subject,body_text,link,notification_ids,status,last_error)
  values(new.user_id,'instant','[NTUCC] '||email_trim_title(new.title),'- '||email_trim_title(new.title),coalesce(new.link,'#notifications'),array[new.id],
  case when coalesce(ok,false) then 'pending' else 'skipped' end,case when coalesce(ok,false) then null else 'RECIPIENT_NOT_VERIFIED' end) returning id into oid;
 insert into email_notified(notification_id,outbox_id) values(new.id,oid) on conflict do nothing;
 return new;
exception when others then
 return new;
end$$;
create trigger notifications_email_enqueue after insert on public.notifications for each row execute function public.enqueue_instant_email();

-- One digest per daily-mode user: unread notifications of the last 24h not yet covered by an email. Idempotent.
create function public.build_email_digests(p_now timestamptz default now()) returns integer language plpgsql security definer set search_path=public as $$declare r record;ids uuid[];titles text;n integer:=0;oid uuid;cnt integer;ok boolean;begin
 if not is_feature_enabled('email_notifications') then return 0;end if;
 for r in select p.user_id from email_preferences p where p.mode='daily' loop
  select array_agg(x.id order by x.created_at desc),count(*),
   string_agg('- '||email_trim_title(x.title),E'\n' order by x.created_at desc) filter(where x.rn<=20)
   into ids,cnt,titles
  from (select nn.id,nn.title,nn.created_at,row_number() over(order by nn.created_at desc) rn from notifications nn
   where nn.user_id=r.user_id and nn.read_at is null and nn.created_at>p_now-interval '24 hours' and nn.created_at<=p_now
   and not exists(select 1 from email_notified en where en.notification_id=nn.id)
   and not exists(select 1 from notification_preferences np where np.user_id=nn.user_id and np.type=nn.type and not np.enabled)) x;
  if cnt is null or cnt=0 then continue;end if;
  if cnt>20 then titles=titles||E'\n'||'…還有 '||(cnt-20)||' 則';end if;
  select passcode_verified and coalesce(email,'')<>'' into ok from profiles where id=r.user_id;
  insert into email_outbox(user_id,kind,subject,body_text,link,notification_ids,status,last_error)
   values(r.user_id,'digest','[NTUCC] 你有 '||cnt||' 則未讀通知',titles,'#notifications',ids,
   case when coalesce(ok,false) then 'pending' else 'skipped' end,case when coalesce(ok,false) then null else 'RECIPIENT_NOT_VERIFIED' end) returning id into oid;
  insert into email_notified(notification_id,outbox_id) select unnest(ids),oid on conflict do nothing;
  n=n+1;
 end loop;
 return n;
end$$;

-- Claim due rows (pending, or 'sending' whose 10-minute lease expired). Unverified/no-address recipients are marked skipped here, not returned.
create function public.claim_email_batch(p_limit integer default 50) returns table(id uuid,kind text,subject text,body_text text,link text,to_email text,attempts integer) language plpgsql security definer set search_path=public as $$begin
 if not is_feature_enabled('email_notifications') then return;end if;
 update email_outbox o set status='skipped',last_error='RECIPIENT_NOT_VERIFIED'
  where o.id in(select b.id from email_outbox b where b.status in('pending','sending') and b.next_attempt_at<=now()
   and not exists(select 1 from profiles p where p.id=b.user_id and p.passcode_verified and coalesce(p.email,'')<>'') for update skip locked);
 return query
 with picked as(select b.id from email_outbox b where b.status in('pending','sending') and b.next_attempt_at<=now()
   order by b.next_attempt_at,b.created_at limit greatest(1,least(coalesce(p_limit,50),50)) for update skip locked),
 upd as(update email_outbox o set status='sending',attempts=o.attempts+1,next_attempt_at=now()+interval '10 minutes' from picked where o.id=picked.id
   returning o.id,o.user_id,o.kind,o.subject,o.body_text,o.link,o.attempts)
 select u.id,u.kind,u.subject,u.body_text,u.link,pr.email,u.attempts from upd u join profiles pr on pr.id=u.user_id;
end$$;

create function public.email_redact(p text) returns text language sql immutable set search_path=public as $$
 select left(regexp_replace(regexp_replace(coalesce(p,''),'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+','[email]','g'),'(Bearer|Token|Key)\s+\S+','\1 [redacted]','gi'),500)$$;

-- Result of one attempt: ok => sent; failure => exponential backoff (2,4,8,16 min), failed after 5 attempts.
create function public.complete_email(p_id uuid,p_ok boolean,p_error text default null) returns text language plpgsql security definer set search_path=public as $$declare o email_outbox;res text;begin
 select * into o from email_outbox where id=p_id and status='sending' for update;
 if not found then raise exception 'EMAIL_NOT_CLAIMED';end if;
 if p_ok then update email_outbox set status='sent',sent_at=now(),last_error=null where id=p_id;return 'sent';end if;
 if o.attempts>=5 then res='failed';
  update email_outbox set status='failed',last_error=email_redact(p_error) where id=p_id;
 else res='pending';
  update email_outbox set status='pending',last_error=email_redact(p_error),next_attempt_at=now()+make_interval(mins=>power(2,o.attempts)::int) where id=p_id;
 end if;
 return res;
end$$;

-- Admin test email: one row per call; max 3 per hour per admin.
create function public.enqueue_test_email(p_actor uuid) returns uuid language plpgsql security definer set search_path=public as $$declare oid uuid;begin
 if not is_feature_enabled('email_notifications') then raise exception 'FEATURE_DISABLED';end if;
 if not exists(select 1 from profiles where id=p_actor and role='admin' and passcode_verified) then raise exception 'ADMIN_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtext('email_test:'||p_actor));
 if(select count(*) from email_outbox where user_id=p_actor and kind='test' and created_at>now()-interval '1 hour')>=3 then raise exception 'RATE_LIMITED';end if;
 insert into email_outbox(user_id,kind,subject,body_text,link) values(p_actor,'test','[NTUCC] 測試信件','- 這是一封測試信件，確認 Email 通知設定正常。','#notifications') returning id into oid;
 return oid;
end$$;

-- Admin stats: counts per status and recent (already redacted) errors; no addresses.
create function public.email_outbox_stats() returns jsonb language plpgsql security definer set search_path=public as $$begin
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 if not is_feature_enabled('email_notifications') then raise exception 'FEATURE_DISABLED';end if;
 return jsonb_build_object(
  'counts',coalesce((select jsonb_object_agg(status,c) from(select status,count(*) c from email_outbox group by status) s),'{}'::jsonb),
  'errors',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'status',status,'attempts',attempts,'error',last_error,'at',created_at)) from
   (select kind,status,attempts,last_error,created_at from email_outbox where last_error is not null order by created_at desc limit 10) e),'[]'::jsonb));
end$$;

revoke all on function public.set_email_preference(text),public.email_trim_title(text),public.enqueue_instant_email(),public.build_email_digests(timestamptz),
 public.claim_email_batch(integer),public.email_redact(text),public.complete_email(uuid,boolean,text),public.enqueue_test_email(uuid),public.email_outbox_stats() from public,anon,authenticated;
grant execute on function public.set_email_preference(text),public.email_outbox_stats() to authenticated,service_role;
grant execute on function public.build_email_digests(timestamptz),public.claim_email_batch(integer),public.complete_email(uuid,boolean,text),public.enqueue_test_email(uuid) to service_role;
commit;
