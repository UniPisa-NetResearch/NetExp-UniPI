import json
import os
import sys
from pygnmi.client import gNMIclient

HOST = os.getenv('SONIC_HOST', '192.168.1.151')
PORT = int(os.getenv('SONIC_PORT', '8080'))
USERNAME = os.getenv('SONIC_USER', 'admin')
PASSWORD = os.getenv('SONIC_PASS', 'YourPaSsWoRd')
# se INSECURE = True -> non usa TLS (--insecure). L'espressione restituisce True se la stringa è esattamente uguale a uno degli elementi della tupla, altrimenti False.
INSECURE = os.getenv('SONIC_INSECURE', '1') in ('1', 'true', 'True', 'yes', 'Y')
TARGET_DB = os.getenv('SONIC_TARGET_DB', 'COUNTERS_DB')
XPATH = os.getenv('SONIC_XPATH', 'COUNTERS/Ethernet*')
# se ENCODING = None => auto-detect. Valori possibili di encoding: 'json', 'json_ietf', 'proto', 'bytes'. Se il valore è vuoto, restituisce None
ENCODING = os.getenv('SONIC_ENCODING', 'json_ietf') or None

def custom_print(label, obj):
    print(f"\n=== {label} ===")
    try:
        print(json.dumps(obj, indent=2))
    except Exception:
        # fallback string
        print(str(obj))

def main():
    host_tuple = (HOST, PORT)

    print(f"Connettendo a {HOST}:{PORT} (utente: {USERNAME}) -- insecure={INSECURE}")

    try:
        with gNMIclient(target=host_tuple, username=USERNAME, password=PASSWORD, insecure=INSECURE) as gc:

            # mostra le Capabilities
            try:
                caps = gc.capabilities()
                custom_print('CAPABILITIES', caps)
            except Exception as e:
                print(f"[warning] capabilities() fallita: {e}")

            paths = [XPATH]
            print(f"Esecuzione GET su target='{TARGET_DB}', path={paths}, encoding={ENCODING or '<auto>'}")

            result = gc.get(path=paths, target=TARGET_DB, encoding=ENCODING)
            custom_print('GET response', result)

    except Exception as e:
        print(f"Errore generico: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
