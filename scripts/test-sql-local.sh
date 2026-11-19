#!/usr/bin/env bash
# Local-only: run the SQL/RLS/concurrency steps of .github/workflows/ci.yml
# against a fresh, throwaway PostgreSQL cluster on the given port.
# Usage: bash scripts/test-sql-local.sh [port]   (default 55432)
# Each port is an isolated cluster, so parallel worktrees can use different ports.
set -euo pipefail
PORT="${1:-55432}"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -x "$BIN/initdb" ] || { echo "PostgreSQL binaries not found" >&2; exit 2; }
DATA="/tmp/ntucc-pg-$PORT"
RUNAS=()
[ "$(id -u)" = 0 ] && RUNAS=(runuser -u postgres --)
"${RUNAS[@]}" "$BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$DATA"; mkdir -p "$DATA"; [ "$(id -u)" = 0 ] && chown postgres "$DATA"
PWFILE="$(mktemp)"; echo test-only > "$PWFILE"; chmod 644 "$PWFILE"
"${RUNAS[@]}" "$BIN/initdb" -D "$DATA" -U postgres --pwfile="$PWFILE" -A scram-sha-256 -E UTF8 --locale=C.UTF-8 >/dev/null
rm -f "$PWFILE"
"${RUNAS[@]}" "$BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=localhost" -l "$DATA/log" -w start >/dev/null
trap '"${RUNAS[@]}" "$BIN/pg_ctl" -D "$DATA" stop -m fast >/dev/null 2>&1 || true' EXIT
export PGHOST=localhost PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres PGPASSWORD=test-only
# Extract the commands of the "Check schema and RLS" step from CI so the two never drift.
STEPS="$(awk '/Check schema and RLS/{f=1} f&&/run: \|/{r=1;next} r&&/^      - /{exit} r' .github/workflows/ci.yml \
  | sed -E 's/^ +//; s/-h localhost -U postgres //; s/PGHOST=localhost PGUSER=postgres PGDATABASE=postgres //' | grep -v '^$')"
while IFS= read -r cmd; do
  echo "▶ $cmd"
  bash -c "$cmd" >/tmp/ntucc-pg-$PORT.step.log 2>&1 || { cat /tmp/ntucc-pg-$PORT.step.log; echo "FAILED: $cmd" >&2; exit 1; }
done <<< "$STEPS"
echo "ALL SQL STEPS PASSED (port $PORT)"
