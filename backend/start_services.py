import subprocess
import time

# services list
services = [
    ("Authentication", "python authentication/app.py 5000"),
    ("Orchestrator", "python orchestrator/orchestrator.py 5001"),
    ("Controller", "python controller_service/app.py 5002"),
]

processes = []

for name, command in services:
    print(f"Avvio {name}...")
    # start every service on a separate process
    p = subprocess.Popen(command.split())
    processes.append(p)
    time.sleep(1)

# main script active until the services are running
try:
    for p in processes:
        p.wait()
except KeyboardInterrupt:
    print("\nEnding services...")
    for p in processes:
        p.terminate()