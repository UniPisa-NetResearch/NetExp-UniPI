#!/bin/bash
# res_tc - wrapper for /sbin/tc for reservation user

ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
# read management interface name from the configured file, normalize to lowercase
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z' | xargs)"
ARGS="$*"

# try to detect an explicit 'dev <iface>' argument first (common in tc commands)
IFACE=""
if echo "$ARGS" | grep -Eq '(^|[[:space:]])dev[[:space:]]+[^[:space:]]+'; then
  # if 'dev <iface>' found, extract the iface token following 'dev'
  IFACE="$(echo "$ARGS" | sed -n 's/.*\(^\|[[:space:]]\)dev[[:space:]]\+\([^[:space:]]\+\).*/\2/p')"
else
  # otherwise, perform a token-scan arguments for possible interface tokens (case-insensitive)
  # this handles commands that omit the 'dev' keyword but include an interface token
  for tok in $ARGS; do
    lower="$(echo "$tok" | tr 'A-Z' 'a-z')"
    case "$lower" in
      eth*|enp*|ens*|swp*|ethernet*|mgmt*|br-*|bond*|lan*) IFACE="$tok"; break;;
    esac
  done
fi

# check for words that typically indicate a modifying tc action
# the regex is case-insensitive and includes many common verbs/names used with tc
if echo "$ARGS" | grep -Eqi '\b(add|change|replace|del|delete|filter|qdisc|class|ingress|egress|replace|delete|set)\b'; then
  # if it is a modifying operation, check the interface
  if [ -n "$IFACE" ]; then
    # normalize the detected iface to lowercase for comparison with MGMT_IFACE
    IFACE_LOWER="$(echo "$IFACE" | tr 'A-Z' 'a-z')"
    # if we have a configured management interface and the operation targets it -> deny
    if [ -n "$MGMT_IFACE" ] && [ "$IFACE_LOWER" = "$MGMT_IFACE" ]; then
      echo "Operation not permitted on management interface $IFACE" >&2
      exit 1
    fi
  else
    # no interface could be detected -> ambiguous modifying operation
    # if FAIL_CLOSED is set to "true", deny ambiguous modifying operations
    FAIL_CLOSED="${FAIL_CLOSED:-false}"
    if [ "$FAIL_CLOSED" = "true" ]; then
      echo "Modifying operation ambiguous; denied by policy" >&2
      exit 1
    fi
    # otherwise (fail-open), allow the command to proceed below
  fi
fi

# use command -v to ind tc binary and exec
TC_CMD="$(command -v tc 2>/dev/null || true)"
if [ -z "$TC_CMD" ]; then
  # no tc on PATH -> abort with helpful message
  echo "tc binary not found on PATH; aborting." >&2
  exit 127
fi

# execute real tc
exec "$TC_CMD" "$@"