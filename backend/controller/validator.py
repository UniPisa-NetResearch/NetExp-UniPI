import os
import json
import shutil
import time
import uuid
from rq import Queue
from rq.job import Job
from redis import Redis
from flask import jsonify, request, send_file, make_response
import yaml
import io
import re
from jinja2 import Environment
import zipfile

from tensorflow_probability.python.internal.backend.jax import truediv

from ..app import app

from .controller import (
    ensure_inventory_dir, safe_filename, run_ansible_playbook,
    CONTROLLER_PLAYBOOKS_DIR,
    CONTROLLER_CONFIGS_DIR,
    USER_PLAYBOOKS_DIR
)
# true if development mode is active
TEST = True
# Redis connection
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
redis_conn = Redis(host=REDIS_HOST, port=REDIS_PORT, db=0, decode_responses=True)

q = Queue("playbooks", connection=redis_conn)

# suffix of playbook template for the reservation
OUTPUT_TEMPLATE_SUFFIX = "playbook_template.yml"
# playbook template schema
INPUT_TEMPLATE_CONTENT = """- name: Apply per-host commands
  hosts: all
  gather_facts: no
  vars:
    commands_map:
      # insert a list of commands after each device

  tasks:
    - name: Run commands from commands_map
      vars:
        cmds: "{{ commands_map[inventory_hostname] | default([]) }}"
      ansible.builtin.shell: |
        {% for c in cmds %}
        {{ c }}
        {% endfor %}
"""

# save new files (if the name is the same, add a number to the name)
def save_file_with_increment(target_dir: str, filename: str, file_stream) -> tuple[str, str]:
    os.makedirs(target_dir, exist_ok=True)
    base, ext = os.path.splitext(filename)  #base = file name, ext = extension
    candidate = f"{base}{ext}"
    i = 0
    while os.path.exists(os.path.join(target_dir, candidate)):
        i += 1
        candidate = f"{base}{i}{ext}"
    path = os.path.join(target_dir, candidate)
    file_stream.save(path)

    return path, candidate

# Validazione playbook (heuristic)
# Security policy: allow all configuration commands except those touching management interface or modifying files
ALLOWED_MODULES = {
"ansible.builtin.shell",
"shell",
"ansible.builtin.command",
"command",
"ansible.builtin.copy",
"copy",
"ansible.builtin.template",
"template",
"ansible.builtin.include_tasks",
"include_tasks",
}
FORBIDDEN_KEYWORDS = ["management", "mgmt", "ansible_network_interfaces", "ansible_host"]
FORBIDDEN_FILE_COMMANDS = ["touch", "rm", "mv", "cp", "mkdir"]

def parse_inventory_for_hosts_and_res_iface(inventory_path: str) -> (dict, dict):
    hosts_info = {}
    res_iface_map = {}
    if not inventory_path or not os.path.exists(inventory_path):
        return hosts_info, res_iface_map

    with open(inventory_path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or line.startswith("["):
                continue
            parts = line.split()
            if len(parts) == 0:
                continue

            hostname = parts[0]
            kv = {}
            for token in parts[1:]:
                if "=" in token:
                    k, v = token.split("=", 1)
                    kv[k] = v

            hosts_info[hostname] = kv

            if "res_iface" in kv:
                res_iface_map[hostname] = kv["res_iface"]

    return hosts_info, res_iface_map

def validate_playbook_file(playbook_path: str, reservation_inventory_path: str) -> (bool, str):
    try:
        with open(playbook_path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except Exception as e:
        return False, f"YAML parse error: {e}"

    # playbook could be list of plays or a single dict
    plays = data if isinstance(data, list) else [data]
    hosts_info, res_iface_map = parse_inventory_for_hosts_and_res_iface(reservation_inventory_path)
    inv_hosts = set(hosts_info.keys())

    for play in plays:
        if not isinstance(play, dict):
            return False, "Playbook must be a list of plays or a play dict."
        hosts = play.get("hosts")
        if not hosts:
            return False, "Playbook must have 'hosts' key"
        # hosts could be comma-separated or list
        host_list = []
        if isinstance(hosts, str):
            host_list = [h.strip() for h in hosts.split(",") if h.strip()]
        elif isinstance(hosts, list):
            host_list = hosts
        # check if hosts are present in inventory
        if inv_hosts and not set(host_list).issubset(inv_hosts):
            missing = set(host_list) - inv_hosts
            return False, f"Host(s) referenced not present in inventory: {', '.join(missing)}"

        tasks = play.get("tasks", [])
        # tasks could also be under roles -> tasks; check top-level tasks
        for t in tasks:
            if not isinstance(t, dict):
                continue
            # detect modules (Ansible task keys other than 'name', 'when', etc.)
            # Common pattern: task dict has a single key being module name (e.g. 'copy', 'command')
            for k in t.keys():
                if k in ("name", "when", "vars", "register", "become", "become_user", "with_items", "tags", "delegate_to") :
                    continue
                # if the key is a forbidden module
                if k in ALLOWED_MODULES:
                    return False, f"Task uses disallowed module/key '{k}'. Allowed modules: {', '.join(sorted(ALLOWED_MODULES))}"
                # if command/args contain forbidden patterns
                val = t.get(k)
                # convert to string and check patterns
                as_str = json.dumps(val) if val is not None else ""

                for kw in FORBIDDEN_KEYWORDS:
                    if kw in as_str:
                        return False, f"Playbook references forbidden keyword '{kw}'."

                for host in host_list:
                    mgmt = res_iface_map.get(host)
                    if mgmt and mgmt in as_str:
                        return False, f"Playbook attempts to operate on management interface '{mgmt}' of host '{host}', which is forbidden."

                for cmd in FORBIDDEN_FILE_COMMANDS:
                    if cmd in as_str:
                        return False, f"Playbook contains forbidden file operation '{cmd}'."

    return True, "Valid playbook"

# optional: validate Jinja2 template syntax
def validate_template_syntax(template_path: str, reservation_inventory_path: str = None) -> (bool, str):
    try:
        with open(template_path, "r", encoding="utf-8") as fh:
            src = fh.read()
        env = Environment()
        env.parse(src)  # raises exception if invalid
        for kw in FORBIDDEN_KEYWORDS:
            if kw in src:
                return False, f"Template references forbidden keyword '{kw}'."

        if reservation_inventory_path:
            _, res_iface_map = parse_inventory_for_hosts_and_res_iface(reservation_inventory_path)
            for host, mgmt in res_iface_map.items():
                if mgmt and mgmt in src:
                    return False, f"Template attempts to operate on management interface '{mgmt}' of host '{host}', which is forbidden."

        for cmd in FORBIDDEN_FILE_COMMANDS:
            if cmd in src:
                return False, f"Template contains forbidden file operation '{cmd}'."

        return True, "Valid template"

    except Exception as e:
        return False, f"Not valid template: {e}"

# worker task: run ansible and store result in Redis under job_result:<job_id>
def worker_run_playbook(inventory_path, playbook_path, extra_vars=None, job_id=None, timeout=600):
    rc, out, err = run_ansible_playbook(inventory_path, playbook_path, extra_vars=extra_vars, timeout=timeout)
    result = {
        "rc": rc,
        "stdout": out,
        "stderr": err,
        "completed_at": time.time()
    }
    # store result JSON
    redis_conn.set(f"job_result:{job_id}", json.dumps(result))

    return result

def windows_to_wsl_path(p: str) -> str:

    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m:
        drive = m.group(1).lower()
        rest = m.group(2).replace("\\", "/")
        return f"/mnt/{drive}/{rest}"
    # fallback
    return p.replace("\\", "/")

# Endpoint: upload files and submit job (config or test)
@app.route("/api/validator/submitPlaybook", methods=["POST"])
def submit_playbook():

    username = request.form.get("username")
    reservation_id = request.form.get("reservation_id")

    if not username:
        return jsonify({"ok": False, "message": "Missing username"}), 400
    if "playbook" not in request.files:
        return jsonify({"ok": False, "message": "Missing playbook file"}), 400

    playbook_file = request.files["playbook"]
    template_file = request.files.get("template")

    # prepare user dir
    user_dir = os.path.join(USER_PLAYBOOKS_DIR, f"{safe_filename(username)}Playbooks")
    templates_dir = os.path.join(user_dir, "templates")
    os.makedirs(templates_dir, exist_ok=True)

    # save playbook with incrementing name
    playbook_path, playbook_saved_name = save_file_with_increment(user_dir, playbook_file.filename, playbook_file)

    # save template if present
    template_saved_name = None
    template_path = None
    if template_file:
        template_path, template_saved_name = save_file_with_increment(templates_dir, template_file.filename, template_file)

    # Determine inventory path: if reservation_id provided, we expect inventories/res-<reservation>-inventory.ini
    inv_path = None
    if reservation_id:
        safe_res = safe_filename(f"res-{reservation_id}-inventory")
        inv_path_candidate = os.path.join(ensure_inventory_dir(), f"{safe_res}.ini")
        if os.path.exists(inv_path_candidate):
            inv_path = inv_path_candidate

    # validate playbook
    valid, msg = validate_playbook_file(playbook_path, inv_path or "")
    if not valid:
        return jsonify({"ok": False, "message": f"Playbook validation failed: {msg}"}), 400

    # optional: validate template syntax
    if template_path:
        template_valid, tmsg = validate_template_syntax(template_path, reservation_inventory_path=inv_path or None)
        if not template_valid:
            return jsonify({"ok": False, "message": f"Template validation failed: {tmsg}"}), 400

    # enqueue worker task
    job_id = str(uuid.uuid4())
    extra_vars = {"username": username, "ansible_user": username, "ansible_become": True,
                  "ansible_become_user": username}
    # you can pass username/reservation to extra_vars if needed by playbook
    if reservation_id:
        extra_vars["reservation_id"] = reservation_id

    # enqueue the worker_run_playbook job
    q.enqueue(worker_run_playbook, inv_path, playbook_path, extra_vars, job_id, timeout=1800, job_id=job_id)

    # return job id so client can do polling, to get the result
    return jsonify({
        "ok": True,
        "message": "Playbook queued",
        "job_id": job_id,
        "playbook_saved": playbook_saved_name,
        "template_saved": template_saved_name
    }), 202

@app.route("/api/validator/jobStatus", methods=["GET"])
def job_status():
    job_id = request.args.get("job_id")
    if not job_id:
        return jsonify({"ok": False, "message": "Missing job_id"}), 400

    # check RQ job and check result key
    job_result = redis_conn.get(f"job_result:{job_id}")
    if job_result:
        return jsonify({"ok": True, "status": "finished", "result": json.loads(job_result)}), 200

    # else check if job exists and is queued/started
    job = Job.fetch(job_id, connection=redis_conn)
    if job.is_queued:
        return jsonify({"ok": True, "status": "queued"}), 200
    if job.is_started:
        return jsonify({"ok": True, "status": "started"}), 200
    if job.is_failed:
        return jsonify({"ok": True, "status": "failed", "exc_info": job.latest_result()}), 200

    return jsonify({"ok": True, "status": "pending"}), 200

def download_helper(data, file_type, inv_path):

    # parse hosts from inventory
    hosts = []
    with open(inv_path, "r", encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("["):
                continue
            parts = line.split()
            host_key = parts[0]
            res_iface = None
            for token in parts[1:]:
                m = re.match(r"role=(\S+)", token)
                if m:
                    role = m.group(1)
                    # if device is a host, assign a non-management host interface, otherwise a non-management switch interface
                    if role == "host":
                        res_iface = "enp1s0"
                    else:
                        res_iface = "eth1"

            if file_type == "playbook":
                hosts.append({"host": host_key, "iface": res_iface})
            elif file_type == "template" and role != "host":
                hosts.append(host_key)

    return hosts

@app.route('/api/validator/downloadPlaybook', methods=['POST'])
def download_playbook():
    # create controllerPlaybooks/res_<reservation_id>_playbook_template.yml based on the playbook template content and return the file

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "message": "Missing JSON body"}), 400

    reservation_id = data.get("reservation_id")
    if reservation_id is None:
        return jsonify({"ok": False, "message": "Missing reservation_id"}), 400

    # inventory path
    inv_dir = ensure_inventory_dir()
    safe_res = safe_filename(f"res-{reservation_id}-inventory")
    inv_path = os.path.join(inv_dir, f"{safe_res}.ini")

    if not os.path.exists(inv_path):
        return jsonify({"ok": False, "message": f"Inventory not found: {inv_path}"}), 404

    hosts = download_helper(data, "playbook", inv_path)

    # ensure controllerPlaybooks dir exists (folder next to BASE_DIR)
    os.makedirs(CONTROLLER_PLAYBOOKS_DIR, exist_ok=True)

    # output filename: res_<reservation_id>_playbook_template.yml
    safe_out_name = safe_filename(f"res_{reservation_id}_playbook_template")
    out_filename = f"{safe_out_name}.yml"
    out_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, out_filename)
    # build the commented entries to insert into the template
    entries = []
    for h in hosts:
        host = h.get("host")
        ip = "192.168.1.10"
        iface = h.get("iface")
        entries.append((host, ip, iface))

    indent = None

    m = re.search(r'^(\s*)#\s*insert a list of commands after each device\s*$', INPUT_TEMPLATE_CONTENT, flags=re.MULTILINE)
    if m:
        indent = m.group(1)  # leading whitespace of the comment line

    else:
        # fallback: if placeholder not found, try to insert after 'commands_map:' line
        m = re.search(r'^(?P<indent>\s*)commands_map:\s*\n', INPUT_TEMPLATE_CONTENT, flags=re.MULTILINE)
        if m:
            indent = m.group("indent") + "  "  # place entries under commands_map with extra indent

    entries_lines = []
    for (host, ip, iface) in entries:
        # same indent as comment for first line
        entries_lines.append(f"{indent}#{host}:")
        # same indent + two spaces for the command comment
        entries_lines.append(f"{indent}  #- ip addr add {ip}/24 dev {iface}")
    generated_block = "\n".join(entries_lines) if entries_lines else f"{indent}# (no hosts found in inventory)"

    # insert generated_block immediately after the placeholder comment line,
    # but keep the placeholder comment in the file
    insert_pos = m.end()  # end of the matched comment line
    final_content = INPUT_TEMPLATE_CONTENT[:insert_pos] + "\n" + generated_block + INPUT_TEMPLATE_CONTENT[insert_pos:]

    # write file to controllerPlaybooks
    try:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(final_content)
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to write file: {e}"}), 500
    # return the file as attachment for download
    try:
        b = final_content.encode("utf-8")
        buf = io.BytesIO(b)
        buf.seek(0)
        response = make_response(send_file(buf, as_attachment=True, download_name=out_filename, mimetype="text/yaml"))
        response.headers["Content-Length"] = str(len(b))
        return response
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to send file: {e}"}), 500

@app.route("/api/validator/downloadTemplate", methods=["POST"])
def download_template():
    # save <hostname>_config_db.json from non-host devices and create res_<reservation_id>running_configs.zip

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "message": "Missing JSON body"}), 400

    reservation_id = data.get("reservation_id")
    if reservation_id is None:
        return jsonify({"ok": False, "message": "Missing reservation_id"}), 400

    # inventory path
    inv_dir = ensure_inventory_dir()
    safe_res = safe_filename(f"res-{reservation_id}-inventory")
    inv_path = os.path.join(inv_dir, f"{safe_res}.ini")

    if not os.path.exists(inv_path):
        return jsonify({"ok": False, "message": f"Inventory not found: {inv_path}"}), 404

    target_hosts = download_helper(data, "template", inv_path)

    if not target_hosts:
        return jsonify({"ok": False, "message": "No non-host devices found in inventory to fetch configs from."}), 404

    # ensure controllerConfigs dir exists
    os.makedirs(CONTROLLER_CONFIGS_DIR, exist_ok=True)

    if TEST:
        controller_configs_dir_wsl = windows_to_wsl_path(CONTROLLER_CONFIGS_DIR)
    else:
        controller_configs_dir_wsl = CONTROLLER_CONFIGS_DIR

    get_config_playbook_path = os.path.join(CONTROLLER_CONFIGS_DIR, "get_configs_playbook.yml")
    get_config_playbook_path = os.path.normpath(get_config_playbook_path)

    if not os.path.exists(get_config_playbook_path):
        return jsonify({"ok": False, "message": f"Playbook not found: {get_config_playbook_path}"}), 500

    # run the playbook synchronously using the existing inventory
    extra_vars = {"controller_dest_dir": controller_configs_dir_wsl, "reservation_id": reservation_id}

    try:
        rc, out, err = run_ansible_playbook(inv_path, get_config_playbook_path, extra_vars=extra_vars, timeout=900)
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to execute ansible playbook: {e}"}), 500

    if rc != 0:
        return jsonify({
            "ok": False,
            "message": "Ansible playbook failed while fetching configs.",
            "rc": rc,
            "stdout": out,
            "stderr": err
        }), 500

    # expected directory where playbook saved files
    playbook_output_dir = os.path.join(CONTROLLER_CONFIGS_DIR, f"res_{reservation_id}_running_configs")

    # verify directory exists and collect files
    if not os.path.isdir(playbook_output_dir):
        return jsonify({"ok": False, "message": f"No output directory found from playbook: {playbook_output_dir}"}), 500

    # collect fetched files and zip them
    fetched_files = []
    for entry in os.listdir(playbook_output_dir):
        path = os.path.join(playbook_output_dir, entry)
        if os.path.exists(path):
            fetched_files.append(path)

    if not fetched_files:
        # cleanup empty dir
        shutil.rmtree(playbook_output_dir)
        return jsonify({"ok": False, "message": "Playbook completed but no config files were saved on controller."}), 500

    zip_name = f"res_{reservation_id}_running_configs.zip"
    zip_path = os.path.join(CONTROLLER_CONFIGS_DIR, zip_name)
    try:
        with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            for fp in fetched_files:
                config = os.path.basename(fp)
                zf.write(fp, arcname=config)

        # remove the original folder produced by the playbook
        try:
            shutil.rmtree(playbook_output_dir)
        except Exception as e:
            # log warning but don't fail the response
            print(f"Warning: failed to remove playbook output dir {playbook_output_dir}: {e}")

    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to create zip archive: {e}"}), 500

    # return the zip as attachment
    try:
        return send_file(zip_path, as_attachment=True, download_name=zip_name, mimetype="application/zip")
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to send zip file: {e}"}), 500

if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5003)