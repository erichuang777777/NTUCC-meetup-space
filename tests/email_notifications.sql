\set ON_ERROR_STOP on
begin;
-- f1 admin, f2 member (instant), f3 member (daily), f4 unverified (instant), f5 member (off, never set)
insert into auth.users(id,email) values
('00000000-0000-4000-8000-0000000000f1','em-admin@example.test'),
('00000000-0000-4000-8000-0000000000f2','em-instant@example.test'),
('00000000-0000-4000-8000-0000000000f3','em-daily@example.test'),
('00000000-0000-4000-8000-0000000000f4','em-unverified@example.test'),
('00000000-0000-4000-8000-0000000000f5','em-off@example.test');
update profiles set role='admin',passcode_verified=true where id='00000000-0000-4000-8000-0000000000f1';
update profiles set passcode_verified=true where id in('00000000-0000-4000-8000-0000000000f2','00000000-0000-4000-8000-0000000000f3','00000000-0000-4000-8000-0000000000f5');
insert into email_preferences(user_id,mode) values
('00000000-0000-4000-8000-0000000000f2','instant'),('00000000-0000-4000-8000-0000000000f3','daily'),('00000000-0000-4000-8000-0000000000f4','instant');

-- Flag OFF: no enqueue, RPCs denied, digests/claims no-op.
do $$begin
 update feature_flags set enabled=true where key='notifications';
 perform notify('00000000-0000-4000-8000-0000000000f2','x_test','off-title');
 if exists(select 1 from email_outbox) then raise exception 'enqueued while flag off';end if;
 if build_email_digests(now())<>0 then raise exception 'digest while off';end if;
 if exists(select 1 from claim_email_batch(10)) then raise exception 'claim while off';end if;
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000f2',true);
do $$begin
 begin perform set_email_preference('daily');raise exception 'pref while off';exception when raise_exception then if sqlerrm<>'FEATURE_DISABLED' then raise;end if;end;
 if exists(select 1 from email_preferences) then raise exception 'prefs visible while off';end if;
end$$;
reset role;
do $$begin update feature_flags set enabled=true where key='email_notifications';delete from notifications;end$$;

-- Instant enqueue: only instant mode; off-mode user and daily user get nothing; title only, link relative.
do $$declare o email_outbox;nid uuid;begin
 nid=notify('00000000-0000-4000-8000-0000000000f2','private_message','新私訊','SECRET BODY','#messages');
 select * into o from email_outbox where user_id='00000000-0000-4000-8000-0000000000f2';
 if not found or o.kind<>'instant' or o.status<>'pending' or o.notification_ids<>array[nid] then raise exception 'instant not enqueued';end if;
 if o.body_text like '%SECRET%' or o.subject like '%SECRET%' or o.link<>'#messages' then raise exception 'body leaked';end if;
 perform notify('00000000-0000-4000-8000-0000000000f5','private_message','t5');
 perform notify('00000000-0000-4000-8000-0000000000f3','private_message','t3');
 if exists(select 1 from email_outbox where user_id in('00000000-0000-4000-8000-0000000000f5','00000000-0000-4000-8000-0000000000f3')) then raise exception 'non-instant user enqueued';end if;
 -- opted-out type: direct insert bypasses notify(), trigger must still skip
 insert into notification_preferences(user_id,type,enabled) values('00000000-0000-4000-8000-0000000000f2','forum_mention',false);
 insert into notifications(user_id,type,title) values('00000000-0000-4000-8000-0000000000f2','forum_mention','opted out');
 if(select count(*) from email_outbox where user_id='00000000-0000-4000-8000-0000000000f2')<>1 then raise exception 'opted-out type enqueued';end if;
 -- unverified recipient: row marked skipped
 insert into notifications(user_id,type,title) values('00000000-0000-4000-8000-0000000000f4','private_message','for unverified');
 if not exists(select 1 from email_outbox where user_id='00000000-0000-4000-8000-0000000000f4' and status='skipped') then raise exception 'unverified not skipped';end if;
end$$;

-- Digest: one per daily user, idempotent, excludes read / old / already-notified.
do $$declare n integer;c integer;begin
 insert into notifications(user_id,type,title,created_at) values
  ('00000000-0000-4000-8000-0000000000f3','private_message','d-one',now()-interval '2 hours'),
  ('00000000-0000-4000-8000-0000000000f3','private_message','d-two',now()-interval '1 hour'),
  ('00000000-0000-4000-8000-0000000000f3','private_message','d-old',now()-interval '30 hours');
 insert into notifications(user_id,type,title,read_at) values('00000000-0000-4000-8000-0000000000f3','private_message','d-read',now());
 n=build_email_digests(now());
 if n<>1 then raise exception 'expected 1 digest, got %',n;end if;
 select cardinality(notification_ids) into c from email_outbox where user_id='00000000-0000-4000-8000-0000000000f3' and kind='digest';
 if c<>3 then raise exception 'digest should hold 3 unread-in-window (incl t3), got %',c;end if;
 if exists(select 1 from email_outbox where kind='digest' and (body_text like '%d-old%' or body_text like '%d-read%')) then raise exception 'digest content wrong';end if;
 if build_email_digests(now())<>0 then raise exception 'digest not idempotent';end if;
 if(select count(*) from email_outbox where kind='digest')<>1 then raise exception 'duplicate digest';end if;
end$$;

-- Claim / complete: batch limit, leases, backoff, max attempts, non-claimed completion.
do $$declare ids uuid[];r record;res text;a integer;begin
 update email_outbox set status='sent' where status='pending' and kind='digest';
 for i in 1..4 loop insert into email_outbox(user_id,kind,subject,body_text) values('00000000-0000-4000-8000-0000000000f2','instant','s'||i,'b');end loop;
 if(select count(*) from claim_email_batch(2))<>2 then raise exception 'limit not honored';end if;
 -- already claimed rows (lease active) are not handed out again; second claim gets the rest incl. earlier pending instant
 if(select count(*) from claim_email_batch(50))<>3 then raise exception 'claimed rows re-claimed';end if;
 if exists(select 1 from claim_email_batch(50)) then raise exception 'nothing should be due';end if;
 select array_agg(id) into ids from email_outbox where status='sending';
 -- lease expiry makes rows claimable again
 update email_outbox set next_attempt_at=now()-interval '1 minute' where id=ids[1];
 if(select count(*) from claim_email_batch(50))<>1 then raise exception 'lease expiry not reclaimed';end if;
 -- success
 if complete_email(ids[2],true)<>'sent' then raise exception 'complete ok';end if;
 -- failure -> pending with backoff and redacted/truncated error
 res=complete_email(ids[3],false,'boom to a@b.com Bearer abc123 '||repeat('x',900));
 select * into r from email_outbox where id=ids[3];
 if res<>'pending' or r.status<>'pending' or r.next_attempt_at<=now()+interval '1 minute' or length(r.last_error)>500 then raise exception 'backoff wrong';end if;
 if r.last_error like '%a@b.com%' or r.last_error like '%abc123%' then raise exception 'error not redacted';end if;
 -- backoff grows and caps at 5 attempts
 update email_outbox set status='sending',attempts=4 where id=ids[3];
 perform complete_email(ids[3],false,'e');
 update email_outbox set status='sending',attempts=5 where id=ids[3];
 res=complete_email(ids[3],false,'e');
 if res<>'failed' or(select status from email_outbox where id=ids[3])<>'failed' then raise exception 'max attempts';end if;
 begin perform complete_email(ids[3],true);raise exception 'completed unclaimed';exception when raise_exception then if sqlerrm<>'EMAIL_NOT_CLAIMED' then raise;end if;end;
 -- unverified recipient at claim time -> skipped, not returned
 update email_outbox set status='pending',next_attempt_at=now() where id=ids[3];
 update profiles set passcode_verified=false where id='00000000-0000-4000-8000-0000000000f2';
 if exists(select 1 from claim_email_batch(50) where to_email like 'em-instant%') then raise exception 'unverified claimed';end if;
 if(select status from email_outbox where id=ids[3])<>'skipped' then raise exception 'unverified not skipped at claim';end if;
 update profiles set passcode_verified=true where id='00000000-0000-4000-8000-0000000000f2';
end$$;

-- Test email: admin only, 3 per hour.
do $$begin
 begin perform enqueue_test_email('00000000-0000-4000-8000-0000000000f2');raise exception 'non-admin test';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 perform enqueue_test_email('00000000-0000-4000-8000-0000000000f1');perform enqueue_test_email('00000000-0000-4000-8000-0000000000f1');perform enqueue_test_email('00000000-0000-4000-8000-0000000000f1');
 begin perform enqueue_test_email('00000000-0000-4000-8000-0000000000f1');raise exception 'no rate limit';exception when raise_exception then if sqlerrm<>'RATE_LIMITED' then raise;end if;end;
end$$;

-- RLS / grants: authenticated cannot touch outbox, claim, complete, build; own prefs readable; RPC works.
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000f2',true);
do $$begin
 begin perform 1 from email_outbox;raise exception 'outbox readable';exception when insufficient_privilege then null;end;
 begin perform 1 from email_notified;raise exception 'notified readable';exception when insufficient_privilege then null;end;
 begin insert into email_preferences(user_id,mode) values(auth.uid(),'off');raise exception 'direct pref write';exception when insufficient_privilege then null;end;
 begin perform claim_email_batch(1);raise exception 'claim by user';exception when insufficient_privilege then null;end;
 begin perform complete_email(gen_random_uuid(),true);raise exception 'complete by user';exception when insufficient_privilege then null;end;
 begin perform build_email_digests(now());raise exception 'build by user';exception when insufficient_privilege then null;end;
 begin perform email_outbox_stats();raise exception 'stats by non-admin';exception when raise_exception then if sqlerrm<>'ADMIN_REQUIRED' then raise;end if;end;
 begin perform set_email_preference('weekly');raise exception 'bad mode';exception when raise_exception then if sqlerrm<>'INVALID_MODE' then raise;end if;end;
 perform set_email_preference('daily');
 if(select mode from email_preferences)<>'daily' then raise exception 'pref not saved';end if;
 if(select count(*) from email_preferences)<>1 then raise exception 'saw other prefs';end if;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000f4',true);
do $$begin
 begin perform set_email_preference('daily');raise exception 'unverified set';exception when raise_exception then if sqlerrm<>'MEMBER_REQUIRED' then raise;end if;end;
end$$;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000f1',true);
do $$declare s jsonb;begin
 s=email_outbox_stats();
 if s->'counts' is null or s::text ~ '@' then raise exception 'stats bad or leak address';end if;
end$$;
reset role;
rollback;
select 'email_notifications.sql OK';
