from pygnmi.client import gNMIclient
import json

target = ('192.168.1.151', 8080)

with gNMIclient(target=target, username='admin', password='YourPaSsWoRd', insecure=True) as c:
    caps = c.capabilities()
    print(json.dumps(caps, indent=2))