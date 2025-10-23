import json
from pygnmi.client import gNMIclient, gNMIException

# --- Parametri di Connessione e Percorso ---
TARGET_HOST = "192.168.1.151"
TARGET_PORT = 8080
USERNAME = "admin"
PASSWORD = "YourPaSsWoRd"
# Percorso OpenConfig specifico per la CONFIG dell'interfaccia
TARGET_PATH = "/openconfig-interfaces:openconfig-interfaces:interfaces/interface[name=Ethernet0]/config"

# --- Inizializzazione del Client e Operazione GET ---

print(f"Tentativo di connessione a gNMI su {TARGET_HOST}:{TARGET_PORT}...")

try:
    # Utilizza 'with' per garantire che la connessione venga chiusa correttamente
    with gNMIclient(
            target=(TARGET_HOST, TARGET_PORT),
            username=USERNAME,
            password=PASSWORD,
            insecure=True,  # Disabilita TLS/SSL (necessario per la porta 8080 non sicura di SONiC)
            encoding="json_ietf"  # Codifica preferita
    ) as gc:

        # Esegue l'operazione GET
        result = gc.get(path=[TARGET_PATH])

        print("\n--- Risultato GET (Configurazione Interfaccia Ethernet0) ---")

        # Stampa il risultato formattato in JSON
        print(json.dumps(result, indent=4))

except gNMIException as e:
    print(f"\nERRORE gNMI: Impossibile eseguire la richiesta o connettersi.")
    print(f"Dettagli: {e}")
except Exception as e:
    print(f"\nSi è verificato un errore inaspettato: {e}")