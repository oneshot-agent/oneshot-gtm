#!/usr/bin/env bash
#
# Safely stop (and optionally restart) the oneshot-gtm dashboard server,
# WAITING for any in-flight email sends to finish first so a restart never
# severs a send mid-delivery.
#
# Why: a hard SIGTERM mid-send makes the server wait out its 30s drain and then
# force-exit, stranding the send (boot sweep + idempotency keys reconcile it,
# but it's avoidable noise). This guard polls the live in-flight count from
# GET /api/health — the same in-memory counter the drain reads — and only kills
# once it hits 0 (or after MAX_WAIT, which aborts unless FORCE=1).
#
# Usage:
#   scripts/safe-restart.sh                 # safe-stop the server on :3030
#   scripts/safe-restart.sh -- <cmd...>     # safe-stop, then run <cmd> to relaunch
#   PORT=3099 scripts/safe-restart.sh       # different port
#   MAX_WAIT=180 scripts/safe-restart.sh    # wait longer for slow sends
#   FORCE=1 scripts/safe-restart.sh         # kill even if sends never drain
#
set -euo pipefail

PORT="${PORT:-3030}"
HOSTHDR="127.0.0.1:${PORT}"
MAX_WAIT="${MAX_WAIT:-120}" # a single send can take up to ~90s
FORCE="${FORCE:-0}"

# Everything after `--` is the relaunch command (optional).
RELAUNCH=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; RELAUNCH=("$@"); break; fi
  shift
done

inflight() {
  # Prints the in-flight send count, or empty string if /api/health is unreachable.
  curl -fs "http://${HOSTHDR}/api/health" -H "host: ${HOSTHDR}" 2>/dev/null \
    | grep -o '"inFlightSends":[0-9]*' | grep -o '[0-9]*$' || true
}

pid="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -z "${pid}" ]; then
  echo "no server listening on :${PORT} — nothing to stop"
else
  # --- The guard: wait for in-flight sends to drain before killing. ---
  waited=0
  while :; do
    n="$(inflight)"
    if [ -z "${n}" ]; then
      echo "health endpoint unreachable — can't read in-flight count; assuming idle"
      break
    fi
    if [ "${n}" -eq 0 ]; then
      echo "no sends in flight — safe to stop"
      break
    fi
    if [ "${waited}" -ge "${MAX_WAIT}" ]; then
      if [ "${FORCE}" = "1" ]; then
        echo "WARN: ${n} send(s) still in flight after ${MAX_WAIT}s — FORCE=1, proceeding anyway"
        break
      fi
      echo "ABORT: ${n} send(s) still in flight after ${MAX_WAIT}s — not killing."
      echo "       Re-run with FORCE=1 to override, or wait and retry."
      exit 1
    fi
    echo "waiting on ${n} in-flight send(s)... (${waited}s/${MAX_WAIT}s)"
    sleep 2
    waited=$((waited + 2))
  done

  echo "stopping server (pid ${pid})..."
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in $(seq 1 80); do
    if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
      sleep 0.5
    else
      echo "port ${PORT} free"
      break
    fi
  done
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "WARN: port ${PORT} still bound after ~40s"
    exit 1
  fi
fi

if [ "${#RELAUNCH[@]}" -gt 0 ]; then
  echo "relaunching: ${RELAUNCH[*]}"
  exec "${RELAUNCH[@]}"
fi
