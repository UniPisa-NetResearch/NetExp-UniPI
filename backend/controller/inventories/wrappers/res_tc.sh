#!/bin/bash
# res_tc - wrapper per /sbin/tc
LOG=/var/log/res_tc.log
ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
MMGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z' | xargs)"
ARGS="$*"

# detect dev <iface>
IFACE=""
if echo "$ARGS" | grep -Eq 'dev[[:space:]]+[^[:space:]]+'; then
  IFACE="$(echo "$ARGS" | sed -n 's/.*dev[[:space:]]\+\([^[:space:]]\+\).*/\1/p')"
else
  # fallback token scan
  for tok in $ARGS; do
    lower="$(echo "$tok" | tr 'A-Z' 'a-z')"
    case "$lower" in
      eth*|enp*|ens*|swp*|ethernet*|mgmt*|br-*|bond*) IFACE="$tok"; break;;
    esac
  done
fi

# modifying detection
if echo "$ARGS" | grep -Eqi '\b(add|change|replace|del|delete|replace|replace|replace)\b'; then
  if [ -n "$IFACE" ]; then
    IFACE_LOWER="$(echo "$IFACE" | tr 'A-Z' 'a-z')"
    if [ -n "$MGMT_IFACE" ] && [ "$IFACE_LOWER" = "$MGMT_IFACE" ]; then
      echo "$(date -Iseconds) DENY user=$SUDO_USER tc args=\"$ARGS\" iface=\"$IFACE\" (mgmt)" >> "$LOG"
      echo "Operation not permitted on management interface $IFACE" >&2
      exit 1
    fi
  else
    FAIL_CLOSED="${FAIL_CLOSED:-false}"
    if [ "$FAIL_CLOSED" = "true" ]; then
      echo "$(date -Iseconds) DENY user=$SUDO_USER tc args=\"$ARGS\" iface=\"(unknown)\" (ambiguous)" >> "$LOG"
      echo "Modifying operation ambiguous; denied by policy" >&2
      exit 1
    fi
  fi
fi

echo "$(date -Iseconds) ALLOW user=$SUDO_USER tc args=\"$ARGS\"" >> "$LOG"
/sbin/tc "$@"
exit $?
