#!/bin/bash
# res_ip - wrapper per /usr/bin/ip
LOG=/var/log/res_ip.log
ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
# Read mgmt iface
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z' | xargs)"

# modifying verbs heuristics (case-insensitive)
if echo "$ARGS" | grep -Eqi '\b(add|del|replace|set|change|delete|flush|restore|create|route|neighbor|replace|link|addr|netns)\b'; then
  # try 'dev <iface>'
  IFACE=""
  if echo "$ARGS" | grep -Eq 'dev[[:space:]]+[^[:space:]]+'; then
    IFACE="$(echo "$ARGS" | sed -n 's/.*dev[[:space:]]\+\([^[:space:]]\+\).*/\1/p')"
  else
    # fallback token scan (case-insensitive)
    for tok in $ARGS; do
      lower="$(echo "$tok" | tr 'A-Z' 'a-z')"
      case "$lower" in
        eth*|enp*|ens*|swp*|ethernet*|mgmt*|br-*|bond*|lan*) IFACE="$tok"; break;;
      esac
    done
  fi

  if [ -n "$IFACE" ]; then
    IFACE_LOWER="$(echo "$IFACE" | tr 'A-Z' 'a-z')"
    if [ -n "$MGMT_IFACE" ] && [ "$IFACE_LOWER" = "$MGMT_IFACE" ]; then
      echo "$(date -Iseconds) DENY user=$SUDO_USER ip args=\"$ARGS\" iface=\"$IFACE\" (mgmt)" >> "$LOG"
      echo "Operation not permitted on management interface $IFACE" >&2
      exit 1
    fi
  else
    # ambiguous: choose policy
    FAIL_CLOSED="${FAIL_CLOSED:-false}"
    if [ "$FAIL_CLOSED" = "true" ]; then
      echo "$(date -Iseconds) DENY user=$SUDO_USER ip args=\"$ARGS\" iface=\"(unknown)\" (ambiguous)" >> "$LOG"
      echo "Modifying operation ambiguous; denied by policy" >&2
      exit 1
    fi
  fi
fi

# ALLOW
echo "$(date -Iseconds) ALLOW user=$SUDO_USER ip args=\"$ARGS\"" >> "$LOG"
/usr/bin/ip "$@"
exit $?

