#!/usr/bin/env bash
# Disposable DB only. Uses standard PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD.
set -euo pipefail
psql -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id,email) values ('f2000000-0000-4000-8000-000000000001','race1@example.test'),('f2000000-0000-4000-8000-000000000002','race2@example.test');
insert into public.public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values ('f3000000-0000-4000-8000-000000000001','Race test',now()+interval '1 day',now()+interval '2 days',now()+interval '1 hour',1,true);
SQL
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
psql -v ON_ERROR_STOP=1 -c "begin; select register_public_event('f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001'); select pg_sleep(1); commit;" >"$out/a" 2>&1 & a=$!
psql -v ON_ERROR_STOP=1 -c "begin; select register_public_event('f2000000-0000-4000-8000-000000000002','f3000000-0000-4000-8000-000000000001'); select pg_sleep(1); commit;" >"$out/b" 2>&1 & b=$!
sa=0; sb=0; wait "$a" || sa=$?; wait "$b" || sb=$?
if [[ "$sa" == 0 && "$sb" != 0 ]]; then grep -q EVENT_FULL "$out/b"; elif [[ "$sb" == 0 && "$sa" != 0 ]]; then grep -q EVENT_FULL "$out/a"; else cat "$out/a" "$out/b"; exit 1; fi
[[ $(psql -Atc "select count(*) from event_registrations where event_id='f3000000-0000-4000-8000-000000000001' and status='registered'") == 1 ]]
psql -v ON_ERROR_STOP=1 -c "delete from public_events where id='f3000000-0000-4000-8000-000000000001'; delete from auth.users where id in ('f2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000002');"
echo 'Concurrent last-seat test passed.'
