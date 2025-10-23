import subprocess
import json
import re

ADDRESS = "192.168.1.151:8080"
USERNAME = "admin"
PASSWORD = "YourPaSsWoRd"
TARGET = "OC-YANG"

print("INIZIO ANALISI gNMI CAPABILITIES")

# comando per recuperare i moduli supportati
get_capabilities_command = (
    f'wsl gnmic get --address {ADDRESS} --insecure --username "{USERNAME}" '
    f'--password "{PASSWORD}" --path "/ietf-yang-library:modules-state" --target "{TARGET}"'
)

print(f"Esecuzione del comando: {get_capabilities_command}")
print("-----------------------------------------------------")

try:
    result = subprocess.run(
        get_capabilities_command,
        shell=True,                         #comando deve essere eseguito attraverso la shell del sistema operativo
        check=True,                         #eccezione se il comando ritorna un codice di uscita diverso da zero
        capture_output=True,                #stdout e stderr del comando devono essere catturati e memorizzati in result
        text=True,                          #stdout e stderr decodificati in stringhe anziché rimanere in formato binario
        encoding='utf-8'
    )

    # stampa l'output completo del comando, accede a stdout, rimuove spazi bianchi, creare una lista di stringhe
    output_lines = result.stdout.strip().split('\n')
    #unire tutte le stringhe con '/n'
    json_output = "\n".join(output_lines)
    print("Output JSON completo di ietf-yang-library:")
    print(json_output)

except subprocess.CalledProcessError as e:
    print(f"Errore nell'esecuzione del comando gnmic: {e}")
    print(f"Stdout: {e.stdout}")
    print(f"Stderr: {e.stderr}")
    exit(1)
except Exception as e:
    print(f"Errore inaspettato: {e}")
    exit(1)

# parsing del JSON per estrarre i moduli
modules = {}
try:
    # cerchiamo il JSON nel risultato, JSON è in un array delimitato da [.*]
    match = re.search(r'(\[.*\])', json_output, re.DOTALL)
    if not match:
        # se non si trova l'array, si prova a cercare l'oggetto singolo delimitato da {}
        match = re.search(r'(\{.*\})', json_output, re.DOTALL)

    if not match:
        print("Impossibile trovare l'oggetto JSON nell'output di gnmic.")
        exit(1)

    # carichiamo il json in data
    data = json.loads(match.group(1))

    # lista moduli
    modules_list = []
    #controllo che data non è una lista vuota
    if isinstance(data, list) and data:
        try:
            #primo elemento della lista
            first_notification = data[0]
            #controllo se l'elemento contiene 'updates'
            if 'updates' in first_notification:
                #itera su 'updates' (ce n'è solo uno)
                for update in first_notification['updates']:
                    #cerca l'update che contiene ietf-yang-library:modules-state
                    if 'values' in update and 'ietf-yang-library:modules-state' in update['values']:
                        # accesso al doppio livello di ietf-yang-library:modules-state e poi 'module'
                        #accesso al primo livello
                        modules_state_data = update['values']['ietf-yang-library:modules-state']
                        #accesso al secondo livello, se non presente l'accesso è al primo (modules_state_data)
                        modules_state_inner = modules_state_data.get('ietf-yang-library:modules-state',
                                                                     modules_state_data)
                        # ricaviamo lista dei moduli
                        modules_list = modules_state_inner.get('module', [])
                        break  # moduli trovati, uscita dal ciclo updates
        except Exception as e:
            print(f"Fallito il parsing del formato Array/Updates. Errore: {e}")


        #accesso diretto al nodo 'ietf-yang-library:modules-state' se non viene trovato nulla
        if not modules_list:
            modules_list = data.get('ietf-yang-library:modules-state', {}).get('module', [])

    if not modules_list:
        print("Struttura JSON non riconosciuta per ietf-yang-library:modules-state. Impossibile estrarre i moduli.")
        exit(1)

    # continua l'elaborazione dei moduli
    for module in modules_list:
        # estrazione nome del modulo
        module_name = module.get('name')

        # rimozione dei mosuli che terminano con 'types', contengono solo i tipi dei dati nei moduli relativi
        if module_name and not module_name.endswith('-types'):
            # i moduli che iniziano con sonic, rimangono inalterati, agli altri viene aggiunto il percorso noto
            if module_name.startswith('sonic-'):
                root_path = f"/{module_name}"
            elif module_name == 'openconfig-interfaces':
                root_path = "/openconfig-interfaces:interfaces"
            elif module_name == 'openconfig-system':
                root_path = "/openconfig-system:system"
            elif module_name == 'openconfig-network-instance':
                root_path = "/openconfig-network-instance:network-instances"
            elif module_name == 'openconfig-routing-policy':
                root_path = "/openconfig-routing-policy:routing-policy"
            elif module_name == 'openconfig-acl':
                root_path = "/openconfig-acl:acl"
            elif module_name == 'openconfig-platform':
                root_path = "/openconfig-platform:components"
            elif module_name == 'ietf-interfaces':
                root_path = "/ietf-interfaces:interfaces"

            else:
                # separa la stringa per '-', ignora la prima parte ('openconfig' o 'ietf') e ricongiunge il resto con '-'
                parts = module_name.split('-')
                # controllo che ci sia almeno un '-'per evitare errori su nomi senza '-'
                if len(parts) > 1:
                    # unisci le parti del nome tramite '-', e scarta la prima parte del nome ('openconfig' o 'ietf')
                    root_node = '-'.join(parts[1:])
                else:
                    # se non ci sono '-', usa il nome intero come radice (caso di fallback)
                    root_node = module_name
                # componi il percorso concatenando tramite ':', radice e il nome appena creato
                root_path = f"/{module_name}:{root_node}"

            # solo i percorsi non duplicati vengono inclusi
            if root_path not in modules:
                modules[root_path] = module_name


except json.JSONDecodeError as e:
    print(f"Errore nell'analisi JSON dell'output gnmic: {e}")
    print("Controllare che l'output gnmic sia in formato JSON valido.")
    exit(1)
except Exception as e:
    print(f"Errore durante l'analisi dei moduli: {e}")
    exit(1)

# stampa l'elenco dei percorsi generati e prova che funzionino
print("-----------------------------------------------------")
print(f"{len(modules)} PERCORSI RADICE COMPLETI (inclusi IETF e Sottomoduli):")

for PATH in sorted(modules.keys()):
    print("-----------------------------------------------------")
    #stampa il percorso
    print(PATH)
    #comando get eseguito sul percorso
    get_module_command = (
        f'wsl gnmic get --address {ADDRESS} --insecure --username "{USERNAME}" '
        f'--password "{PASSWORD}" --path "{PATH}" --target "{TARGET}"'
    )

    print(f"Esecuzione del comando: {get_module_command}")

    try:
        result = subprocess.run(
            get_module_command,
            shell=True,
            check=True,
            capture_output=True,
            text=True,
            encoding='utf-8'
        )

        # stampa l'output completo del comando
        output_lines = result.stdout.strip().split('\n')

        json_output = "\n".join(output_lines)
        print("Output JSON completo:")
        print(json_output)

    except subprocess.CalledProcessError as e:
        print(f"Errore nell'esecuzione del comando gnmic: {e}")
        print(f"Stdout: {e.stdout}")
        print(f"Stderr: {e.stderr}")
        exit(1)
    except Exception as e:
        print(f"Errore inaspettato: {e}")
        exit(1)