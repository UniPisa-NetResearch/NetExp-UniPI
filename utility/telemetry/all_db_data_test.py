from pygnmi.client import gNMIclient
import json
import re
from pprint import pprint

GNMI_HOST = '192.168.1.151'
GNMI_PORT = 8080
USERNAME = 'admin'
PASSWORD = 'YourPaSsWoRd'
INSECURE = True
TARGET_DB = 'COUNTERS_DB'
ENCODING = 'json_ietf'

# Mappe da leggere per risolvere gli oid -> nome
KNOWN_MAPS = [
    'COUNTERS_PORT_NAME_MAP',   # port (0x10...)
    'COUNTERS_QUEUE_NAME_MAP',  # queue (0x15...)
    'COUNTERS_PG_NAME_MAP'      # priority-group names (0x1a0...)
]

START_PATH = 'COUNTERS'


def safe_load(resp):
    """Se resp è bytes o stringa JSON, prova a decodificarlo in dict/list."""
    if resp is None:
        return None
    if isinstance(resp, bytes):
        try:
            resp = resp.decode('utf-8')
        except Exception:
            return resp
    if isinstance(resp, str):
        try:
            return json.loads(resp)
        except Exception:
            return resp
    return resp


def parse_map_response(resp):
    if not resp:
        return {}

    if isinstance(resp, str):
        try:
            resp = json.loads(resp)
        except Exception:
            return {}

    translations = {}

    # struttura attesa: { "notification": [ { "update": [ { "path": "...", "val": { name: "oid:0x..." } } ] } ] }
    notifications = None
    if isinstance(resp, dict):
        notifications = resp.get('notification') or resp.get('notifications')  # tolerant
    elif isinstance(resp, list):
        notifications = resp

    if not notifications:
        return {}

    for note in notifications:
        updates = note.get('update', []) if isinstance(note, dict) else []
        for upd in updates:
            # alcuni output possono usare 'val' o 'value'
            val = upd.get('val') or upd.get('value') or {}
            if not isinstance(val, dict):
                continue
            # val è un dict name -> "0x..."
            for name, entry in val.items():

                value_str = entry

                if not isinstance(value_str, str):
                    continue

                # rimuoviamo eventuali spazi
                value_str = value_str.strip()
                # salviamo come chiave il valore '0x...' (come richiesto)
                translations[value_str] = name

    return translations


def collect_paths_from_obj(obj, base_path=''):

    paths = set()

    def _rec(o, cur):
        if isinstance(o, dict):
            for k, v in o.items():
                sub = f"{cur}/{k}" if cur else k
                paths.add(sub)
                _rec(v, sub)
        elif isinstance(o, list):
            for idx, item in enumerate(o):
                sub = f"{cur}[{idx}]"
                paths.add(sub)
                _rec(item, sub)
        else:
            # scalare: cur è una foglia
            if cur:
                paths.add(cur)

    start = base_path.rstrip('/*')
    start = start.strip('/')
    _rec(obj, start)
    # normalizza
    norm = {p.replace('//', '/') for p in paths}
    return norm


SEGMENT_RE = re.compile(r"^oid:0x[0-9a-fA-F]+$")


def translate_path(path, translations):

    parts = path.split('/')
    new_parts = []
    missing_values = set()
    for seg in parts:
        #traduci solo le interfacce Eth0 - Eth51, per le altre i percorsi non funzionano con la traduzione
        if SEGMENT_RE.match(seg) and seg.startswith("oid:0x10"):
            if seg in translations:
                new_parts.append(translations[seg])
            else:
                new_parts.append(seg)
                missing_values.add(seg)
        else:
            new_parts.append(seg)
    return "/".join(new_parts), missing_values


def main():
    target = (GNMI_HOST, GNMI_PORT)
    all_translations = {}

    print(f"Connetto a {GNMI_HOST}:{GNMI_PORT} (user={USERNAME}) target={TARGET_DB} encoding={ENCODING}")

    try:
        with gNMIclient(target=target, username=USERNAME, password=PASSWORD, insecure=INSECURE) as gc:
            # 1) costruisco all_translations leggendo le mappe note
            for map_name in KNOWN_MAPS:
                print(f"\nRichiedo mappa: {map_name}")
                try:
                    resp = gc.get(path=[map_name], target=TARGET_DB, encoding=ENCODING)
                except Exception as e:
                    print(f"GET per {map_name} fallito: {e}")
                    resp = None

                map_translations = parse_map_response(resp)
                for key, name in map_translations.items():
                    if key in all_translations and all_translations[key] != name:
                        print(f"Attenzione: conflitto per {key}: '{all_translations[key]}' -> '{name}' (sovrascrivo)")
                    all_translations[key] = name

            print("\nMappe lette (all_translations):")
            pprint(all_translations)

            # 2) esploro START_PATHS e raccolgo i virtual paths sotto COUNTERS
            all_paths = set()

            print(f"\nRichiesta GET path='{START_PATH}'")
            try:
                res = gc.get(path=[START_PATH], target=TARGET_DB, encoding=ENCODING)
            except Exception as e:
                print(f"GET su {START_PATH} fallito: {e}")

            payload = None
            if isinstance(res, dict):
                if 'data' in res and isinstance(res['data'], dict):
                    payload = res['data']
                elif 'notification' in res and isinstance(res['notification'], list):
                    combined = {}
                    for n in res['notification']:
                        if 'update' in n:
                            for u in n['update']:
                                if 'val' in u and isinstance(u['val'], dict):
                                    for kk, vv in u['val'].items():
                                        # se vv è dict, non scaviamo ulteriormente (mappiamo shallow)
                                        combined[kk] = vv
                        if 'val' in n and isinstance(n['val'], dict):
                            combined.update(n['val'])
                    payload = combined if combined else None
                else:
                    payload = res
            else:
                payload = res

            if payload:
                found = collect_paths_from_obj(payload, base_path=START_PATH)
                all_paths |= found
            else:
                print("Nessun payload analizzabile trovato nella risposta.")

    except Exception as e:
        print("Errore generico/gRPC:", e)
        return

    # 3) traduci le paths sostituendo i value con i nomi presi da all_translations
    translated = set()
    missing = set()
    for path in all_paths:
        # consideriamo solo le paths che iniziano con 'COUNTERS'
        if not path.startswith('COUNTERS'):
            continue
        new_path, missing_values = translate_path(path, all_translations)
        translated.add(new_path)
        missing |= missing_values

    # output ordinato
    print("\n=== Virtual paths tradotte (COUNTERS...) ===")
    for p in sorted(translated):
        print(p)

    if missing:
        print("\n=== Valori senza traduzione incontrati ===")
        for value in sorted(missing):
            print(value)

if __name__ == '__main__':
    main()
