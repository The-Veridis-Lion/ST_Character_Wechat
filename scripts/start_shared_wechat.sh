#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ST_CHARACTER_WECHAT_SHARED_PORT:-8765}"
STATE_DIR="${ST_CHARACTER_WECHAT_STATE_DIR:-$HOME/.st-character-wechat}"
LOG_DIR="${STATE_DIR}/logs"
PID_FILE="${LOG_DIR}/shared-wechat.pid"

function resolve_pid_cwd() {
  local pid="$1"
  lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

function list_bridge_processes() {
  ps -ax -o pid=,ppid=,command= | awk '/node \.\/bin\/st-character-wechat\.js start --checkin/ { print }'
}

function find_bridge_child_pid() {
  local parent_pid="$1"
  list_bridge_processes | awk -v target_ppid="${parent_pid}" '$2 == target_ppid { print $1; exit }'
}

function resolve_bridge_pid() {
  local candidate_pid="$1"
  [[ -n "${candidate_pid}" ]] || return 1
  if ! kill -0 "${candidate_pid}" 2>/dev/null; then
    return 1
  fi

  local child_pid
  child_pid="$(find_bridge_child_pid "${candidate_pid}")"
  if [[ -n "${child_pid}" ]]; then
    echo "${child_pid}"
    return 0
  fi

  if [[ "$(resolve_pid_cwd "${candidate_pid}")" == "${ROOT_DIR}" ]]; then
    echo "${candidate_pid}"
    return 0
  fi

  return 1
}

function find_existing_bridge_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid_from_file
    pid_from_file="$(cat "${PID_FILE}" 2>/dev/null || true)"
    local resolved_from_file
    resolved_from_file="$(resolve_bridge_pid "${pid_from_file}" || true)"
    if [[ -n "${resolved_from_file}" ]]; then
      echo "${resolved_from_file}"
      return 0
    fi
  fi

  local pid
  while read -r pid _; do
    [[ -n "${pid}" ]] || continue
    if [[ "$(resolve_pid_cwd "${pid}")" == "${ROOT_DIR}" ]]; then
      echo "${pid}"
      return 0
    fi
  done < <(list_bridge_processes)

  return 1
}

function cleanup_pid_file() {
  if [[ -f "${PID_FILE}" ]]; then
    local current_pid
    current_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ "${current_pid}" == "$$" ]]; then
      rm -f "${PID_FILE}"
    fi
  fi
}

"${ROOT_DIR}/scripts/start_shared_app_server.sh"
mkdir -p "${LOG_DIR}"

EXISTING_PID="$(find_existing_bridge_pid || true)"
if [[ -n "${EXISTING_PID}" ]]; then
  echo "${EXISTING_PID}" > "${PID_FILE}"
  echo "shared st-character-wechat already running pid=${EXISTING_PID}"
  exit 0
fi

BRIDGE_PID=""
function shutdown_bridge() {
  if [[ -n "${BRIDGE_PID}" ]] && kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    kill "${BRIDGE_PID}" 2>/dev/null || true
  fi
  cleanup_pid_file
}

trap shutdown_bridge EXIT INT TERM
cd "${ROOT_DIR}"
export ST_CHARACTER_WECHAT_CODEX_ENDPOINT="ws://127.0.0.1:${PORT}"
node ./bin/st-character-wechat.js start --checkin &
BRIDGE_PID="$!"
echo "${BRIDGE_PID}" > "${PID_FILE}"
wait "${BRIDGE_PID}"
