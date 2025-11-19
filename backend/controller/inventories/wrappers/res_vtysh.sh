#!/bin/bash
# res_vtysh - wrapper for vtysh to allow only non-interactive usage and
#             to prevent modification of the management interface.
LOG="/var/log/res_vtysh.log"
SUDO_USER="${SUDO_USER:-$USER}"
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z' | xargs)"   # normalize

log() {
  echo "$(date -Iseconds) $1" >> "$LOG"
}

# Collect -c/--command arguments into arrays suitable to pass to vtysh and to analyse.
VTY_ARGS=()      # full args to forward to vtysh, e.g. (-c "configure terminal" -c "interface eth2" ...)
CMD_PARTS=()     # just the command strings (without -c) for parsing/inspection

while [ "$#" -gt 0 ]; do
  case "$1" in
    -c|--command)
      shift
      # If -c provided but no following arg, treat as empty (will be denied)
      ARG="${1:-}"
      VTY_ARGS+=(-c "$ARG")
      CMD_PARTS+=("$ARG")
      shift || true
      ;;
    --)
      shift
      # ignore remaining positional args (vtysh supports only -c typically)
      break
      ;;
    *)
      # ignore other args: we only honor -c/--command for safety
      shift
      ;;
  esac
done

# 1) Deny interactive use: require at least one -c argument.
if [ "${#VTY_ARGS[@]}" -eq 0 ]; then
  # If user piped commands via stdin, still deny: we only accept explicit -c inline usage.
  log "DENY user=$SUDO_USER vtysh reason=\"interactive or no -c provided\""
  echo "Interactive use of vtysh is disallowed. Please run non-interactive commands, e.g.:"
  echo "  sudo res_vtysh -c \"show interface <iface>\""
  echo "  sudo res_vtysh -c 'configure terminal' -c 'interface eth2' -c 'ip address 10.0.0.1/24' -c 'no shutdown'"
  exit 1
fi

# Build a single joined command string for easier searching (lowercased for comparisons)
JOINED_CMD="$(printf '%s; ' "${CMD_PARTS[@]}" | sed 's/; $//')"
CMD_LOWER="$(printf '%s' "$JOINED_CMD" | tr 'A-Z' 'a-z' | xargs)"

# Helper predicates
is_show_cmd() {
  # return 0 if any part contains a 'show' command word
  echo "$CMD_LOWER" | grep -Eiq '\bshow\b' && return 0 || return 1
}

references_mgmt_iface() {
  [ -n "$MGMT_IFACE" ] && echo "$CMD_LOWER" | grep -wq "$MGMT_IFACE"
  return $?
}

# detect configure-like sequences (words that typically indicate modifying intent)
has_configure() {
  echo "$CMD_LOWER" | grep -Eiq '\bconfigure\b' && return 0 || return 1
}

# Extract first interface token after the word 'interface' in the joined commands.
# Returns lowercase interface token or empty string.
extract_interface_from_joined() {
  # Match: ... interface <token> ...
  echo "$JOINED_CMD" | sed -n 's/.*[[:space:];]interface[[:space:]]\+\([^[:space:];]\+\).*/\1/p' \
    | tr 'A-Z' 'a-z' | xargs
}

# Main decision flow:

# If the joined command references the management interface:
if references_mgmt_iface; then
  # Allow any read-only 'show' command referencing mgmt iface
  if is_show_cmd; then
    log "ALLOW user=$SUDO_USER vtysh args=\"$JOINED_CMD\" reason=\"show on mgmt iface\""
    exec /usr/bin/vtysh "${VTY_ARGS[@]}"
  fi

  # If it's not a show (i.e. a modifying operation referencing mgmt) -> deny
  log "DENY user=$SUDO_USER vtysh args=\"$JOINED_CMD\" iface=\"$MGMT_IFACE\" reason=\"modifying mgmt iface or non-show referencing mgmt\""
  echo "Operation not permitted on management interface $MGMT_IFACE"
  exit 1
fi

# At this point mgmt iface is NOT referenced.

# If the sequence includes a configure request, require an explicit interface target.
if has_configure; then
  TARGET_IF="$(extract_interface_from_joined)"
  if [ -z "$TARGET_IF" ]; then
    # configure present but no explicit interface -> deny to avoid interactive config mode
    log "DENY user=$SUDO_USER vtysh args=\"$JOINED_CMD\" reason=\"configure with no explicit interface (would open config mode)\""
    echo "Entering configuration mode is disallowed. Please run specific non-interactive commands that include the target interface, e.g.:"
    echo "  sudo res_vtysh -c 'configure terminal' -c 'interface eth2' -c 'ip address 10.0.0.1/24' -c 'no shutdown'"
    exit 1
  fi

  # If extracted interface is equal to mgmt (shouldn't happen because references_mgmt_iface earlier returned false),
  # reject to be safe.
  if [ -n "$MGMT_IFACE" ] && [ "$TARGET_IF" = "$MGMT_IFACE" ]; then
    log "DENY user=$SUDO_USER vtysh args=\"$JOINED_CMD\" iface=\"$TARGET_IF\" reason=\"attempt to configure mgmt iface (safety)\""
    echo "Operation not permitted on management interface $MGMT_IFACE"
    exit 1
  fi

  # Otherwise allow the non-interactive configure sequence that targets a concrete non-mgmt interface
  log "ALLOW user=$SUDO_USER vtysh args=\"$JOINED_CMD\" reason=\"configure on non-mgmt iface $TARGET_IF\""
  exec /usr/bin/vtysh "${VTY_ARGS[@]}"
fi

# Default: no mgmt referenced and not a riskful configure sequence -> allow (covers show and other read-only commands)
log "ALLOW user=$SUDO_USER vtysh args=\"$JOINED_CMD\" reason=\"no mgmt iface referenced and not configure without target\""
exec /usr/bin/vtysh "${VTY_ARGS[@]}"