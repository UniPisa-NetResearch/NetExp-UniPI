#!/bin/bash
# res_vtysh_safe - wrapper per vtysh che impedisce modifiche sulla mgmt interface
LOG=/var/log/res_vtysh_safe.log
ARGS="$*"
SUDO_USER="${SUDO_USER:-$USER}"
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE_LOWER="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z')"

# read stdin
FULLCMD="$ARGS
$STDIN_CONTENT"
FULLCMD_LOWER="$(echo "$FULLCMD" | tr 'A-Z' 'a-z')"

# if MGMT_IFACE appears and modifying verb shown -> deny
if [ -n "$MGMT_IFACE_LOWER" ]; then
  if echo "$FULLCMD_LOWER" | grep -qw "$MGMT_IFACE_LOWER"; then
    if echo "$FULLCMD_LOWER" | grep -Eqi '\b(configure|interface|ip address|no shutdown|shutdown|vlan|vrf|dhcp|set|del|add|route|neighbor|ip|address)\b'; then
      echo "$(date -Iseconds) DENY user=$SUDO_USER vtysh args=\"$ARGS\" (mgmt iface referenced with modifying verb)" >> "$LOG"
      echo "Operation that modifies management interface '$MGMT_IFACE' is not permitted." >&2
      exit 1
    fi
  fi
fi

# ALLOW
echo "$(date -Iseconds) ALLOW user=$SUDO_USER vtysh args=\"$ARGS\"" >> "$LOG"
if [ -n "$STDIN_CONTENT" ]; then
  echo "$STDIN_CONTENT" | /usr/bin/vtysh $ARGS
  exit $?
else
  /usr/bin/vtysh $ARGS
  exit $?
fi
