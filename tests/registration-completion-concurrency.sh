#!/usr/bin/env bash
# Disposable DB: guest vs signed-in registration of the same contact email.
set -euo pipefail
psql -v ON_ERROR_STOP=1 <<'SQL'
insert into auth.users(id,email) values('e1000000-0000-4000-8000-000000000001','registration-race@example.test');
insert into public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published) values
('e2000000-0000-4000-8000-000000000001','duplicate race',now()+interval '1 day',now()+interval '2 days',now()+interval '1 day',10,true);
SQL
out=$(mktemp -d);trap 'rm -rf "$out"' EXIT
psql -At -v ON_ERROR_STOP=1 -c "begin; select register_guest_event_details('e2000000-0000-4000-8000-000000000001',repeat('e',64),'Guest','臺大','race@example.test','ntucc_ticket_'||repeat('e',64),'素食');select pg_sleep(1);commit;" >"$out/guest" 2>&1 & guest=$!
psql -At -v ON_ERROR_STOP=1 -c "begin; select submit_event_application_details('e1000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Member','臺大','RACE@example.test',false,'葷食');select pg_sleep(1);commit;" >"$out/member" 2>&1 & member=$!
passed=0
wait "$guest" && passed=$((passed+1)) || true
wait "$member" && passed=$((passed+1)) || true
[[ "$passed" == 1 ]]
[[ $(cat "$out/guest" "$out/member" | grep -c 'ERROR:  REGISTRATION_CONFLICT') == 1 ]]
[[ $(psql -At -c "select count(*) from event_registrations where event_id='e2000000-0000-4000-8000-000000000001' and status='registered'") == 1 ]]
psql -v ON_ERROR_STOP=1 -c "delete from public_events where id='e2000000-0000-4000-8000-000000000001';delete from auth.users where id='e1000000-0000-4000-8000-000000000001';"
echo 'Concurrent guest/member duplicate-email test passed.'
