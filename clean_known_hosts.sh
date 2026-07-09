#!/bin/bash

IP_LIST=("172.20.20.151" "172.20.20.152" "172.20.20.153" "172.20.20.154" "172.20.20.155" "172.20.20.156" "172.20.20.161" "172.20.20.162" "172.20.20.163" "172.20.20.164")

KNOWN_HOSTS_FILE="$HOME/.ssh/known_hosts"

for IP in "${IP_LIST[@]}"; do
    echo "Removing identifier for IP: $IP..."
    ssh-keygen -f "$KNOWN_HOSTS_FILE" -R "$IP"
done

echo "All identifiers removed!"