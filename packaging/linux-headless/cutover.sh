#!/usr/bin/env bash
# Switch a Linux host from the Electron desktop unit to the headless server unit, verify it,
# and roll back to the desktop unit automatically if anything fails.
#
#   cutover.sh run [--force]   cut over (--force skips waiting for running turns)
#   cutover.sh rollback        go back to the desktop unit now
#
# Run it detached from T3, because stopping the desktop unit ends every agent:
#   systemd-run --user --unit=t3-headless-cutover --collect <dir>/cutover.sh run
#
# Defaults match a host whose desktop unit is t3code-production.service; override with the
# CUTOVER_* variables below (the trial run uses a stand-in unit and another port).
# See docs/operations/headless-linux.md.
set -uo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
prod_unit="${CUTOVER_PROD_UNIT:-t3code-production.service}"
headless_unit="${CUTOVER_HEADLESS_UNIT:-t3code-headless.service}"
gateway_unit="${CUTOVER_GATEWAY_UNIT:-t3-mcp-gateway.service}"
port="${CUTOVER_PORT:-3773}"
t3_home="${CUTOVER_T3_HOME:-$HOME/.t3}"
root="${CUTOVER_HEADLESS_ROOT:-$HOME/.local/opt/t3code-headless}"
version="${CUTOVER_VERSION:-}" # empty: newest nightly
# The Tailscale Serve HTTPS route that remote clients use.
tailnet_url="${CUTOVER_TAILNET_URL:-https://$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')/}"
# Units the desktop app can leave holding the port after its unit stops.
stale_scope_glob="${CUTOVER_STALE_SCOPE_GLOB:-app-com.jayleaton.t3agents-*.scope}"
# Extra EnvironmentFile for the headless server's gateway runtime. Empty in production: the
# server reads the bridge token from ~/.config/t3code/mcp-gateway.env itself.
server_gateway_env="${CUTOVER_SERVER_GATEWAY_ENV:-}"
idle_wait="${CUTOVER_IDLE_WAIT:-1800}"
budget="${CUTOVER_HEALTH_BUDGET:-120}"
report_dir="${CUTOVER_REPORT_DIR:-$HOME/.local/state/t3-captain}"
# The desktop extraction; its gateway launcher answers health checks after a rollback.
desktop_app="${CUTOVER_DESKTOP_APP:-$HOME/.local/opt/t3code/squashfs-root}"
units_dir="$HOME/.config/systemd/user"
gateway_dropin="$units_dir/$gateway_unit.d/60-headless.conf"
headless_dropin="$units_dir/$headless_unit.d/50-gateway.conf"

mkdir -p "$report_dir"
report="$report_dir/cutover-$(date +%Y%m%d-%H%M%S).txt"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$report" >&2; }
finish() { log "RESULT: $1"; echo "report: $report" >&2; exit "$2"; }
sctl() { systemctl --user "$@" 2>&1 | tee -a "$report" >&2; return "${PIPESTATUS[0]}"; }

listener_pid() { ss -H -ltnp "sport = :$port" | grep -oE 'pid=[0-9]+' | head -n 1 | cut -d= -f2; }
unit_of_pid() { sed -n 's#^0::.*/##p' "/proc/$1/cgroup" 2>/dev/null; }
descriptor() { curl -fsS -m 3 "http://127.0.0.1:$port/.well-known/t3/environment" 2>/dev/null; }

wait_port_free() {
  local seconds="$1"
  for _ in $(seq "$seconds"); do
    [[ -z "$(listener_pid)" ]] && return 0
    sleep 1
  done
  return 1
}

# A desktop main process moves itself into its own scope, so stopping its unit can leave the
# backend holding the port and the userdata lock. Stop exactly the scope that owns the listener.
free_port() {
  wait_port_free 30 && return 0
  local pid scope
  pid="$(listener_pid)"
  scope="$(unit_of_pid "$pid")"
  # shellcheck disable=SC2053 # the glob is intentional
  if [[ -n "$scope" && "$scope" == $stale_scope_glob ]]; then
    log "port $port still held by pid $pid in $scope; stopping that scope"
    sctl stop "$scope"
    wait_port_free 30 && return 0
  fi
  log "port $port still held by pid $pid ($scope)"
  return 1
}

# Running turns end when the server stops. Waiting on a person (an approval or question) is not
# running, but its pending request is closed by the restart, so those threads are reported.
busy_threads() {
  local token shell
  token="$("$root/bin/t3" auth session issue --base-dir "$t3_home" --scope orchestration:read \
    --ttl 5m --label cutover-idle-check --token-only 2>/dev/null)" || return 2
  shell="$(curl -fsS -m 10 -H "Authorization: Bearer $token" -H "x-t3-orchestration-protocol: 2" \
    "http://127.0.0.1:$port/api/orchestration/shell")" || return 2
  jq -r '.threads[] | (.activityRunStatus // .status) as $s
    | select(($s | IN("preparing","queued","starting","running"))
             or ($s == "waiting" and .pendingRuntimeRequest == null))
    | "\(.id) \($s) \(.title)"' <<<"$shell"
  jq -r '.threads[] | select(.pendingRuntimeRequest != null)
    | "waiting on a person (request will be closed): \(.id) \(.title)"' <<<"$shell" >>"$report"
}

wait_idle() {
  local deadline=$((SECONDS + idle_wait)) busy rc
  while true; do
    busy="$(busy_threads)"
    rc=$?
    if [[ $rc -eq 2 ]]; then
      log "could not read thread state from :$port"
      return 1
    fi
    [[ -z "$busy" ]] && { log "no running turns"; return 0; }
    if ((SECONDS >= deadline)); then
      log "turns still running after ${idle_wait}s:"; sed 's/^/  /' <<<"$busy" | tee -a "$report" >&2
      return 1
    fi
    log "waiting for $(wc -l <<<"$busy") running turn(s)"
    sleep 15
  done
}

# The gateway launcher reads the bridge port, token and store from the gateway unit's environment.
gateway_call() {
  local app="$1" env_files
  env_files="$(systemctl --user show -p EnvironmentFiles --value "$gateway_unit" | sed -E 's/ \(ignore_errors=(yes|no)\)//')"
  (
    set -a
    for file in $env_files; do [[ -r "$file" ]] && . "$file"; done
    # shellcheck disable=SC2046 # word splitting of KEY=VALUE pairs is intended
    export $(systemctl --user show -p Environment --value "$gateway_unit") T3CODE_HOME="$t3_home"
    ELECTRON_RUN_AS_NODE=1 "$app/t3code" "$src/t3-gateway-call.mjs" \
      "$app/resources/t3-mcp-gateway.mjs" t3_get_gateway_health '{}'
  )
}

# One pass over every check; prints the failures. $1 = expected version, $2 = epoch of the start,
# $3 = unit that must own the listener, $4 = app dir whose gateway launcher to use.
check_once() {
  local expected="$1" since="$2" owner_unit="$3" app="$4" failures=() pid where desc env_id health wal
  pid="$(listener_pid)"
  where="$(unit_of_pid "$pid")"
  if ! ss -H -ltn "sport = :$port" | grep -q "0.0.0.0:$port"; then
    failures+=("not listening on 0.0.0.0:$port")
  # shellcheck disable=SC2053 # a desktop backend runs in the scope its main process moved to
  elif [[ "$where" != "$owner_unit" ]] && ! [[ "$owner_unit" == "$prod_unit" && "$where" == $stale_scope_glob ]]; then
    failures+=("listener pid $pid is in $where, not $owner_unit")
  fi
  desc="$(descriptor)"
  env_id="$(jq -r '.environmentId // empty' <<<"$desc" 2>/dev/null)"
  [[ -n "$expected" && "$(jq -r '.serverVersion // empty' <<<"$desc" 2>/dev/null)" != "$expected" ]] &&
    failures+=("version is '$(jq -r '.serverVersion // "none"' <<<"$desc" 2>/dev/null)', expected $expected")
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$tailnet_url")" == 200 ]] ||
    failures+=("$tailnet_url did not return 200")
  health="$(gateway_call "$app" 2>/dev/null)"
  if [[ "$(jq -r '.data.bridge // empty' <<<"$health" 2>/dev/null)" != connected ]] ||
    [[ -z "$env_id" ]] ||
    ! jq -e --arg id "$env_id" '.data.latestSequenceByEnvironment | has($id)' <<<"$health" >/dev/null 2>&1; then
    failures+=("gateway has no connected runtime for environment ${env_id:-?}")
  fi
  wal="$(stat -c %Y "$t3_home/userdata/statev2.sqlite-wal" 2>/dev/null || echo 0)"
  ((wal >= since)) || failures+=("WAL not written since start")
  printf '%s\n' "${failures[@]}"
}

health_checks() {
  local deadline=$((SECONDS + budget)) failures
  while true; do
    failures="$(check_once "$@")"
    if [[ -z "$failures" ]]; then
      log "health: all checks pass (version ${1:-any}, :$port on 0.0.0.0, $tailnet_url 200, gateway runtime connected, WAL written)"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      log "health: failing after ${budget}s:"; sed 's/^/  /' <<<"$failures" | tee -a "$report" >&2
      return 1
    fi
    sleep 3
  done
}

rollback() {
  log "rolling back to $prod_unit"
  sctl disable --now "$headless_unit"
  wait_port_free 30 || free_port || log "port $port is still held; starting $prod_unit anyway"
  rm -f "$gateway_dropin"
  sctl daemon-reload
  sctl restart "$gateway_unit"
  local started=$(( $(date +%s) - 1 ))
  sctl enable --now "$prod_unit"
  health_checks "${pre_version:-}" "$started" "$prod_unit" "$desktop_app"
}

render_unit() {
  sed -e "s#%h/.local/opt/t3code-headless#$root#g" \
    -e "s#^Environment=T3CODE_HOME=.*#Environment=T3CODE_HOME=$t3_home#" \
    -e "s#^Environment=T3CODE_PORT=.*#Environment=T3CODE_PORT=$port#" \
    "$src/t3code-headless.service"
}

install_headless() {
  install -Dm755 "$src/t3-headless-update" "$HOME/.local/bin/t3-headless-update"
  render_unit >"$units_dir/$headless_unit"
  mkdir -p "$(dirname "$headless_dropin")"
  {
    echo "[Service]"
    echo "# Host the T3 Agents gateway runtime that the desktop app used to provide."
    echo "Environment=T3_MCP_HEADLESS_GATEWAY=1"
    [[ -n "$server_gateway_env" ]] && echo "EnvironmentFile=$server_gateway_env"
  } >"$headless_dropin"
  sctl daemon-reload
  sctl disable --now "$headless_unit" >/dev/null 2>&1
  T3_HEADLESS_ROOT="$root" T3_HEADLESS_UNIT="$headless_unit" \
    "$HOME/.local/bin/t3-headless-update" ${version:+install "$version"} 2>&1 | tee -a "$report" >&2
  [[ -x "$root/current/t3code" ]] || return 1
  version="$(basename "$(readlink "$root/current")")"
  log "headless release $version installed in $root"
}

switch_gateway() {
  mkdir -p "$(dirname "$gateway_dropin")"
  cat >"$gateway_dropin" <<EOF
# Written by cutover.sh: run the gateway from the headless release. Delete to go back.
[Service]
ExecStart=
ExecStart=/bin/bash -c 'app=\$\$(readlink -f "\$\$0") && exec "\$\$app/t3code" "\$\$app/resources/t3-mcp-gateway.mjs" < <(exec tail -f /dev/null)' $root/current
EOF
  sctl daemon-reload
  sctl restart "$gateway_unit"
}

case "${1:-}" in
  run)
    force=false
    [[ "${2:-}" == --force ]] && force=true
    log "cutover: $prod_unit -> $headless_unit on :$port, T3 home $t3_home"
    pre_version="$(descriptor | jq -r '.serverVersion // empty' 2>/dev/null)"
    log "running now: ${pre_version:-nothing on :$port}"
    install_headless || finish "FAILED before any change: headless release did not install" 1
    if $force; then
      log "--force: not waiting for running turns"
    elif [[ -n "$pre_version" ]]; then
      wait_idle || finish "ABORTED before any change: turns still running (rerun with --force to skip)" 3
    fi
    sctl disable --now "$prod_unit"
    if ! free_port; then
      rollback && finish "ROLLED BACK: port $port did not free up" 1
      finish "ROLLBACK FAILED: port $port did not free up; check $prod_unit by hand" 2
    fi
    switch_gateway
    started=$(( $(date +%s) - 1 ))
    sctl enable --now "$headless_unit"
    if health_checks "$version" "$started" "$headless_unit" "$root/current"; then
      finish "CUTOVER OK: $headless_unit serves $version on :$port" 0
    fi
    rollback && finish "ROLLED BACK: headless health checks failed; $prod_unit is healthy again" 1
    finish "ROLLBACK FAILED: $prod_unit did not pass health checks either" 2
    ;;
  rollback)
    pre_version=""
    rollback && finish "ROLLED BACK by request; $prod_unit is healthy" 0
    finish "ROLLBACK FAILED: $prod_unit did not pass health checks" 2
    ;;
  *)
    echo "usage: cutover.sh run [--force] | rollback" >&2
    exit 64
    ;;
esac
