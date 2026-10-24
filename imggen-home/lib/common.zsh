# Shared settings and helpers for the Life OS home-Mac image generation installer (sourced by the .command files).
# Everything lives under PREFIX (~/LifeOS-imggen). Test overrides: LIFEOS_IMGGEN_PREFIX, LIFEOS_IMGGEN_LAUNCH_AGENTS,
# LIFEOS_IMGGEN_NO_LAUNCHD=1 (write plists but never touch launchctl), LIFEOS_IMGGEN_SKIP_MODEL=1 (both models), LIFEOS_IMGGEN_MODEL_URL/_SIZE/_SHA256,
# LIFEOS_IMGGEN_SKIP_PHOTO=1, LIFEOS_IMGGEN_PHOTO_MODEL_URL/_SIZE/_SHA256, LIFEOS_IMGGEN_PHOTO_MARGIN_GB (free space kept after the photo model, default 3).

PREFIX="${LIFEOS_IMGGEN_PREFIX:-$HOME/LifeOS-imggen}"
LA_DIR="${LIFEOS_IMGGEN_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
LABELS=(com.lifeos.imggen-svc com.lifeos.imggen-tunnel com.lifeos.imggen-awake)
SVC_PORT_DEFAULT=8787
VPS_PORT=18787
GIT=/usr/bin/git

# Pinned versions (known-good on the dev MacBook; see imggen-home/constraints.txt for the Python packages).
UV_VERSION=0.12.24
UV_SHA256=0c4346de7abdb49495b393b9ec809fe387aa43e586be20fecb972216c1e71732
PY_VERSION=3.13
COMFY_REPO=https://github.com/comfyanonymous/ComfyUI.git
COMFY_COMMIT=9eaba63e1a9f2b27701cf0a0694aeed777da42f5
MODEL_FILE=animagine-xl-4.0.safetensors
MODEL_URL="${LIFEOS_IMGGEN_MODEL_URL:-https://huggingface.co/cagliostrolab/animagine-xl-4.0/resolve/2b7c1b397761bf5bd3cc42e5b39ec99314a75a96/animagine-xl-4.0.safetensors}"
MODEL_SIZE="${LIFEOS_IMGGEN_MODEL_SIZE:-6938434056}"
MODEL_SHA256="${LIFEOS_IMGGEN_MODEL_SHA256:-1d5b43ff75b6ab598502d4c779d2fbfa3dceca51c60c3b609640a60772333916}"
# Photoreal model (optional; skipped with a message when the disk is short): RealVisXL V5.0 fp16, license openrail++.
PHOTO_MODEL_FILE=RealVisXL_V5.0_fp16.safetensors
PHOTO_MODEL_URL="${LIFEOS_IMGGEN_PHOTO_MODEL_URL:-https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/ac93e0dda1f6d448cae19bbfab8c5e720a5e48bc/RealVisXL_V5.0_fp16.safetensors}"
PHOTO_MODEL_SIZE="${LIFEOS_IMGGEN_PHOTO_MODEL_SIZE:-6938065488}"
PHOTO_MODEL_SHA256="${LIFEOS_IMGGEN_PHOTO_MODEL_SHA256:-6a35a7855770ae9820a3c931d4964c3817b6d9e3c6f9c4dabb5b3a94e5643b80}"

export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export UV_CACHE_DIR="$PREFIX/cache/uv" UV_PYTHON_INSTALL_DIR="$PREFIX/tools/python" UV_PYTHON_BIN_DIR="$PREFIX/tools/bin" UV_TOOL_DIR="$PREFIX/tools/uv-tools" UV_NO_CONFIG=1 UV_PYTHON_PREFERENCE=only-managed

if [[ -t 1 ]]; then C_B=$'\e[1m' C_G=$'\e[32m' C_Y=$'\e[33m' C_R=$'\e[31m' C_D=$'\e[2m' C_0=$'\e[0m'; else C_B= C_G= C_Y= C_R= C_D= C_0=; fi
step() { print -r -- ""; print -r -- "${C_B}[$1]${C_0} $2"; }
info() { print -r -- "  $*"; }
ok()   { print -r -- "  ${C_G}OK${C_0} $*"; }
warn() { print -r -- "  ${C_Y}注意${C_0} $*"; }
fail() { print -r -- "  ${C_R}エラー${C_0} $*" >&2; }
hr()   { print -r -- "${C_D}------------------------------------------------------------${C_0}"; }
# Keeps the Terminal window open after a double-click so the user can read the result.
pause_exit() { local code=${1:-0}; print -r -- ""; if [[ -t 0 && -z "${LIFEOS_IMGGEN_NO_PAUSE:-}" ]]; then print -rn -- "Enter キーで閉じます: "; read -r _ || true; fi; exit $code; }

uid_domain() { print -r -- "gui/$(id -u)"; }
plist_path() { print -r -- "$LA_DIR/$1.plist"; }
agent_loaded() { [[ -z "${LIFEOS_IMGGEN_NO_LAUNCHD:-}" ]] && launchctl print "$(uid_domain)/$1" >/dev/null 2>&1; }
agent_stop() {
  [[ -n "${LIFEOS_IMGGEN_NO_LAUNCHD:-}" ]] && return 0
  launchctl bootout "$(uid_domain)/$1" >/dev/null 2>&1 || launchctl unload "$(plist_path "$1")" >/dev/null 2>&1 || true
  # bootout returns before a slow process (uvicorn) has exited; re-registering too early fails silently.
  local i; for i in {1..30}; do agent_loaded "$1" || return 0; sleep 0.5; done
}
agent_start() {
  [[ -n "${LIFEOS_IMGGEN_NO_LAUNCHD:-}" ]] && { info "（テストのため launchctl は実行しません: $1）"; return 0; }
  launchctl enable "$(uid_domain)/$1" >/dev/null 2>&1 || true
  local i; for i in {1..10}; do
    launchctl bootstrap "$(uid_domain)" "$(plist_path "$1")" >/dev/null 2>&1 || launchctl load -w "$(plist_path "$1")" >/dev/null 2>&1 || true
    agent_loaded "$1" && return 0
    sleep 1
  done
  return 1
}

config_get() { [[ -f "$PREFIX/config.env" ]] || return 0; ( set -a; source "$PREFIX/config.env" >/dev/null 2>&1; print -r -- "${(P)1:-}" ) }
svc_port() { local p; p=$(config_get IMGGEN_PORT); print -r -- "${p:-$SVC_PORT_DEFAULT}"; }
# GET /v1/health with the bearer token; prints "HTTP-status body".
health() {
  local tok out; tok=$(config_get IMGGEN_TOKEN)
  [[ -n "$tok" ]] || { print -r -- "000 IMGGEN_TOKEN 未設定"; return 0; }
  # Token goes through curl's stdin config, not argv (other users could read it from ps).
  out=$(curl -s -m 5 -w $'\n%{http_code}' -K - "http://127.0.0.1:$(svc_port)/v1/health" <<<"header = \"Authorization: Bearer $tok\"" 2>/dev/null) || true
  [[ "$out" == *$'\n'* ]] || out=$'\n000'
  print -r -- "${out##*$'\n'} ${out%$'\n'*}"
}
free_gb() { df -g "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
free_mb() { df -m "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
# Model state for the status check: "ok <MB>" | "part <MB>" | "none".
model_state() {
  local m="$PREFIX/models/checkpoints/$1"
  if [[ -f "$m" && -f "$m.verified" ]]; then print -r -- "ok $(( $(stat -f %z "$m") / 1048576 ))"
  elif [[ -f "$m.part" ]]; then print -r -- "part $(( $(stat -f %z "$m.part") / 1048576 ))"
  else print -r -- "none"; fi
}
