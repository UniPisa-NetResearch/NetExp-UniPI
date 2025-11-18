#!/bin/bash
# res_vtysh - wrapper semplice: blocca modifiche alla mgmt iface (ethN / ethernetN)
set -o pipefail

LOG=/var/log/res_vtysh_safe.log
SUDO_USER="${SUDO_USER:-$USER}"
MGMT_IFACE_RAW="$(cat /etc/res_mgmt_iface 2>/dev/null || echo '')"
MGMT_IFACE="$(echo "$MGMT_IFACE_RAW" | tr 'A-Z' 'a-z' | xargs)"

# raccogli -c multipli e altri args
ARGS=()
C_COMMANDS=()
while (($#)); do
  case "$1" in
    -c)
      shift
      C_COMMANDS+=("$1")
      ARGS+=("-c" "$1")
      ;;
    --)
      shift
      ARGS+=("$@")
      break
      ;;
    *)
      ARGS+=("$1")
      ;;
  esac
  shift
done

# leggi stdin se presente
STDIN_CONTENT=""
if [ ! -t 0 ]; then
  STDIN_CONTENT="$(cat || true)"
fi

# funzione per espandere sequenze \n presenti negli argomenti (es. echo "\n")
_expand_escapes() { printf '%b' "$1"; }

# normalizza input (unisce -c e stdin, con newline reali)
NORMALIZED=""
if [ "${#C_COMMANDS[@]}" -gt 0 ]; then
  for c in "${C_COMMANDS[@]}"; do
    NORMALIZED+="$(_expand_escapes "$c")"$'\n'
  done
fi
if [ -n "$STDIN_CONTENT" ]; then
  NORMALIZED+="$(_expand_escapes "$STDIN_CONTENT")"
fi

# tutto in minuscolo per matching
FULL_LOWER="$(echo -e "$NORMALIZED" | tr 'A-Z' 'a-z')"

# genera alias per mgmt iface (ethN <-> ethernetN)
ALIASES=()
if [ -n "$MGMT_IFACE" ]; then
  ALIASES+=("$MGMT_IFACE")
  if echo "$MGMT_IFACE" | grep -Eq '^eth([0-9]+)$'; then
    n="$(echo "$MGMT_IFACE" | sed -E 's/^eth([0-9]+)$/\1/')"
    ALIASES+=("ethernet${n}")
  fi
  if echo "$MGMT_IFACE" | grep -Eq '^ethernet([0-9]+)$'; then
    n="$(echo "$MGMT_IFACE" | sed -E 's/^ethernet([0-9]+)$/\1/')"
    ALIASES+=("eth${n}")
  fi
fi

# dedup
if [ "${#ALIASES[@]}" -gt 0 ]; then
  mapfile -t UNIQ_AL < <(printf "%s\n" "${ALIASES[@]}" | awk '!seen[$0]++')
else
  UNIQ_AL=()
fi

# verbi di modifica (lista semplice); "show" è considerato query e NON modifica
MODIFY_REGEX='\b(configure|interface|ip[[:space:]]+address|no[[:space:]]+shutdown|shutdown|vlan|vrf|dhcp|set|del|delete|add|route|neighbor|ip|address|qdisc|tc)\b'
SHOW_REGEX='\bshow\b'

# se NON abbiamo input (-c o stdin) allora interactive -> deny
if [ "${#C_COMMANDS[@]}" -eq 0 ] && [ -t 0 ]; then
  echo "$(date -Iseconds) DENY interactive user=$SUDO_USER vtysh (interactive sessions not allowed)" >> "$LOG"
  echo "Interactive vtysh sessions are not permitted. Use -c or pipe commands." >&2
  exit 1
fi

# controllo principale: per ogni alias, se appare e c'è un verbo di MODIFICA e non appare 'show', allora deny.
if [ -n "$FULL_LOWER" ] && [ "${#UNIQ_AL[@]}" -gt 0 ]; then
  for alias in "${UNIQ_AL[@]}"; do
    # usa pattern di word-boundary (semplice)
    if echo "$FULL_LOWER" | grep -Eiq "(^|[^a-z0-9_-])${alias}([^a-z0-9_-]|$)"; then
      # se è una show -> allow
      if echo "$FULL_LOWER" | grep -Eiq "$SHOW_REGEX"; then
        # allow (query)
        echo "$(date -Iseconds) ALLOW user=$SUDO_USER vtysh matched_alias='$alias' (show detected) stdin_present=$( [ -n "$STDIN_CONTENT" ] && echo yes || echo no )" >> "$LOG"
        # non return here: continue scanning other aliases, but show should normally mean query
        continue
      fi

      # se trovi verbo di modifica -> deny
      if echo "$FULL_LOWER" | grep -Eiq "$MODIFY_REGEX"; then
        echo "$(date -Iseconds) DENY user=$SUDO_USER vtysh matched_alias='$alias' (modifying verb detected)" >> "$LOG"
        echo "Operation that modifies management interface '$MGMT_IFACE_RAW' is not permitted." >&2
        exit 1
      fi
    fi
  done
fi

# se arriviamo qui -> allow: esegui vtysh con stdin/args. log di allow
echo "$(date -Iseconds) ALLOW user=$SUDO_USER vtysh args='${ARGS[*]}' stdin_present=$( [ -n "$STDIN_CONTENT" ] && echo yes || echo no )" >> "$LOG"

# esecuzione: se STDIN present -> usare script per pty se disponibile
if [ -n "$NORMALIZED" ]; then
  if command -v script >/dev/null 2>&1; then
    printf '%s' "$NORMALIZED" | script -q -c "/usr/bin/vtysh ${ARGS[*]}" /dev/null
    exit $?
  else
    printf '%s' "$NORMALIZED" | /usr/bin/vtysh "${ARGS[@]}"
    exit $?
  fi
else
  /usr/bin/vtysh "${ARGS[@]}"
  exit $?
fi
