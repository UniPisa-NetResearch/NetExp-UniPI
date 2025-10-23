import paramiko
import re
import os
from typing import List, Set

SSH_HOST = '192.168.1.151'
SSH_PORT = 22
USERNAME = 'admin'
PASSWORD = 'YourPaSsWoRd'
SONIC_COMMAND = "sonic-db-cli COUNTERS_DB keys '*'"

OUTPUT_DIR = 'results'
OUTPUT_FILE = 'paths.txt'
OUTPUT_PATH = os.path.join(OUTPUT_DIR, OUTPUT_FILE)

# Regex per identificare e catturare l'OID completo (es. oid:0x...)
OID_PATTERN = re.compile(r'(oid:0x[0-9a-fA-F]+)')


def format_redis_key_to_path(redis_key: str) -> str:
    """
    Trasforma una chiave Redis (es. 'RATES:oid:0x100...:PORT') in un percorso
    gNMI-like (es. 'RATES/oid:0x100.../PORT') preservando i ':' interni all'OID.
    """

    # Suddividi la chiave sul primo ':' che separa la TABELLA dal resto.
    parts = redis_key.split(':', 1)
    if len(parts) < 2:
        return redis_key

    table_name = parts[0]
    key_suffix = parts[1]  # Es: "oid:0x1000000000037:PORT"

    # Sostituisci i ':' interni a ogni OID con un placeholder (es. '###')
    key_with_ph = OID_PATTERN.sub(lambda m: m.group(0).replace(':', '###'), key_suffix)

    # Sostituisci i rimanenti ':' (che sono i separatori logici) con '/'
    path_suffix = key_with_ph.replace(':', '/')

    # Ripristina i ':' all'interno dell'OID
    final_suffix = path_suffix.replace('###', ':')

    # Unisci il nome della tabella e il suffisso con '/'
    final_path = f"{table_name}/{final_suffix}"

    return final_path


def main():
    print(f"Connetto a {SSH_HOST}:{SSH_PORT} (user={USERNAME}) ed eseguo: '{SONIC_COMMAND}'")

    raw_keys: List[str] = []

    # Esecuzione SSH
    try:
        # Crea il client SSH
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(hostname=SSH_HOST, port=SSH_PORT, username=USERNAME, password=PASSWORD)

        # Esegue il comando
        stdin, stdout, stderr = client.exec_command(SONIC_COMMAND)

        # Legge l'output standard
        output = stdout.read().decode().strip()
        errors = stderr.read().decode().strip()

        if errors:
            print(f"\nErrore durante l'esecuzione remota di '{SONIC_COMMAND}':")
            print(errors)
            return

        # L'output di 'sonic-db-cli keys *' è una lista di chiavi separate da newline
        raw_keys = [k.strip() for k in output.splitlines() if k.strip()]

    except paramiko.AuthenticationException:
        print("\nErrore: Autenticazione SSH fallita. Controlla username e password.")
        return
    except paramiko.SSHException as e:
        print(f"\nErrore SSH: {e}")
        return
    except Exception as e:
        print(f"\nErrore generico di connessione: {e}")
        return
    finally:
        if 'client' in locals():
            client.close()

    # --- Elaborazione e Trasformazione Dati ---

    print(f"\nComando eseguito con successo. Trovate {len(raw_keys)} chiavi Redis")

    # Trasformazione delle chiavi nei percorsi gNMI-like
    translated_paths: Set[str] = set()
    for raw_key in raw_keys:
        translated_path = format_redis_key_to_path(raw_key)
        translated_paths.add(translated_path)

    # Salvataggio su File

    # Assicurati che la cartella di output esista
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Scrivi i percorsi ordinati nel file
    try:
        with open(OUTPUT_PATH, 'w') as f:
            for p in sorted(translated_paths):
                f.write(p + '\n')

        print(f"\nSalvataggio completato. I {len(translated_paths)} percorsi sono stati scritti in: {OUTPUT_PATH}")

    except IOError as e:
        print(f"\nImpossibile scrivere il file di output {OUTPUT_PATH}. {e}")

    print("\n=== Esempio di Path Ricostruiti ===")

    # Stampa i percorsi
    for p in sorted(translated_paths):
        print(p)

if __name__ == '__main__':
    main()