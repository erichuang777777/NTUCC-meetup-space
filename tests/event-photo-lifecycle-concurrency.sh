#!/usr/bin/env bash
# Disposable database only. Tests real two-connection publish/withdraw and cleanup/finalize races.
set -euo pipefail
psql -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id,email) values ('dd000000-0000-4000-8000-000000000001','raceowner@example.test'),('dd000000-0000-4000-8000-000000000002','raceadmin@example.test');
update profiles set role='admin',passcode_verified=true where id='dd000000-0000-4000-8000-000000000002';
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('de000000-0000-4000-8000-000000000001','Photo race',now()+interval '1 hour',now()+interval '2 hours',now()+interval '30 minutes',10,true);
select submit_event_application('dd000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001','參與者','台大','personal@example.test');
select queue_event_photo_cleanup('de000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/df000000-0000-4000-8000-000000000001.png',true);
select add_pending_event_photo('df000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/df000000-0000-4000-8000-000000000001.png','',1,1,80);
select change_event_photo('df000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','consent',true,'public_web');
SQL
out=$(mktemp -d);trap 'rm -rf "$out"' EXIT
psql -v ON_ERROR_STOP=1 -c "begin;set local statement_timeout='8s'; select change_event_photo('df000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000002','publish',null,'public_web','Human reviewed',true);select pg_sleep(1);commit;" >"$out/publish" 2>&1 & a=$!
psql -v ON_ERROR_STOP=1 -c "begin;set local statement_timeout='8s'; select change_event_photo('df000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000001','withdraw');select pg_sleep(1);commit;" >"$out/withdraw" 2>&1 & b=$!
sa=0;wait "$a" || sa=$?;wait "$b"
if [[ "$sa" != 0 ]];then grep -q PHOTO_WITHDRAWN "$out/publish";fi
[[ $(psql -Atc "select status||':'||publication_consent::text from event_photos where id='df000000-0000-4000-8000-000000000001'") == 'withdrawn:false' ]]
psql -v ON_ERROR_STOP=1 <<'SQL'
select queue_event_photo_cleanup('de000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/df000000-0000-4000-8000-000000000003.png',true);
select add_pending_event_photo('df000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/df000000-0000-4000-8000-000000000003.png','',1,1,80);
select change_event_photo('df000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-000000000001','consent',true,'public_web');
SQL
psql -v ON_ERROR_STOP=1 -c "begin;set local statement_timeout='8s'; select change_event_photo('df000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-000000000002','publish',null,'public_web','Human reviewed',true);select pg_sleep(1);commit;" >"$out/publish2" 2>&1 & a=$!
psql -v ON_ERROR_STOP=1 -c "begin;set local statement_timeout='8s'; select change_event_photo('df000000-0000-4000-8000-000000000003','dd000000-0000-4000-8000-000000000001','consent',false,'public_web');select pg_sleep(1);commit;" >"$out/revoke" 2>&1 & b=$!
sa=0;wait "$a" || sa=$?;wait "$b"
if [[ "$sa" != 0 ]];then grep -q PUBLICATION_CONSENT_REQUIRED "$out/publish2";fi
[[ $(psql -Atc "select status||':'||publication_consent::text from event_photos where id='df000000-0000-4000-8000-000000000003'") == 'pending:false' ]]
psql -v ON_ERROR_STOP=1 <<'SQL'
select queue_event_photo_cleanup('de000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/df000000-0000-4000-8000-000000000002.png',true);
update event_photo_cleanup set created_at=now()-interval '11 minutes' where object_path like '%/df000000-0000-4000-8000-000000000002.png';
SQL
psql -v ON_ERROR_STOP=1 -c "begin;set local statement_timeout='8s'; select add_pending_event_photo('df000000-0000-4000-8000-000000000002','dd000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001','de000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000001/df000000-0000-4000-8000-000000000002.png','',1,1,80);select pg_sleep(1);commit;" >"$out/finalize" 2>&1 & a=$!
psql -v ON_ERROR_STOP=1 -c "begin;set local statement_timeout='8s'; select * from pending_event_photo_cleanup();select pg_sleep(1);commit;" >"$out/cleanup" 2>&1 & b=$!
sa=0;wait "$a" || sa=$?;wait "$b"
if [[ "$sa" != 0 ]];then grep -q UPLOAD_INTENT_EXPIRED "$out/finalize";fi
psql -v ON_ERROR_STOP=1 <<'SQL'
do $$declare live boolean;state text;begin
 select exists(select 1 from event_photos where id='df000000-0000-4000-8000-000000000002') into live;
 select status into state from event_photo_cleanup where object_path like '%/df000000-0000-4000-8000-000000000002.png';
 if not ((live and state='retained') or (not live and state='pending')) then raise exception 'Cleanup raced live object';end if;
end$$;
delete from public_events where id='de000000-0000-4000-8000-000000000001';
delete from profiles where id in ('dd000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000002');
delete from auth.users where id in ('dd000000-0000-4000-8000-000000000001','dd000000-0000-4000-8000-000000000002');
delete from event_photo_cleanup where object_path like 'de000000-0000-4000-8000-000000000001/%';
SQL
echo 'Photo publication/withdrawal and cleanup/finalize races passed.'
