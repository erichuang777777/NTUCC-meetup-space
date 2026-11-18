#!/usr/bin/env bash
# Disposable database only.
set -euo pipefail
psql -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id,email) values ('d0000000-0000-4000-8000-000000000001','qr-race@example.test'),('d0000000-0000-4000-8000-000000000002','scanner@example.test');
update profiles set passcode_verified=true where id='d0000000-0000-4000-8000-000000000002';
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published,checkin_opens_at,checkin_closes_at) values ('d1000000-0000-4000-8000-000000000001','Scan race',now()+interval '30 minutes',now()+interval '2 hours',now()+interval '10 minutes',5,true,now()-interval '1 hour',now()+interval '3 hours');
insert into event_staff values ('d1000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002');
select register_public_event('d0000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001');
select event_ticket('d0000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('c',64));
SQL
out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
query="begin; select check_in_public_event('d0000000-0000-4000-8000-000000000002','d1000000-0000-4000-8000-000000000001','ntucc_ticket_'||repeat('c',64)); select pg_sleep(1); commit;"
psql -At -v ON_ERROR_STOP=1 -c "$query" >"$out/a" 2>&1 & a=$!
psql -At -v ON_ERROR_STOP=1 -c "$query" >"$out/b" 2>&1 & b=$!
wait "$a"; wait "$b"
[[ $(cat "$out/a" "$out/b" | grep -c '"already_checked_in": false') == 1 ]]
[[ $(cat "$out/a" "$out/b" | grep -c '"already_checked_in": true') == 1 ]]
psql -v ON_ERROR_STOP=1 -c "delete from public_events where id='d1000000-0000-4000-8000-000000000001'; delete from profiles where id in ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002'); delete from auth.users where id in ('d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002');"
echo 'Concurrent duplicate scan test passed.'
