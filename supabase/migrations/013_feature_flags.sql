begin;
-- Phase 0: feature flags, flag audit trail, in-app notification core.
-- Incremental: safe to run once on an existing database after 001-012.
create table public.feature_flags (
 key text primary key check(key ~ '^[a-z][a-z0-9_]{1,62}$'),enabled boolean not null default false,
 label text not null,description text,updated_by uuid references public.profiles(id),updated_at timestamptz default now()
);
create table public.feature_flag_events (
 id uuid primary key default gen_random_uuid(),flag_key text not null references public.feature_flags(key) on delete cascade,
 enabled boolean not null,actor_id uuid references public.profiles(id),created_at timestamptz not null default now()
);
create index feature_flag_events_key on public.feature_flag_events(flag_key,created_at desc);
alter table public.feature_flags enable row level security;
alter table public.feature_flag_events enable row level security;
revoke all on public.feature_flags,public.feature_flag_events from public,anon,authenticated;
grant select on public.feature_flags,public.feature_flag_events to authenticated;
create policy flags_read on public.feature_flags for select to authenticated using(public.is_verified());
create policy flag_events_admin_read on public.feature_flag_events for select to authenticated using(public.is_admin());

insert into public.feature_flags(key,label,description) values
 ('notifications','站內通知中心','頂部鈴鐺與通知列表，供其他功能發送站內通知'),
 ('member_directory','同仁名錄','自願公開的同仁名錄、專長標籤與私訊入口'),
 ('event_feedback','會後回饋問卷','活動結束後對已報到者開放的回饋問卷'),
 ('polls','投票與意見調查','建立投票與意見調查，支援匿名與截止時間'),
 ('content_reports','檢舉與版務審核','同仁檢舉內容，管理員審核與處置'),
 ('forum_plus','論壇強化','@提及、有幫助、最佳解答、追蹤主題與置頂'),
 ('event_waitlist','名額上限與候補','活動名額限制、候補與自動遞補'),
 ('talk_proposals','徵稿與講者報名','同仁投稿題目並由管理員審核排程'),
 ('event_series','活動系列與複製','活動歸屬系列，並可複製上一場設定'),
 ('member_hosted_events','同仁發起活動','同仁提案活動，經管理員審核後上架'),
 ('event_archive','活動回顧與知識庫','活動結束後的回顧頁與歷屆列表'),
 ('global_search','全站搜尋','跨公告、活動、展示、討論與痛點搜尋'),
 ('admin_dashboard','營運儀表板','管理員專用的參與與營運彙總統計'),
 ('participation_history','個人參與紀錄','個人頁顯示參加與分享紀錄'),
 ('email_notifications','Email 通知與摘要','依站內通知寄送即時或每日摘要 Email')
on conflict do nothing;

-- Unknown key => false. Not granted to anon: avoids letting anonymous visitors probe which features exist.
create function public.is_feature_enabled(p_key text) returns boolean language sql stable security definer set search_path=public as $$select coalesce((select enabled from feature_flags where key=p_key),false)$$;
create function public.set_feature_flag(p_key text,p_enabled boolean) returns jsonb language plpgsql security definer set search_path=public as $$begin
 if not is_admin() then raise exception 'ADMIN_REQUIRED';end if;
 update feature_flags set enabled=p_enabled,updated_by=auth.uid(),updated_at=now() where key=p_key;
 if not found then raise exception 'UNKNOWN_FEATURE';end if;
 insert into feature_flag_events(flag_key,enabled,actor_id) values(p_key,p_enabled,auth.uid());
 return jsonb_build_object('key',p_key,'enabled',p_enabled);
end$$;
revoke all on function public.is_feature_enabled(text),public.set_feature_flag(text,boolean) from public,anon,authenticated;
grant execute on function public.is_feature_enabled(text),public.set_feature_flag(text,boolean) to authenticated,service_role;

create table public.notifications (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,
 type text not null check(length(type) between 1 and 64),title text not null check(length(title) between 1 and 200),
 body text check(length(body)<=2000),link text check(link is null or link ~ '^[/#]'),
 payload jsonb not null default '{}',read_at timestamptz,created_at timestamptz not null default now()
);
create index notifications_user_created on public.notifications(user_id,created_at desc);
create index notifications_unread on public.notifications(user_id,created_at desc) where read_at is null;
alter table public.notifications enable row level security;
revoke all on public.notifications from public,anon,authenticated;
grant select on public.notifications to authenticated;
create policy notifications_own_read on public.notifications for select to authenticated using(user_id=auth.uid() and public.is_verified());

-- Callable only by service_role or other security definer functions (owner), so users cannot notify each other.
create function public.notify(p_user uuid,p_type text,p_title text,p_body text default null,p_link text default null,p_payload jsonb default '{}') returns uuid language plpgsql security definer set search_path=public as $$declare result uuid;begin
 if not is_feature_enabled('notifications') then return null;end if;
 if p_link is not null and p_link !~ '^[/#]' then raise exception 'INVALID_LINK';end if;
 insert into notifications(user_id,type,title,body,link,payload) values(p_user,p_type,p_title,p_body,p_link,coalesce(p_payload,'{}')) returning id into result;
 return result;
end$$;
create function public.mark_notifications_read(p_ids uuid[]) returns integer language plpgsql security definer set search_path=public as $$declare n integer;begin
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 update notifications set read_at=now() where user_id=auth.uid() and id=any(p_ids) and read_at is null;
 get diagnostics n=row_count;return n;
end$$;
create function public.mark_all_notifications_read() returns integer language plpgsql security definer set search_path=public as $$declare n integer;begin
 if not is_verified() then raise exception 'MEMBER_REQUIRED';end if;
 update notifications set read_at=now() where user_id=auth.uid() and read_at is null;
 get diagnostics n=row_count;return n;
end$$;
revoke all on function public.notify(uuid,text,text,text,text,jsonb),public.mark_notifications_read(uuid[]),public.mark_all_notifications_read() from public,anon,authenticated;
grant execute on function public.notify(uuid,text,text,text,text,jsonb) to service_role;
grant execute on function public.mark_notifications_read(uuid[]),public.mark_all_notifications_read() to authenticated,service_role;

do $$begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime')
 and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='notifications') then
  alter publication supabase_realtime add table public.notifications;
 end if;
end$$;
commit;
