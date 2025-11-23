#!/bin/bash
# res_config_sonic - wrapper for 'config' in SONiC for reservation users
ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
# read mgmt iface and normalize to lowercase for comparisons
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE_LOWER="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z')"
# create a lowercase version of ARGS to ease regex/case-insensitive matching
ARGS_LOWER="$(echo "$ARGS" | tr 'A-Z' 'a-z')"

# detect interface token
IFACE=""
for tok in $ARGS; do
  lower="$(echo "$tok" | tr 'A-Z' 'a-z')"
  case "$lower" in
    eth*|enp*|ens*|swp*|ethernet*|mgmt*|br-*) IFACE="$tok"; break;;
  esac
done
# normalize detected interface token to lowercase for comparison
IFACE_LOWER="$(echo "$IFACE" | tr 'A-Z' 'a-z')"

# if the args contain modifying verbs, and the extracted iface equals mgmt -> deny
if echo "$ARGS_LOWER" | grep -Eqi '\b(add|del|set|change|create|delete|vlan|dhcp|ip|vrf|route|neighbor)\b'; then
  # if an interface was detected and it matches mgmt, deny the operation
  if [ -n "$IFACE_LOWER" ] && [ -n "$MGMT_IFACE_LOWER" ] && [ "$IFACE_LOWER" = "$MGMT_IFACE_LOWER" ]; then
    echo "Operation not permitted on management interface $IFACE" >&2
    exit 1
  else
    # no matching interface was found or it is not mgmt: ambiguous modifying action
    FAIL_CLOSED="${FAIL_CLOSED:-false}"
    if [ "$FAIL_CLOSED" = "true" ]; then
      echo "Modifying operation ambiguous; denied by policy" >&2
      exit 1
    fi
     # otherwise allow to proceed below
  fi
fi
# The operation is allowed, forward all args to the SONiC config command
# use command -v to get canonical path if possible
CONFIG_CMD="$(command -v config 2>/dev/null || true)"

# if command -v didn't find config, fail with informative message
if [ -z "$CONFIG_CMD" ]; then
  echo "config binary not found on PATH; aborting." >&2
  exit 127
fi

# exec the resolved config binary with original args
exec "$CONFIG_CMD" "$@"