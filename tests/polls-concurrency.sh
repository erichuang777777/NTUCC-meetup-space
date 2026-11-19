#!/usr/bin/env bash
# Disposable database only. Parallel votes by the same user must never exceed max_choices.
set -euo pipefail
U=d2000000-0000-4000-8000-000000000001
P=d2000000-0000-4000-8000-0000000000f1
psql -v ON_ERROR_STOP=1 <<SQL
insert into auth.users(id,email) values ('$U','poll-race@example.test');
update profiles set passcode_verified=true where id='$U';
update feature_flags set enabled=true where key='polls';
insert into polls(id,creator_id,title,kind,max_choices) values ('$P','$U','Race','multiple',2);
insert into poll_options(id,poll_id,label,position) select ('d2000000-0000-4000-8000-00000000010'||g)::uuid,'$P','o'||g,g from generate_series(0,5) g;
SQL
out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
pids=()
for i in 0 1 2 3 4 5; do
  a=$i; b=$(( (i+1) % 6 ))
  q="begin; select set_config('request.jwt.claim.sub','$U',true); set local role authenticated; select cast_poll_vote('$P',array['d2000000-0000-4000-8000-00000000010$a'::uuid,'d2000000-0000-4000-8000-00000000010$b'::uuid]); select pg_sleep(0.3); commit;"
  psql -At -v ON_ERROR_STOP=1 -c "$q" >"$out/$i" 2>&1 & pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
n=$(psql -At -c "select count(*) from poll_votes where poll_id='$P' and voter_id='$U'")
[[ "$n" == 2 ]] || { echo "Expected exactly 2 votes, got $n" >&2; cat "$out"/*; exit 1; }
psql -v ON_ERROR_STOP=1 -c "delete from polls where id='$P'; update feature_flags set enabled=false where key='polls'; delete from profiles where id='$U'; delete from auth.users where id='$U';"
echo 'Concurrent poll vote test passed.'
