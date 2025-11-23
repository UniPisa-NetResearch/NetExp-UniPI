#!/bin/bash
# res_vtysh - wrapper for vtysh to allow only non-interactive usage and
#             to prevent modification of the management interface
SUDO_USER="${SUDO_USER:-$USER}"
# read the management interface name from file, normalize to lowercase and trim whitespace
MGMT_IFACE="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE="$(echo "$MGMT_IFACE" | tr 'A-Z' 'a-z' | xargs)"

# arrays for forwarding to vtysh and for local inspection.
VTY_ARGS=()      # full args to forward to vtysh, e.g. (-c "configure terminal" -c "interface eth2" ...)
CMD_PARTS=()     # command strings (without -c) for parsing/inspection

# parse arguments and accept only -c / --command for safety
# other vtysh flags are ignored by this wrapper for strictness
while [ "$#" -gt 0 ]; do
  case "$1" in
    -c|--command)
      shift
      # if -c provided but no following arg, treat as empty (will be denied)
      ARG="${1:-}"
      # preserve the exact argument for forwarding to vtysh
      VTY_ARGS+=(-c "$ARG")
      # store only the command part for analysis
      CMD_PARTS+=("$ARG")
      shift || true
      ;;
    --)
      shift
      # ignore remaining positional args (vtysh supports only -c typically)
      break
      ;;
    *)
      # ignore other args: we only accept-c/--command for safety
      shift
      ;;
  esac
done

# deny interactive use: require at least one -c argument
if [ "${#VTY_ARGS[@]}" -eq 0 ]; then
  # if user piped commands via stdin, still deny: we only accept explicit -c inline usage
  echo "Interactive use of vtysh is disallowed. Please run non-interactive commands, e.g.:"
  echo "  sudo res_vtysh -c \"show interface <iface>\""
  echo "  sudo res_vtysh -c 'configure terminal' -c 'interface eth2' -c 'ip address 10.0.0.1/24' -c 'no shutdown'"
  exit 1
fi

# build a single joined command string for easier searching (lowercased for comparisons)
# example: -c 'configure terminal' -c 'interface eth2' -> "configure terminal; interface eth2"
JOINED_CMD="$(printf '%s; ' "${CMD_PARTS[@]}" | sed 's/; $//')"
CMD_LOWER="$(printf '%s' "$JOINED_CMD" | tr 'A-Z' 'a-z' | xargs)"

is_show_cmd() {
  # return 0 if any part contains a 'show' command word
  echo "$CMD_LOWER" | grep -Eiq '\bshow\b' && return 0 || return 1
}

# this does a word match for the mgmt token; if mgmt token is empty, returns false
references_mgmt_iface() {
  [ -n "$MGMT_IFACE" ] && echo "$CMD_LOWER" | grep -wq "$MGMT_IFACE"
  return $?
}

# detect configure-like sequences (words that typically indicate modifying intent)
has_configure() {
  echo "$CMD_LOWER" | grep -Eiq '\bconfigure\b' && return 0 || return 1
}

# extract first interface token after the word 'interface' in the joined commands
# returns lowercase interface token or empty string
extract_interface_from_joined() {
  # match: interface <token>
  echo "$JOINED_CMD" | sed -n 's/.*[[:space:];]interface[[:space:]]\+\([^[:space:];]\+\).*/\1/p' \
    | tr 'A-Z' 'a-z' | xargs
}

# Main decision flow:
# get real path
CONFIG_CMD="$(command -v vtysh 2>/dev/null || true)"

# If command -v didn't find vtysh, fail with informative message
if [ -z "$CONFIG_CMD" ]; then
  echo "config binary not found on PATH; aborting." >&2
  exit 127
fi

# if the joined command references the management interface:
if references_mgmt_iface; then
  # allow any read-only 'show' command referencing mgmt iface
  if is_show_cmd; then
    exec "$CONFIG_CMD" "${VTY_ARGS[@]}"
  fi

  # if it's not a show (i.e. a modifying operation referencing mgmt) -> deny
  echo "Operation not permitted on management interface $MGMT_IFACE"
  exit 1
fi

# at this point mgmt iface is NOT referenced in the provided -c arguments

# if the sequence includes a configure request, require an explicit interface target
# Example command: vtysh configure_terminal not allowed
if has_configure; then
  TARGET_IF="$(extract_interface_from_joined)"
  if [ -z "$TARGET_IF" ]; then
    # configure present but no explicit interface -> deny to avoid interactive config mode
    echo "Entering configuration mode is disallowed. Please run specific non-interactive commands that include the target interface, e.g.:"
    echo "  sudo res_vtysh -c 'configure terminal' -c 'interface eth2' -c 'ip address 10.0.0.1/24' -c 'no shutdown'"
    exit 1
  fi

  # if extracted interface is equal to mgmt (shouldn't happen because references_mgmt_iface earlier returned false),
  # reject to be safe.
  if [ -n "$MGMT_IFACE" ] && [ "$TARGET_IF" = "$MGMT_IFACE" ]; then
    echo "Operation not permitted on management interface $MGMT_IFACE"
    exit 1
  fi

  # Otherwise allow the non-interactive configure sequence that targets a concrete non-mgmt interface
  exec "$CONFIG_CMD" "${VTY_ARGS[@]}"
fi

# default: no mgmt referenced -> allow (covers show and other read-only commands)
exec "$CONFIG_CMD" "${VTY_ARGS[@]}"