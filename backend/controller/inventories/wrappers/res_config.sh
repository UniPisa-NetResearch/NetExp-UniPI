#!/bin/bash
# res_config_sonic - wrapper che invoca 'config' dentro SONiC ma blocca modifiche sulla mgmt iface
LOG=/var/log/res_config_sonic.log
ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE_LOWER="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z')"
ARGS_LOWER="$(echo "$ARGS" | tr 'A-Z' 'a-z')"

# detect iface token (token scan)
IFACE=""
for tok in $ARGS; do
  lower="$(echo "$tok" | tr 'A-Z' 'a-z')"
  case "$lower" in
    eth*|enp*|ens*|swp*|ethernet*|mgmt*|br-*) IFACE="$tok"; break;;
  esac
done
IFACE_LOWER="$(echo "$IFACE" | tr 'A-Z' 'a-z')"

# if modifying verbs and iface equals mgmt -> deny
if echo "$ARGS_LOWER" | grep -Eqi '\b(add|del|set|change|create|delete|vlan|dhcp|ip|vrf|route|neighbor)\b'; then
  if [ -n "$IFACE_LOWER" ] && [ -n "$MGMT_IFACE_LOWER" ] && [ "$IFACE_LOWER" = "$MGMT_IFACE_LOWER" ]; then
    echo "$(date -Iseconds) DENY user=$SUDO_USER config args=\"$ARGS\" iface=\"$IFACE\" (mgmt)" >> "$LOG"
    echo "Operation not permitted on management interface $IFACE" >&2
    exit 1
  else
    FAIL_CLOSED="${FAIL_CLOSED:-false}"
    if [ "$FAIL_CLOSED" = "true" ]; then
      echo "$(date -Iseconds) DENY user=$SUDO_USER config args=\"$ARGS\" iface=\"(unknown)\" (ambiguous)" >> "$LOG"
      echo "Modifying operation ambiguous; denied by policy" >&2
      exit 1
    fi
  fi
fi

echo "$(date -Iseconds) ALLOW user=$SUDO_USER config args=\"$ARGS\"" >> "$LOG"
/usr/local/bin/config "$@"
exit $?

