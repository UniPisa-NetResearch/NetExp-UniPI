from .database.db import db, Reservation
import os
import yaml

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# define the path for the reservation devices inside the agent folder
RESERVATION_DEVICES_DIR = os.path.join(BASE_DIR, "agent", "agents_util", "reservation_devices")

def get_next_available_id(model_class):
    # Find the first available ID (fills gaps)
    try:
        # Find first gap in IDs
        result = db.session.execute(
            db.text(f"""
                SELECT COALESCE(
                    (SELECT MIN(t1.id + 1)
                     FROM "{model_class.__tablename__}" t1
                     WHERE NOT EXISTS (
                         SELECT 1 FROM "{model_class.__tablename__}" t2
                         WHERE t2.id = t1.id + 1
                     )),
                    COALESCE((SELECT MAX(id) + 1 FROM "{model_class.__tablename__}"), 1)
                ) AS next_id
            """)
        ).scalar()

        return result if result else 1
    except Exception as e:
        print(f"Error finding next available ID: {e}")
        # Fallback: use max + 1
        max_id = db.session.query(db.func.max(model_class.id)).scalar()
        return (max_id or 0) + 1

def parse_inventory(inventory_path: str, return_hosts_only: bool = False, return_full_info: bool = False):
    """
    read the inventory Ansible.
    - return_hosts_only=False → dict {device_name: ansible_host_ip}
    - return_hosts_only=True  → set {device_name, ...}
    """
    result = set() if return_hosts_only else {}
    with open(inventory_path, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('[') and not line.startswith('#'):
                parts = line.split()
                if len(parts) >= 2:
                    device_name = parts[0]
                    if return_hosts_only:
                        result.add(device_name)
                    elif return_full_info:
                        ip_address = None
                        role = None
                        for part in parts[1:]:
                            if part.startswith('ansible_host='):
                                ip_address = part.split('=', 1)[1]
                            elif part.startswith('role='):
                                role = part.split('=', 1)[1]
                        result[device_name] = {"ip": ip_address, "role": role}
                    else:
                        for part in parts[1:]:
                            if part.startswith('ansible_host='):
                                result[device_name] = part.split('=')[1]

    return result

# read every field of each device inside the inventory
def parse_complete_inventory_hosts(inventory_path):
    hosts = {}
    with open(inventory_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("["):
                continue
            parts = line.split()
            name = parts[0]
            info = {"host": None, "user": None, "password": None, "become": False, "become_pass": None, "role": "host", "iface": "eth0"}
            for p in parts[1:]:
                if p.startswith("ansible_host="):
                    info["host"] = p.split("=", 1)[1]
                elif p.startswith("ansible_user="):
                    info["user"] = p.split("=", 1)[1]
                elif p.startswith("ansible_ssh_pass="):
                    info["password"] = p.split("=", 1)[1]
                elif p.startswith("ansible_become="):
                    info["become"] = p.split("=", 1)[1].lower() == "yes"
                elif p.startswith("ansible_become_pass="):
                    info["become_pass"] = p.split("=", 1)[1]
                elif p.startswith("role="):
                    info["role"] = p.split("=", 1)[1]
                elif p.startswith("res_iface="):
                    info["iface"] = p.split("=", 1)[1]
            hosts[name] = info
    return hosts

def resolve_netbox_device(dev, nb=None, fetch_interface: bool = False) -> dict:
    #extract common fields from a pynetbox device object

    name = getattr(dev, "name", None)
    asset_tag = getattr(dev, "asset_tag", None) or name

    # primary IP
    primary_ip_obj = getattr(dev, "primary_ip", None)
    raw_ip = None
    ip_addr = None
    if primary_ip_obj:
        raw_ip = getattr(primary_ip_obj, "address", None) or (
            primary_ip_obj.get("address") if isinstance(primary_ip_obj, dict) else None
        )
        if raw_ip:
            ip_addr = str(raw_ip).split("/")[0]

    # role
    role_obj = getattr(dev, "role", None)
    role = getattr(role_obj, "slug", None) or getattr(role_obj, "name", None)
    role = role.lower() if role else None

    result = {
        "name":      name,
        "asset_tag": asset_tag,
        "ip":        ip_addr,
        "role":      role,
    }

    # interface
    if fetch_interface and nb and raw_ip:
        interface = None
        try:
            ip_objs = nb.ipam.ip_addresses.filter(address=raw_ip)
            ip_obj = None
            if ip_objs:
                if hasattr(ip_objs, "first"):
                    ip_obj = ip_objs.first()
                else:
                    ip_list = list(ip_objs)
                    ip_obj = ip_list[0] if ip_list else None

            if ip_obj:
                assigned = getattr(ip_obj, "assigned_object", None) or (
                    ip_obj.get("assigned_object") if isinstance(ip_obj, dict) else None
                )
                if assigned:
                    if isinstance(assigned, dict):
                        interface = assigned.get("name") or assigned.get("display")
                    else:
                        interface = getattr(assigned, "name", None) or getattr(assigned, "display", None)
        except Exception as e:
            print(f"NetBox ip lookup error for ip {ip_addr}: {e}")
        result["interface"] = interface

    return result

def get_is_virtual_from_db(reservation_id) -> bool:
    try:
        res = db.session.get(Reservation, int(reservation_id))
        return bool(getattr(res, 'is_virtual', False)) if res else False
    except Exception as e:
        print(f"Error reading Reservation for reservation {reservation_id}: {e}")
        return False

def create_reserved_devices_yaml(reservation_id, devices):
    # creates a YAML file containing the list of reserved devices for the LLM agents
    os.makedirs(RESERVATION_DEVICES_DIR, exist_ok=True)
    file_path = os.path.join(RESERVATION_DEVICES_DIR, f"res_{reservation_id}_devices.yaml")
    
    device_list = []
    for d in devices:
        # add only valid devices with an ID/Name and their role
        if d.get("id_device"):
            device_list.append({
                "name": d.get("id_device"),
                "role": d.get("role", "unknown")
            })
    
    data = {"reserved_devices": device_list}
    
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)
        print(f"Created reserved devices YAML at {file_path}")
    except Exception as e:
        print(f"Error creating reserved devices YAML: {e}")