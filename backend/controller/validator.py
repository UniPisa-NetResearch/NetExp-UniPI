import os
import json
import time
import uuid
from rq import Queue
from rq.job import Job
from redis import Redis
from flask import jsonify, request
import yaml
from jinja2 import Environment
from ..app import app

from .controller import (
    ensure_inventory_dir, safe_filename, run_ansible_playbook, BASE_DIR
)

# Redis connection
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
redis_conn = Redis(host=REDIS_HOST, port=REDIS_PORT, db=0, decode_responses=True)

q = Queue("playbooks", connection=redis_conn)

# directory for loaded user playbooks
USER_PLAYBOOKS_DIR = os.path.join(BASE_DIR, "userPlaybooks")
os.makedirs(USER_PLAYBOOKS_DIR, exist_ok=True)

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

if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5003)