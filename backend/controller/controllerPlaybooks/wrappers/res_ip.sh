#!/bin/bash
# res_ip - wrapper for /usr/bin/ip for reservation users
ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
# read mgmt iface from the configured file; if missing, MGMT_IFACE will be empty
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
# normalize mgmt iface token to lowercase and trim whitespace for reliable comparisons
MGMT_IFACE="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z' | xargs)"
# check if a given path is executable
is_exec() {
  [ -x "$1" ] 2>/dev/null
}

# decide which ip binary to call based on MGMT_IFACE
# some systems place ip in /usr/bin, others in /sbin
IP_BIN=""

if [ -n "$MGMT_IFACE" ]; then
  case "$MGMT_IFACE" in
    eth[0-9]*|ethernet*)
      # if mgmt looks like 'ethX' or 'ethernet*' prefer /usr/bin/ip (common on SONiC)
      if is_exec /usr/bin/ip; then
        IP_BIN="/usr/bin/ip"
      fi
      ;;
    enp*|ens*|enx*|en[0-9]*)
       # if mgmt looks like predictable systemd-style nic names, prefer /sbin/ip (some mini-PCs)
      if is_exec /sbin/ip; then
        IP_BIN="/sbin/ip"
      fi
      ;;
  esac
fi

# determine if the command is a modifying operation by matching verbs
# this is case-insensitive and includes many verbs used with 'ip' that change state
if echo "$ARGS" | grep -Eqi '\b(add|del|replace|set|change|delete|flush|restore|create|route|neighbor|replace|link|addr|netns)\b'; then
  # try to detect an explicit interface using the "dev <iface>"
  IFACE=""
  if echo "$ARGS" | grep -Eq 'dev[[:space:]]+[^[:space:]]+'; then
    # extract the token immediately after 'dev'
    IFACE="$(echo "$ARGS" | sed -n 's/.*dev[[:space:]]\+\([^[:space:]]\+\).*/\1/p')"
  else
    # fallback: scan tokens for common interface name prefixes (case-insensitive)
    # this handles commands that omit 'dev' but include an interface token.
    for tok in $ARGS; do
      lower="$(echo "$tok" | tr 'A-Z' 'a-z')"
      case "$lower" in
        eth*|enp*|ens*|swp*|ethernet*|mgmt*|br-*|bond*|lan*) IFACE="$tok"; break;;
      esac
    done
  fi
  # if we detected an interface token, compare it to MGMT_IFACE
  if [ -n "$IFACE" ]; then
    IFACE_LOWER="$(echo "$IFACE" | tr 'A-Z' 'a-z')"
     # if the operated interface equals the configured management interface -> deny
    if [ -n "$MGMT_IFACE" ] && [ "$IFACE_LOWER" = "$MGMT_IFACE" ]; then
      echo "Operation not permitted on management interface $IFACE" >&2
      exit 1
    fi
  else
    # no interface detected: ambiguous modifying operation
    # FAIL_CLOSED policy: if set to "true", deny ambiguous modifying operations
    FAIL_CLOSED="${FAIL_CLOSED:-false}"
    if [ "$FAIL_CLOSED" = "true" ]; then
      echo "Modifying operation ambiguous; denied by policy" >&2
      exit 1
    fi
    # otherwise allow through below
  fi
fi

# ALLOW call the chosen ip binary with original args
# use command -v unconditionally to get canonical path if possible
IP_CMD="$(command -v ip 2>/dev/null || true)"

# if command -v fails but IP_BIN has a value, use it; otherwise error
if [ -z "$IP_CMD" ] && [ -n "$IP_BIN" ] && [ -x "$IP_BIN" ]; then
  IP_CMD="$IP_BIN"
fi

if [ -z "$IP_CMD" ]; then
  echo "ip binary not found on PATH and no fallback available; aborting." >&2
  exit 127
fi

# Replace the wrapper with the real ip binary, preserving arguments.
exec "$IP_CMD" "$@"