from flask import jsonify, request, Response
from ..database.db import db, User, Reservation, ReservationDevice
import base64
import paramiko
import subprocess
import yaml
import io
import os
import pynetbox
from redis import Redis
from rq import Queue
from rq.job import Job
from ..utils import get_next_available_id
from ..app import app
from ..config import REDIS_URL, SUPPORTED_KEY_TYPES, CONTAINERLAB_HOST, CONTAINERLAB_HOST_USER, NETBOX_URL, NETBOX_TOKEN

redis = Redis.from_url(REDIS_URL)
queue = Queue(connection=redis)

# helper class and representer to force inline array in PyYAML
class InlineList(list):
    pass

def inline_list_representer(dumper, data):
    return dumper.represent_sequence('tag:yaml.org,2002:seq', data, flow_style=True)

# register representer for standard dumper and safe
yaml.add_representer(InlineList, inline_list_representer)
yaml.SafeDumper.add_representer(InlineList, inline_list_representer)

# helper function to validate the YAML structure
def validate_topology_structure(data):
    if not isinstance(data, dict): return False, "Root of YAML must be a dictionary."
    if 'name' not in data: return False, "Missing 'name' at root."
    if 'topology' not in data: return False, "Missing 'topology' at root."
    
    topology = data['topology']
    if not isinstance(topology, dict): return False, "'topology' must be a dictionary."
    if 'nodes' not in topology: return False, "Missing 'nodes' in 'topology'."
    if 'links' not in topology: return False, "Missing 'links' in 'topology'."

    # validate nodes
    for node_name, attrs in topology['nodes'].items():
        if 'kind' not in attrs: return False, f"Node '{node_name}' missing 'kind'."
        if 'image' not in attrs: return False, f"Node '{node_name}' missing 'image'."
        if 'mgmt-ipv4' not in attrs: return False, f"Node '{node_name}' missing 'mgmt-ipv4'."

    # validate links
    for i, link in enumerate(topology['links']):
        if 'endpoints' not in link: return False, f"Link index {i} missing 'endpoints'."
        if len(link['endpoints']) != 2: return False, f"Link index {i} 'endpoints' must have exactly 2 elements."

    return True, ""

# function to stream containerlab deployment output
def stream_containerlab_deployment(file_content=None):
    try:
        # connect to containerlab vm via SSH/SFTP
        yield ">>> Connecting to Containerlab host...\n"
        # connect to remote CONTAINERLAB_HOST using Paramiko
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        # key-based auth is configured for the host
        client.connect(hostname=CONTAINERLAB_HOST, username=CONTAINERLAB_HOST_USER)

         # destroy old lab (if any)
        yield ">>> Destroying current lab...\n"
        stdin, stdout, stderr = client.exec_command("cd testbed-sonic && sudo containerlab destroy", get_pty=True)
        for line in iter(stdout.readline, ""):
            yield line

        # if a file is provided, upload it before deploying
        if file_content:   
            # upload original YAML via SFTP
            yield "\n>>> Uploading new topology.clab.yaml...\n"
            sftp = client.open_sftp()
            remote_yaml_path = f"/home/{CONTAINERLAB_HOST_USER}/testbed-sonic/topology.clab.yaml"
            
            # use BytesIO to stream the original content directly
            file_obj = io.BytesIO(file_content.encode('utf-8'))
            sftp.putfo(file_obj, remote_yaml_path)
            sftp.close()

        # deploy new lab
        yield ">>> Deploying new lab...\n"
        stdin, stdout, stderr = client.exec_command("cd testbed-sonic && sudo containerlab deploy", get_pty=True)
        for line in iter(stdout.readline, ""):
            yield line
            
        exit_status = stdout.channel.recv_exit_status()
        if exit_status != 0:
            yield f"\n[ERROR] Deploy command failed with exit status {exit_status}\n"
            
        client.close()            

        # clean known_hosts locally
        yield "\n>>> Cleaning known hosts locally...\n"
        proc = subprocess.Popen(["./clean_known_hosts.sh"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in iter(proc.stdout.readline, ""):
            yield line
        proc.wait()

        yield "\n--- Deployment Completed Successfully! ---\n"

    except Exception as e:
        yield f"\n[EXCEPTION] {str(e)}\n"

def check_ssh_key(ssh_key):
    # separate the key elements
    key_parts = ssh_key.split()
    # the kay has two or three parts (omission of comment)
    if len(key_parts) < 2 or len(key_parts) > 3 or len(ssh_key) < 50:
        return jsonify({"message": "Invalid SSH Key format. Please ensure you copied the entire key."}), 400

    # key type verification
    key_type = key_parts[0]

    if key_type not in SUPPORTED_KEY_TYPES:
        return jsonify({"message": f"Unsupported SSH Key type: {key_type}. Supported types are: {', '.join(SUPPORTED_KEY_TYPES)}"}), 400

    # key body verification
    key_body_base64 = key_parts[1]
    try:
        # try to decode key body in Base64
        base64.b64decode(key_body_base64)
    except Exception as ex:
        app.logger.error(f"Key decoding error: {ex}")
        return jsonify({"message": "SSH Key body is corrupted or not valid Base64."}), 400

    return None

@app.route('/')
def serve_frontend_proxy():
    # can be used for testing, it is not the route used by the browser to load React.
    return 'Flask Backend Running. React is expected on port 5173.'

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    # Retrieve user and credentials check
    user = User.query.filter_by(username=username).first()

    if user and user.check_password(password):
        return jsonify({"message": "Login successful", "user_id": user.id, "username": user.username, "is_admin": user.is_admin}), 200
    else:
        return jsonify({"message": "Invalid username or password"}), 401

@app.route('/api/auth/signup', methods=['POST'])
def signup():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    # remove initial/final spaces
    ssh_key = data.get('sshKey', '').strip()

    # Check values
    if not username or not password or not ssh_key:
        return jsonify({"message": "Missing username, password, or SSH key"}), 400
    if len(password) < 8:
        return jsonify({"message": "Password must be at least 8 characters"}), 400
    if len(username) < 5:
        return jsonify({"message": "Username must be at least 5 characters"}), 400

    # User existence verification
    if User.query.filter_by(username=username).first():
        return jsonify({"message": "Username already exists"}), 409

    error = check_ssh_key(ssh_key)
    if error:
        return error

    # get next available ID (fills gaps)
    next_id = get_next_available_id(User)

    # User creation
    new_user = User(id=next_id, username=username, ssh_key=ssh_key)
    new_user.set_password(password)

    db.session.add(new_user)
    try:
        db.session.commit()
        # Reset id sequence to avoid conflicts, next inserted id will be max_id + 1 if no gaps in ids
        db.session.execute(db.text("""
                    SELECT setval(pg_get_serial_sequence('"user"', 'id'), 
                                 (SELECT MAX(id) FROM "user"), true);
                """))
        db.session.commit()
        return jsonify({"message": "Registration successful. You can now log in.", "user_id": new_user.id, "username": new_user.username}), 201
    except Exception as ex:
        db.session.rollback()
        # DB error
        app.logger.error(f"DB Error during signup: {ex}")
        return jsonify({"message": "An internal error occurred during registration."}), 500

@app.route('/api/auth/user/showUser', methods=['POST'])
def show_user():
    # shows username and the public key of the user
    data = request.get_json()
    username = data.get('username')

    if not username:
        return jsonify({"message": "Username required"}), 400

    user = User.query.filter_by(username=username).first()

    if user:
        return jsonify({
            "username": user.username,
            "ssh_key": user.ssh_key,
            "message": "User data retrieved successfully"
        }), 200
    else:
        return jsonify({"message": "User not found"}), 404


@app.route('/api/auth/user/changeKey', methods=['POST'])
def change_key():
    # allows user to change the public key
    data = request.get_json()
    username = data.get('username')
    new_ssh_key = data.get('newSshKey', '').strip()

    if not username or not new_ssh_key:
        return jsonify({"message": "Missing username or new SSH key"}), 400

    error = check_ssh_key(new_ssh_key)

    if error:
        return error

    # 2. Aggiornamento nel DB
    user = User.query.filter_by(username=username).first()

    if user:
        user.ssh_key = new_ssh_key
        try:
            db.session.commit()
            return jsonify({"message": "SSH Key updated successfully"}), 200
        except Exception as ex:
            db.session.rollback()
            app.logger.error(f"DB Error during key change: {ex}")
            return jsonify({"message": "An internal error occurred."}), 500
    else:
        return jsonify({"message": "User not found"}), 404


# Get all users (admin only)
@app.route('/api/auth/admin/getAllUsers', methods=['GET'])
def get_all_users():
    try:
        users = User.query.order_by(User.id).all()
        users_list = [{
            'id': user.id,
            'username': user.username,
            'full_user': user.full_user,
            'is_admin': user.is_admin
        } for user in users]
        return jsonify({"users": users_list}), 200
    except Exception as ex:
        app.logger.error(f"Error fetching users: {ex}")
        return jsonify({"message": "Failed to fetch users"}), 500

def cancel_jobs(reservation_id):
    job_ids = [
        f"res-{reservation_id}-start",
        f"res-{reservation_id}-end"
    ]

    for job_id in job_ids:
        try:
            job = Job.fetch(job_id, connection=redis)
            job.cancel()
            app.logger.info(f"Cancelled job: {job_id}")
        except Exception as job_ex:
            app.logger.warning(f"Could not cancel job {job_id}: {job_ex}")

# Delete user and their reservations (admin only)
@app.route('/api/auth/admin/deleteUser', methods=['DELETE'])
def delete_user():
    data = request.get_json()
    user_id = data.get('user_id')

    if not user_id:
        return jsonify({"message": "User ID is required"}), 400

    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({"message": "User not found"}), 404

        # Delete all reservations for this user
        reservations = Reservation.query.filter_by(username=user.username).all()

        for reservation in reservations:
            cancel_jobs(reservation.id)

        # Delete the user, all reservation of the user are cancelled too (on cascade constraint)
        db.session.delete(user)
        db.session.commit()

        return jsonify({"message": "User and related reservations deleted successfully"}), 200
    except Exception as ex:
        db.session.rollback()
        app.logger.error(f"Error deleting user: {ex}")
        return jsonify({"message": "Failed to delete user"}), 500


# Update user permissions (admin only)
@app.route('/api/auth/admin/updateUser', methods=['PUT'])
def update_user():
    data = request.get_json()
    user_id = data.get('user_id')
    full_user = data.get('full_user')
    is_admin = data.get('is_admin')
    current_user_id = data.get('current_user_id')

    if not user_id:
        return jsonify({"message": "User ID is required"}), 400

    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({"message": "User not found"}), 404

        # Update fields
        if full_user is not None:
            user.full_user = full_user

        # Only update is_admin if not modifying self
        if is_admin is not None and user_id != current_user_id:
            user.is_admin = is_admin

        db.session.commit()
        return jsonify({"message": "User updated successfully"}), 200
    except Exception as ex:
        db.session.rollback()
        app.logger.error(f"Error updating user: {ex}")
        return jsonify({"message": "Failed to update user"}), 500


# Get all reservations with devices (admin only)
@app.route('/api/auth/admin/getAllReservations', methods=['GET'])
def get_all_reservations():
    try:
        reservations = Reservation.query.order_by(Reservation.startDate.desc(), Reservation.startTime.desc()).all()
        reservations_list = []

        for res in reservations:
            # Get devices for this reservation
            devices = ReservationDevice.query.filter_by(reservation_id=res.id).all()
            device_tags = [dev.asset_tag for dev in devices]

            reservations_list.append({
                'id': res.id,
                'username': res.username,
                'start_date': res.startDate.isoformat(),
                'end_date': res.endDate.isoformat(),
                'start_time': res.startTime.strftime('%H:%M'),
                'end_time': res.endTime.strftime('%H:%M'),
                'has_token': res.token is not None,
                'devices': device_tags
            })

        return jsonify({"reservations": reservations_list}), 200
    except Exception as ex:
        app.logger.error(f"Error fetching reservations: {ex}")
        return jsonify({"message": "Failed to fetch reservations"}), 500


# Delete reservation and cancel Redis jobs (admin only)
@app.route('/api/auth/admin/deleteReservation', methods=['DELETE'])
def delete_reservation():
    data = request.get_json()
    reservation_id = data.get('reservation_id')

    if not reservation_id:
        return jsonify({"message": "Reservation ID is required"}), 400

    try:
        reservation = Reservation.query.get(reservation_id)
        if not reservation:
            return jsonify({"message": "Reservation not found"}), 404

        # Cancel Redis jobs
        cancel_jobs(reservation_id)

        # Delete reservation (CASCADE will delete ReservationDevice entries)
        db.session.delete(reservation)
        db.session.commit()

        return jsonify({"message": "Reservation deleted successfully"}), 200
    except Exception as ex:
        db.session.rollback()
        app.logger.error(f"Error deleting reservation: {ex}")
        return jsonify({"message": "Failed to delete reservation"}), 500

@app.route('/api/auth/admin/redeployContainerlab', methods=['GET'])
def redeploy_containerlab():
    # executes containerlab destruction and deployment remotely, and cleans known_hosts locally. Streams output in real-time.
    
    def generate_output():
        yield "--- Starting Containerlab Redeployment ---\n\n"
        # yield from the shared generator without providing file content
        yield from stream_containerlab_deployment(file_content=None)

    # return the generator as a plain text stream
    return Response(generate_output(), mimetype='text/plain')

@app.route('/api/auth/admin/uploadTopology', methods=['POST'])
def upload_topology():
    # new topology upload and deployment
    file = request.files.get('file')
    
    if not file:
        return jsonify({"message": "File missing"}), 400

    # read the YAML file content
    original_yaml_content = file.read().decode('utf-8')
    
    def generate_output():
        yield "--- Starting Topology Upload and Deployment ---\n\n"
        
        try:
            # parse YAML to validate and modify
            topology_data = yaml.safe_load(original_yaml_content)

            # validate YAML structure
            yield ">>> Validating YAML structure...\n"
            is_valid, error_msg = validate_topology_structure(topology_data)
            if not is_valid:
                yield f"\n[ERROR] Structural Validation Failed: {error_msg}\n"
                yield "Deployment aborted.\n"
                return

            nodes = topology_data.get('topology', {}).get('nodes', {})
            
            # check NetBox inventory for device existence
            yield ">>> Validating nodes and IP addresses against NetBox inventory...\n"
            try:
                # initialize NetBox client
                nb = pynetbox.api(url=NETBOX_URL, token=NETBOX_TOKEN)
            except Exception as e:
                yield f"\n[ERROR] Failed to initialize NetBox client: {e}\n"
                return

            # validate each node
            for node_name, values in nodes.items():
                yaml_ip = values.get('mgmt-ipv4')

                dev = nb.dcim.devices.get(name=node_name)
                netbox_obj = None

                # if not found return error
                if dev:
                    netbox_obj = dev
                else:
                    yield f"\n[ERROR] Validation Failed: Node '{node_name}' does not exist in NetBox inventory.\n"
                    yield "Deployment aborted.\n"
                    return

                # extract primary IP from NetBox object
                primary_ip_obj = getattr(netbox_obj, "primary_ip", None)
                raw_ip = None
                if primary_ip_obj:
                    raw_ip = getattr(primary_ip_obj, "address", None) or (primary_ip_obj.get("address") if isinstance(primary_ip_obj, dict) else None)

                if not raw_ip:
                    yield f"\n[ERROR] Validation Failed: Node '{node_name}' has no primary IP configured in NetBox.\n"
                    yield "Deployment aborted.\n"
                    return
                
                # NetBox IP includes CIDR (e.g., 192.168.1.1/24), we strip it for comparison
                netbox_ip = str(raw_ip).split('/')[0]
                
                if netbox_ip != yaml_ip:
                    yield f"\n[ERROR] Validation Failed: IP mismatch for '{node_name}'.\n"
                    yield f"    - YAML mgmt-ipv4: {yaml_ip}\n"
                    yield f"    - NetBox Primary IP: {netbox_ip}\n"
                    yield "Deployment aborted.\n"
                    return
            
            yield ">>> Validation passed. Modifying topology for agent system...\n"
            
            # create strictly filtered plain topology
            plain_topology = {
                "name": topology_data["name"],
                "topology": {
                    "nodes": {},
                    "links": []
                }
            }

            # filter nodes
            for node_name, attrs in nodes.items():
                plain_topology['topology']['nodes'][node_name] = {
                    "kind": f"{attrs['kind']} ({attrs['image']})",
                    "mgmt-ipv4": attrs['mgmt-ipv4']
                }

            # filter links and apply InlineList formatting
            for link in topology_data['topology']['links']:
                plain_topology['topology']['links'].append({
                    "endpoints": InlineList(link['endpoints'])
                })

            # save modified plain topology
            base_dir = os.path.dirname(os.path.abspath(__file__))
            agents_util_dir = os.path.join(base_dir, "..", "agent", "agents_util")
            os.makedirs(agents_util_dir, exist_ok=True)

            plain_yaml_path = os.path.join(agents_util_dir, "topology_plain.yaml")
            
            with open(plain_yaml_path, 'w') as plain_file:
                yaml.safe_dump(plain_topology, plain_file, default_flow_style=False, sort_keys=False)
                
            yield f">>> Saved strictly formatted topology to {plain_yaml_path}l\n"

            # yield from the shared deployment generator, passing the original content
            yield from stream_containerlab_deployment(original_yaml_content)

        except yaml.YAMLError as exc:
            yield f"\n[ERROR] Invalid YAML format: {exc}\n"
        except Exception as e:
            yield f"\n[EXCEPTION] {str(e)}\n"

    return Response(generate_output(), mimetype='text/plain')

if __name__ == '__main__':
    with app.app_context():
        # create tables on the DB, if they don't exist
        try:
            db.create_all()
            print("PostgresSQL Database tables created/checked.")
        except Exception as e:
            print(f"ERROR: Could not connect to PostgresSQL. Ensure the DB server is running and accessible: {e}")

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5000, use_reloader=False)