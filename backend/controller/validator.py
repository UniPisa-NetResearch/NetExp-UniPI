import os
import json
import shutil
import time
import uuid
from rq import Queue
from rq.job import Job
from redis import Redis
from flask import jsonify, request, send_file, make_response
from ..database.db import db, User
import yaml
import io
import re
import zipfile
import jsonschema
from jsonschema import ValidationError


from ..app import app

from .controller import (
    ensure_inventory_dir, safe_filename, run_ansible_playbook, win_to_wsl_path,
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

def download_helper(inv_path):

    # parse hosts from inventory
    hosts = []
    with open(inv_path, "r", encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("["):
                continue
            parts = line.split()
            host_key = parts[0]

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

    # ensure controllerPlaybooks dir exists (folder next to BASE_DIR)
    os.makedirs(CONTROLLER_PLAYBOOKS_DIR, exist_ok=True)

    # output filename: res_<reservation_id>_playbook_template.yml
    safe_out_name = safe_filename(f"res_{reservation_id}_playbook_template")
    out_filename = f"{safe_out_name}.yml"
    out_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, out_filename)

    # return the file as attachment for download
    try:
        with open(out_path, 'rb') as f:
            content = f.read()

        buf = io.BytesIO(content)
        buf.seek(0)
        response = make_response(send_file(buf, as_attachment=True, download_name=out_filename, mimetype="text/yaml"))
        response.headers["Content-Length"] = str(len(content))
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

    target_hosts = download_helper(inv_path)

    if not target_hosts:
        return jsonify({"ok": False, "message": "No devices found in inventory to fetch configs from."}), 404

    # ensure controllerConfigs dir exists
    os.makedirs(CONTROLLER_CONFIGS_DIR, exist_ok=True)

    if TEST:
        controller_configs_dir_wsl = win_to_wsl_path(CONTROLLER_CONFIGS_DIR)
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

def schema_from_template(tpl):
   # create json schema from res_<reservation_id>_playbook_template to validate the playbook received
    if isinstance(tpl, dict):
        props = {}
        for k, v in tpl.items():
            if k == "commands_map":
                # commands_map must be object type, but its properties are free
                props[k] = {"type": "object", "additionalProperties": True}
            else:
                props[k] = schema_from_template(v)
        return {
            "type": "object",
            "properties": props,
            "required": list(props.keys()),
            "additionalProperties": False
        }

    # list -> impose same length and validate each element per index
    if isinstance(tpl, list):
        # if empty list, we ask an empty list
        if len(tpl) == 0:
            return {"type": "array", "minItems": 0, "maxItems": 0, "items": {"type": "array", "maxItems": 0}}
        # if list with N elements: items = [schema(elem0), schema(elem1), ...] and min/maxItems = N
        items_schema = schema_from_template(tpl[0])
        return {
            "type": "array",
            "items": items_schema,
            "minItems": len(tpl),
            "maxItems": len(tpl)
        }

    if isinstance(tpl, bool):
        return {"type": "boolean"}
    if isinstance(tpl, int):
        return {"type": "integer"}
    if isinstance(tpl, float):
        return {"type": "number"}
    # default: string
    return {"type": "string"}

def extract_hosts_from_inventory(inv_path):
    inventory_hosts = set()

    with open(inv_path, "r", encoding="utf-8") as inv_fh:
        for raw_line in inv_fh:
            line = raw_line.strip()
            if not line or line.startswith("#") or line.startswith("["):
                continue
            parts = line.split()
            if parts:
                inventory_hosts.add(parts[0])

    return inventory_hosts

def get_commands_map_keys_from_playbook(playbook_obj):
    # given the loaded playbook, find keys of commands_map section (they are the hostnames)

    keys = set()
    # playbook could be a list of plays
    if isinstance(playbook_obj, list):

        for play in playbook_obj:

            if not isinstance(play, dict):
                continue
            vars_block = play.get('vars') or {}
            cm = vars_block.get('commands_map')

            if isinstance(cm, dict):
                keys.update(cm.keys())

    elif isinstance(playbook_obj, dict):
        vars_block = playbook_obj.get('vars') or {}
        cm = vars_block.get('commands_map')

        if isinstance(cm, dict):
            keys.update(cm.keys())

    return keys

def find_task_for_commands(playbook_obj):
    # iterate plays/tasks to find a task whose name includes 'Run commands' and return that task dict (or None)

    if isinstance(playbook_obj, list):
        for play in playbook_obj:
            tasks = play.get('tasks') if isinstance(play, dict) else None
            if tasks and isinstance(tasks, list):
                for t in tasks:
                    name = t.get('name') if isinstance(t, dict) else None
                    if name and 'Run commands' in name:
                        return t
    elif isinstance(playbook_obj, dict):
        tasks = playbook_obj.get('tasks')
        if tasks and isinstance(tasks, list):
            for t in tasks:
                name = t.get('name') if isinstance(t, dict) else None
                if name and 'Run commands' in name:
                    return t
    return None

def is_user_full(username):

    user = db.session.query(User).filter_by(username=username).first()
    full_user = getattr(user, "full_user", None)

    if full_user is True:
        return True
    else:
        return False

def execute_user_playbook(inv_path, playbook_path, extra_vars=None, timeout=900):

    try:
        rc, out, err = run_ansible_playbook(inv_path, playbook_path, extra_vars=extra_vars or {}, timeout=timeout)
        result = {
            "rc": rc,
            "stdout": out,
            "stderr": err,
            "ok": rc == 0
        }
    except Exception as e:
        # In caso di eccezione catturata dal worker
        result = {
            "rc": -1,
            "stdout": "",
            "stderr": f"Exception while running playbook: {e}",
            "ok": False
        }
    return result

@app.route("/api/validator/runPlaybook", methods=["POST"])
def run_playbook():

    # get form fields
    if 'playbook' not in request.files:
        return jsonify({"ok": False, "message": "Missing 'playbook' file in form-data"}), 400
    f = request.files['playbook']
    username = request.form.get('username')
    reservation_id = request.form.get('reservation_id')

    if not username:
        return jsonify({"ok": False, "message": "Missing 'username' field"}), 400
    if not reservation_id:
        return jsonify({"ok": False, "message": "Missing 'reservation_id' field"}), 400

    # locate controller template for this reservation
    safe_template_name = safe_filename(f"res_{reservation_id}_playbook_template")
    template_filename = f"{safe_template_name}.yml"
    template_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, template_filename)

    if not os.path.exists(template_path):
        return jsonify({"ok": False, "message": f"Template file not found on controller: {template_path}"}), 404

    try:
        with open(template_path, "r", encoding="utf-8") as tf:
            template_text = tf.read()
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to read template file {f.filename}: {e}"}), 500

    # read uploaded file bytes & parse YAML
    try:
        uploaded_bytes = f.read()
        # ensure string for YAML
        uploaded_text = uploaded_bytes.decode("utf-8")
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to read uploaded file {f.filename}: {e}"}), 400

    try:
        playbook_obj = yaml.safe_load(uploaded_text)
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to parse uploaded YAML {f.filename}: {e}"}), 400

    try:
        template_obj = yaml.safe_load(template_text)
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to parse controller template YAML: {e}"}), 400

    schema = schema_from_template(template_obj)

    try:
        jsonschema.validate(instance=playbook_obj, schema=schema)
    except ValidationError as ve:
        return jsonify({"ok": False, "message": f"Playbook structure mismatch for {f.filename}: {ve.message}"}), 400

    # host check: read hosts from inventory and ensure uploaded hosts are subset
    inv_dir = ensure_inventory_dir()
    safe_inv = safe_filename(f"res-{reservation_id}-inventory")
    inv_path = os.path.join(inv_dir, f"{safe_inv}.ini")

    if not os.path.exists(inv_path):
        return jsonify({"ok": False, "message": f"Inventory not found: {inv_path}"}), 404

    # parse hosts from inventory file: take first token of non-empty/non-comment/non-group lines
    inventory_hosts = extract_hosts_from_inventory(inv_path)

    # find commands_map hosts declared under commands_map in the uploaded playbook
    uploaded_hosts = get_commands_map_keys_from_playbook(playbook_obj)
    uploaded_hosts_set = set(uploaded_hosts)

    # allow uploaded hosts to be a subset of inventory hosts; if any host not in inventory -> error
    invalid_hosts = sorted(list(uploaded_hosts_set - inventory_hosts))
    if invalid_hosts:
        return jsonify({
            "ok": False,
            "message": f"Playbook {f.filename} contains host(s) not present in the reservation inventory",
            "invalid_hosts": invalid_hosts,
            "inventory_hosts": sorted(list(inventory_hosts))
        }), 400

    # find the task that runs commands and validate become_user
    task = find_task_for_commands(playbook_obj)
    if not task:
        return jsonify({"ok": False, "message": f"Could not find task that runs commands (name containing 'Run commands') in {f.filename}"}), 400

    become_user = task.get('become_user')

    # become_user must match the provided username
    if become_user != username:
        return jsonify({
            "ok": False,
            "message": f"become_user in playbook {f.filename} does not match provided username",
            "expected_become_user": username,
            "found_become_user": become_user
        }), 400

    expected_cmds = r"{{ commands_map[inventory_hostname] | default([]) | map('regex_replace', '^\s*sudo\s+', 'sudo -n ') | list}}"

    # obtain the 'cmds' value from the located task (if any)
    task_vars = task.get('vars') or {}
    actual_cmds = task_vars.get('cmds')

    if actual_cmds is None or actual_cmds != expected_cmds:
        return jsonify({
            "ok": False,
            "message": f"'cmds' expression in playbook {f.filename} differs from the required template and cannot be executed"
        }), 400

    # check user privilege: if user is full_user skip dangerous command checks
    is_full = is_user_full(username)

    dangerous_prefixes = ['ip', 'vtysh', 'config', 'tc']
    bad_commands = []

    if not is_full:
        # collect command strings per host from commands_map and search for dangerous prefixes
        commands_map = {}
        if isinstance(playbook_obj, list):
            for play in playbook_obj:
                if isinstance(play, dict):
                    vars_block = play.get('vars') or {}
                    cm = vars_block.get('commands_map')
                    if isinstance(cm, dict):
                        commands_map.update(cm)
        elif isinstance(playbook_obj, dict):
            vars_block = playbook_obj.get('vars') or {}
            cm = vars_block.get('commands_map')
            if isinstance(cm, dict):
                commands_map.update(cm)

        # inspect each command string for disallowed prefixes
        for host, cmds in commands_map.items():
            # if user provided a single multiline string, split into lines
            if isinstance(cmds, str):
                cmd_list = [ln for ln in cmds.splitlines() if ln.strip()]
            elif isinstance(cmds, list):
                cmd_list = cmds
            else:
                # unknown format, skip
                continue

            for c in cmd_list:
                if not isinstance(c, str):
                    continue
                s = c.strip().lower()
                if not s:
                    continue

                # get tokens, skip leading 'sudo' if present
                tokens = re.split(r'\s+', s)
                primary = tokens[0] if tokens else ''
                if primary == 'sudo' and len(tokens) > 1:
                    primary = tokens[1]

                # extract the leading word characters only
                m = re.match(r'^([a-z0-9_+-]+)', primary)
                if not m:
                    continue
                primary_word = m.group(1)

                # exact-match check: only the keywords listed are forbidden
                if primary_word in dangerous_prefixes:
                    bad_commands.append({
                        "host": host,
                        "command": c,
                        "found_prefix": primary_word
                    })

    if bad_commands:
        # build message instructing replacement
        replacements = {
            "ip": "res_ip",
            "vtysh": "res_vtysh",
            "config": "res_config",
            "tc": "res_tc"
        }
        hints = []
        used = set()
        for b in bad_commands:
            used.add(b["found_prefix"])
        for u in sorted(used):
            hints.append(f"use '{replacements.get(u, 'res_'+u)}' instead of '{u}'")
        return jsonify({
            "ok": False,
            "message": f"Playbook {f.filename} contains commands not allowed for your account " + "; ".join(hints),
            "bad_commands": bad_commands
        }), 400

    # all checks passed: save uploaded playbook into USER_PLAYBOOKS_DIR/res_<reservation_id>/
    try:
        target_dir_name = safe_filename(f"res_{reservation_id}")
        target_dir = os.path.join(USER_PLAYBOOKS_DIR, target_dir_name)
        os.makedirs(target_dir, exist_ok=True)
        # use original filename
        original_filename = f.filename or f"uploaded_playbook_{int(time.time())}.yml"
        safe_name = safe_filename(original_filename)
        if not safe_name.lower().endswith(('.yml', '.yaml')):
            # ensure extension
            safe_name = safe_name + ".yml"
        target_path = os.path.join(target_dir, safe_name)

        # write file (overwrite if exists)
        with open(target_path, "wb") as fh:
            fh.write(uploaded_bytes)

    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to save uploaded playbook {f.filename}: {e}"}), 500

    # execute playbook
    try:
        exec_inv_path = inv_path
        exec_playbook_path = target_path

        # sync execution
        result = execute_user_playbook(exec_inv_path, exec_playbook_path, timeout=900)

        if result.get("ok"):
            return jsonify({
                "ok": True,
                "message": f"Playbook {f.filename} executed successfully",
                "rc": result.get("rc"),
                "stdout": result.get("stdout"),
                "stderr": result.get("stderr")
            }), 200
        else:
            return jsonify({
                "ok": False,
                "message": f"Playbook {f.filename} execution failed",
                "rc": result.get("rc"),
                "stdout": result.get("stdout"),
                "stderr": result.get("stderr")
            }), 500

    except Exception as e:
        # eccezione imprevista durante l'esecuzione
        return jsonify({
            "ok": False,
            "message": f"Exception while executing playbook {f.filename}: {e}"
        }), 500


if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5003)