#!/usr/bin/env bash
# Disposable DB only. Uses standard PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD.
# Proves parallel registrations never oversell and parallel cancellations never double-fill via promotion.
set -euo pipefail
EV=e7100000-0000-4000-8000-000000000001
N=12; CAP=3
uid() { printf 'e7200000-0000-4000-8000-%012d' "$1"; }
psql -v ON_ERROR_STOP=1 <<SQL
update feature_flags set enabled=true where key in ('event_waitlist','notifications');
insert into auth.users(id,email,email_confirmed_at) select ('e7200000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,'wlrace'||g||'@example.test',now() from generate_series(1,$N) g;
insert into public.public_events(id,title,starts_at,ends_at,registration_closes_at,capacity,is_published,waitlist_enabled) values ('$EV','Waitlist race',now()+interval '1 day',now()+interval '2 days',now()+interval '1 hour',$CAP,true,true);
SQL
cleanup() { psql -q -c "delete from public.public_events where id='$EV'; delete from auth.users where id::text like 'e7200000-%'; update feature_flags set enabled=false where key in ('event_waitlist','notifications');" >/dev/null; }
trap cleanup EXIT
count() { psql -Atc "select count(*) from event_registrations where event_id='$EV' and status='$1'"; }
pids=()
for i in $(seq 1 $N); do
  psql -v ON_ERROR_STOP=1 -q -c "begin; select submit_event_application('$(uid $i)','$EV','U$i','台大','u$i@example.test'); select pg_sleep(0.2); commit;" >/dev/null &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
[[ $(count registered) == $CAP ]] || { echo "oversold: registered=$(count registered)"; exit 1; }
[[ $(count waitlisted) == $((N-CAP)) ]] || { echo "waitlisted=$(count waitlisted)"; exit 1; }
[[ $(psql -Atc "select count(distinct waitlisted_at) from event_registrations where event_id='$EV' and status='waitlisted'") == $((N-CAP)) ]] || { echo "duplicate waitlist positions"; exit 1; }
echo 'Parallel registration: seats capped, waitlist ordered.'
# Cancel every registered attendee in parallel while two new people try to join.
regs=$(psql -Atc "select user_id from event_registrations where event_id='$EV' and status='registered'")
firstwl=$(psql -Atc "select user_id from event_registrations where event_id='$EV' and status='waitlisted' order by waitlisted_at,id limit $CAP")
psql -q -c "insert into auth.users(id,email,email_confirmed_at) values ('e7200000-0000-4000-8000-000000000101','late1@example.test',now()),('e7200000-0000-4000-8000-000000000102','late2@example.test',now())" >/dev/null
pids=()
for u in $regs; do
  psql -v ON_ERROR_STOP=1 -q -c "begin; select submit_event_application('$u','$EV','','','',true); select pg_sleep(0.2); commit;" >/dev/null &
  pids+=($!)
done
for k in 101 102; do
  psql -v ON_ERROR_STOP=1 -q -c "begin; select submit_event_application('e7200000-0000-4000-8000-000000000$k','$EV','L','台大','l$k@example.test'); select pg_sleep(0.2); commit;" >/dev/null &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
[[ $(count registered) == $CAP ]] || { echo "seat count after cancels: $(count registered)"; exit 1; }
[[ $(count cancelled) == $CAP ]] || { echo "cancelled=$(count cancelled)"; exit 1; }
# The earliest waiters (not the late joiners) must have been promoted.
for u in $firstwl; do
  [[ $(psql -Atc "select status from event_registrations where event_id='$EV' and user_id='$u'") == registered ]] || { echo "FIFO violated for $u"; exit 1; }
done
[[ $(psql -Atc "select count(*) from notifications where type='waitlist_promoted' and payload->>'event_id'='$EV'") == $CAP ]] || { echo "promotion notifications != $CAP"; exit 1; }
echo 'Parallel cancel/promote: no double fill, FIFO preserved.'
