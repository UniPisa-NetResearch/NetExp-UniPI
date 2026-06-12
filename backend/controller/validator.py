import os
import json
import shutil
import time
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
from ..config import LOCAL_TEST, REDIS_HOST, REDIS_PORT, REDIS_DB
from ..utils import parse_inventory, get_is_virtual_from_db
from .controller import (
    ensure_inventory_dir, safe_filename, run_ansible_playbook, win_to_wsl_path,
    CONTROLLER_PLAYBOOKS_DIR,
    CONTROLLER_CONFIGS_DIR,
    USER_PLAYBOOKS_DIR,
    USER_CONFIGS_DIR
)

# Redis connection
redis_conn = Redis(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB, decode_responses=True)

def get_inventory_path(reservation_id):
    inv_dir = ensure_inventory_dir()
    safe_inv = safe_filename(f"res-{reservation_id}-inventory")
    inv_path = os.path.join(inv_dir, f"{safe_inv}.ini")

    return inv_path

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
    # save <hostname>_config_db.json <hostname>_frr.conf from non-host devices and create res_<reservation_id>running_configs.zip
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "message": "Missing JSON body"}), 400

    reservation_id = data.get("reservation_id")
    if reservation_id is None:
        return jsonify({"ok": False, "message": "Missing reservation_id filed"}), 400

    is_virtual = get_is_virtual_from_db(reservation_id)

    # inventory path
    inv_path = get_inventory_path(reservation_id)

    if not os.path.exists(inv_path):
        return jsonify({"ok": False, "message": f"Inventory not found: {inv_path}"}), 404

    # if test mode, convert path to wsl
    full_dest_dir = os.path.join(CONTROLLER_CONFIGS_DIR, f"res_{reservation_id}_running_configs")
    if LOCAL_TEST:
        controller_configs_dir = win_to_wsl_path(full_dest_dir)
    else:
        controller_configs_dir = full_dest_dir

    # playbook to get config_db and frr files from non host devices
    playbook_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, "get_snapshot_playbook.yml")
    playbook_path = os.path.normpath(playbook_path)

    if not os.path.exists(playbook_path):
        return jsonify({"ok": False, "message": f"Playbook not found: {playbook_path}"}), 500

    # run the playbook using the existing inventory
    extra_vars = {"controller_dest_dir": controller_configs_dir, "type": "configs", "reservation_id": reservation_id, "containerlab_test": is_virtual}

    print(f"controller_configs_dir_wsl = {controller_configs_dir}")
    print(f"Expected output dir (Windows) = {full_dest_dir}")

    try:
        rc, out, err = run_ansible_playbook(inv_path, playbook_path, extra_vars=extra_vars)

    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to execute ansible playbook: {e}"}), 500

    if rc != 0:
        return jsonify({"ok": False, "message": "Ansible playbook failed while fetching configs.", "rc": rc, "stdout": out, "stderr": err}), 500

    # expected directory where playbook saved files
    playbook_output_dir = full_dest_dir

    print(f"Looking for files in: {playbook_output_dir}")
    print(f"Directory exists: {os.path.exists(playbook_output_dir)}")
    if os.path.exists(playbook_output_dir):
        print(f"Directory contents: {os.listdir(playbook_output_dir)}")

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
    # create zip file
    zip_name = f"res_{reservation_id}_running_configs.zip"
    zip_path = os.path.join(CONTROLLER_CONFIGS_DIR, zip_name)
    try:
        with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            for fp in fetched_files:
                config = os.path.basename(fp)
                zf.write(fp, arcname=config)

        # remove the original folder (non-zip) produced by the playbook
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
        # if empty list, we ask a schema which is an empty list
        if len(tpl) == 0:
            return {"type": "array", "minItems": 0, "maxItems": 0, "items": {"type": "array", "maxItems": 0}}
        # if list with N elements: items = [schema(elem0), schema(elem1), ...] and min/maxItems = N
        items_schema = schema_from_template(tpl[0])
        return {"type": "array", "items": items_schema, "minItems": len(tpl), "maxItems": len(tpl)}
    # return type of value wanted
    if isinstance(tpl, bool):
        return {"type": "boolean"}
    if isinstance(tpl, int):
        return {"type": "integer"}
    if isinstance(tpl, float):
        return {"type": "number"}
    # default: string
    return {"type": "string"}

def get_commands_map_keys_from_playbook(playbook_obj):
    # given the loaded playbook, find keys of commands_map section (they are the hostnames)
    keys = set()
    # playbook could be a list of plays
    if isinstance(playbook_obj, list):
        for play in playbook_obj:
            if not isinstance(play, dict):
                continue
            vars_block = play.get('vars') or {}     # get block of vars
            cm = vars_block.get('commands_map')     # get commands_map

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
    # check in the database if the user is limited or not
    user = db.session.query(User).filter_by(username=username).first()
    full_user = getattr(user, "full_user", None)

    if full_user is True:
        return True
    else:
        return False

@app.route("/api/validator/runPlaybook", methods=["POST"])
def run_playbook():

    # get form fields
    if 'playbook' not in request.files:
        return jsonify({"ok": False, "message": "Missing 'playbook' file in form-data"}), 400
    f = request.files['playbook']               # received playbook
    username = request.form.get('username')
    reservation_id = request.form.get('reservation_id')

    if not username or not reservation_id:
        return jsonify({"ok": False, "message": "Missing 'username' or 'reservation_id' field"}), 400

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
    # create schema from template
    schema = schema_from_template(template_obj)
    # validate schema
    try:
        jsonschema.validate(instance=playbook_obj, schema=schema)
    except ValidationError as ve:
        return jsonify({"ok": False, "message": f"Playbook structure mismatch for {f.filename}: {ve.message}"}), 400

    # host check: read hosts from inventory and ensure uploaded hosts are subset
    inv_path = get_inventory_path(reservation_id)

    if not os.path.exists(inv_path):
        return jsonify({"ok": False, "message": f"Reservation inventory not found: {inv_path}"}), 404

    # parse hosts from inventory file: take first token of non-empty/non-comment/non-group lines
    inventory_hosts = parse_inventory(inv_path, return_hosts_only=True)

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
    # key 'cmd' must have the following content
    expected_cmds = r"{{ commands_map[inventory_hostname] | default([]) | map('regex_replace', '^\s*sudo\s+', 'sudo -n ') | list}}"

    # obtain the 'cmds' value from the located task (if any)
    task_vars = task.get('vars') or {}
    actual_cmds = task_vars.get('cmds')

    if actual_cmds is None or actual_cmds != expected_cmds:
        return jsonify({
            "ok": False,
            "message": f"'cmds' expression in playbook {f.filename} differs from the required template and cannot be executed"
        }), 400

    # validate 'when' clause to ensure hosts without commands are skipped
    expected_when = "commands_map[inventory_hostname] is defined and (commands_map[inventory_hostname] | length > 0)"

    actual_when = task.get('when')

    # normalize whitespace for comparison
    def normalize_whitespace(command):
        if command is None:
            return None
        return re.sub(r'\s+', ' ', str(command).strip())

    normalized_expected = normalize_whitespace(expected_when)
    normalized_actual = normalize_whitespace(actual_when)

    if normalized_actual != normalized_expected:
        return jsonify({"ok": False, "message": f"'when' clause in playbook {f.filename} is missing or incorrect. Expected: '{expected_when}'"}), 400

    # check user privilege: if user is full_user skip dangerous command checks
    is_full = is_user_full(username)
    # commands that cannot be executed for limited users
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
                tokens = re.split(r'\s+', s)        # split for spaces
                primary = tokens[0] if tokens else ''      # get first token
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
        rc, out, err = run_ansible_playbook(inv_path, target_path)

        if rc == 0:
            return jsonify({
                "ok": True,
                "message": f"Playbook {f.filename} executed successfully",
                "rc": rc,
                "stdout": out,
                "stderr":err
            }), 200
        else:
            return jsonify({
                "ok": False,
                "message": f"Playbook {f.filename} execution failed",
                "rc": rc,
                "stdout": out,
                "stderr": err
            }), 500

    except Exception as e:
        return jsonify({"ok": False, "message": f"Exception while executing playbook {f.filename}: {e}"}), 500

def validate_config_db_minimal(obj):
    # minimal validation of config_db.json file
    errors = []

    if not isinstance(obj, dict):
        return False, ["Top-level JSON is not an object"]

    # Top-level keys
    for key in ("DEVICE_METADATA", "PORT", "INTERFACE"):
        if key not in obj:
            errors.append(f"Missing top-level key: {key}")
        elif not isinstance(obj.get(key), dict):
            errors.append(f"Top-level key {key} must be an object/dict")

    # DEVICE_METADATA checks
    dm = obj.get("DEVICE_METADATA")
    if isinstance(dm, dict):
        if not dm:
            errors.append("DEVICE_METADATA must contain at least one host entry")
        else:
            # check each host has required fields
            required_dm_fields = {"hostname", "hwsku", "platform", "mac", "type", "bgp_asn"}
            ok_host_found = False
            for host, hostobj in dm.items():
                if not isinstance(hostobj, dict):
                    errors.append(f"DEVICE_METADATA.{host} is not an object")
                    continue
                missing = sorted(list(required_dm_fields - set(hostobj.keys())))
                if not missing:
                    ok_host_found = True
                else:
                    errors.append(f"DEVICE_METADATA.{host} missing fields: {', '.join(missing)}")
            if not ok_host_found:
                errors.append("No DEVICE_METADATA host contains all required fields "
                              "(hostname, hwsku, platform, mac, type, bgp_asn)")

    # PORT checks
    ports = obj.get("PORT")
    if isinstance(ports, dict):
        if not ports:
            errors.append("PORT must contain at least one port entry")
        else:
            required_port_fields = {"lanes", "speed", "index"}
            for port_name, port_obj in ports.items():
                if not isinstance(port_obj, dict):
                    errors.append(f"PORT.{port_name} is not an object")
                    continue
                missing = sorted(list(required_port_fields - set(port_obj.keys())))
                if missing:
                    errors.append(f"PORT.{port_name} missing fields: {', '.join(missing)}")
                # lanes should be present and non-empty
                lanes = port_obj.get("lanes")
                if lanes is None or (isinstance(lanes, str) and not lanes.strip()):
                    errors.append(f"PORT.{port_name}.lanes appears empty")

    # INTERFACE basic check
    iface = obj.get("INTERFACE")
    if isinstance(iface, dict):
        if not iface:
            # it's acceptable for INTERFACE to be empty, but warn
            errors.append("INTERFACE is present but empty")

    ok = len(errors) == 0
    return ok, errors

@app.route("/api/validator/runTemplate", methods=["POST"])
def run_template():

    # get form fields
    if 'template' not in request.files:
        return jsonify({"ok": False, "message": "Missing 'playbook' file in form-data"}), 400
    f = request.files['template']
    username = request.form.get('username')
    reservation_id = request.form.get('reservation_id')

    if not username:
        return jsonify({"ok": False, "message": "Missing 'username' field"}), 400
    if not reservation_id:
        return jsonify({"ok": False, "message": "Missing 'reservation_id' field"}), 400

    is_virtual = get_is_virtual_from_db(reservation_id)

    # inventory path
    inv_path = get_inventory_path(reservation_id)

    if not os.path.exists(inv_path):
        return jsonify({"ok": False, "message": f"Inventory not found: {inv_path}"}), 404

    # load inventory hosts
    inventory_hosts = parse_inventory(inv_path, return_hosts_only=True)
    if not inventory_hosts:
        return jsonify({"ok": False, "message": "No devices found in inventory"}), 404

    # read uploaded zip bytes
    try:
        uploaded_bytes = f.read()
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to read uploaded file {f.filename}: {e}"}), 400

    # validate zip
    try:
        zf = zipfile.ZipFile(io.BytesIO(uploaded_bytes))
    except zipfile.BadZipFile as e:
        return jsonify({"ok": False, "message": f"Uploaded file is not a valid zip archive: {e}"}), 400

    # collect files named <hostname>_config_db.json or <hostname>_frr.conf
    name_re_config = re.compile(r'^(.+)_config_db\.json$')
    name_re_frr = re.compile(r'^(.+)_frr\.conf$')

    zip_basename = os.path.splitext(os.path.basename(f.filename))[0]
    print(f"DEBUG: Looking for folder matching zip name: {zip_basename}")

    all_files = zf.namelist()

    # check existence of folder with same name as zip file
    target_folder = None
    for name in all_files:
        if '/' in name:
            first_part = name.split('/')[0]
            if first_part == zip_basename:
                target_folder = first_part
                break

    if not target_folder:
        return jsonify({"ok": False, "message": f"Zip must contain a folder named '{zip_basename}'"}), 400

    print(f"DEBUG: Found target folder: {target_folder}")

    # check valid name of files inside target directory
    files_map = {}
    invalid_names = []

    for z in zf.infolist():
        # skip directory
        if z.is_dir():
            continue

        # consider only files in target_folder
        if not z.filename.startswith(target_folder + '/'):
            continue

        base = os.path.basename(z.filename)

        # skip if empty file
        if not base:
            continue

        m_cfg = name_re_config.match(base)
        m_frr = name_re_frr.match(base)

        if not (m_cfg or m_frr):
            invalid_names.append(base)
            continue

        hostname = (m_cfg or m_frr).group(1)
        try:
            content_bytes = zf.read(z)
        except Exception as e:
            return jsonify({"ok": False, "message": f"Failed to read {z.filename} from zip: {e}"}), 400

        # save only config_db for JSON visualization (frr.conf is ignored in validation)
        if m_cfg:
            files_map.setdefault(hostname, []).append((base, content_bytes))

    if invalid_names:
        return jsonify({"ok": False, "message": f"Zip contains files with invalid names inside '{target_folder}/' folder: {invalid_names}. Only '<hostname>_config_db.json' and '<hostname>_frr.conf' are allowed"}), 400

    # ensure uploaded hosts are subset of inventory
    uploaded_hosts_set = set(files_map.keys())
    invalid_hosts = sorted(list(uploaded_hosts_set - inventory_hosts))
    if invalid_hosts:
        return jsonify({"ok": False, "message": f"Uploaded zip {zf.filename} contains host(s) not present in the reservation inventory: {invalid_hosts}"}), 400

    # check user privilege and validate JSON content
    is_full = is_user_full(username)
    bad_json_files = []
    mgmt_violations = []
    parsed_files = {}  # hostname -> (filename, parsed_obj, raw_bytes)
    for host, files_list in files_map.items():
        for file_name, content_bytes in files_list:
            try:
                text = content_bytes.decode("utf-8")
            except Exception as e:
                bad_json_files.append({"host": host, "file": file_name, "error": f"Failed to decode file as text: {e}"})
                continue
            try:
                obj = json.loads(text)
            except Exception as e:
                bad_json_files.append({"host": host, "file": file_name, "error": f"Invalid JSON: {e}"})
                continue

            if not isinstance(obj, dict):
                bad_json_files.append({"host": host, "file": file_name, "error": "Top-level JSON is not an object/dict"})
                continue

            if not is_virtual:
                # validate minimal SONiC config structure
                valid, errors = validate_config_db_minimal(obj)
                if not valid:
                    bad_json_files.append({"host": host, "file": file_name, "error": "Config_db minimal validation failed", "details": errors})
                    continue

            parsed_files[host] = (file_name, obj)

            if not is_full:
                # reject any modification to MGMT_INTERFACE (top-level key present and non-empty)
                if "MGMT_INTERFACE" in obj:
                    mgmt_block = obj.get("MGMT_INTERFACE")
                    if isinstance(mgmt_block, dict) and mgmt_block:
                        mgmt_violations.append({
                            "host": host,
                            "file": file_name,
                            "reason": "MGMT_INTERFACE present (modification of management interface is not allowed for your account)"
                        })

    if bad_json_files:
        return jsonify({"ok": False, "message": f"One or more files in {zf.filename} are not valid JSON or have wrong format", "results": bad_json_files}), 400

    if mgmt_violations:
        return jsonify({"ok": False, "message": "MGMT_INTERFACE modifications are not allowed for your account", "results": mgmt_violations}), 400

    # save uploaded zip to userConfigs (overwrite)
    try:
        os.makedirs(USER_CONFIGS_DIR, exist_ok=True)
        zip_name = f"res_{reservation_id}_running_configs.zip"
        zip_path = os.path.join(USER_CONFIGS_DIR, zip_name)
        with open(zip_path, "wb") as out_fh:
            out_fh.write(uploaded_bytes)
    except Exception as e:
        return jsonify({"ok": False, "message": f"Failed to save uploaded zip {zf.filename} to controller: {e}"}), 500

    tmp_folder_name = f"tmp_res{reservation_id}"
    tmp_folder_path = os.path.join(USER_CONFIGS_DIR, tmp_folder_name)

    try:
        os.makedirs(tmp_folder_path, exist_ok=False)
    except Exception as e:
        return {"ok": False, "message": f"Failed to create temp dir {tmp_folder_path}: {e}"}, 500

    # extract zip inside tmp_folder_path
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.infolist():
                # only files inside target_folder
                if not member.filename.startswith(target_folder + '/'):
                    continue
                # skip directory
                if member.is_dir():
                    continue

                base = os.path.basename(member.filename)
                # skip empty files
                if not base:
                    continue

                # extract file directly in tmp_folder_path with base name
                member.filename = base
                zf.extract(member, tmp_folder_path)

            print(f"DEBUG: Extracted files to: {tmp_folder_path}")
            print(f"DEBUG: Files extracted: {os.listdir(tmp_folder_path)}")

        if LOCAL_TEST:
            tmp_folder_path_wsl = win_to_wsl_path(tmp_folder_path)
            print(f"DEBUG: tmp_folder_path_wsl = {tmp_folder_path_wsl}")
        else:
            tmp_folder_path_wsl = tmp_folder_path

    except zipfile.BadZipFile as e:
        shutil.rmtree(tmp_folder_path)
        return {"ok": False, "message": f"Uploaded file is not a valid zip: {e}"}, 400
    except Exception as e:
        shutil.rmtree(tmp_folder_path)
        return {"ok": False, "message": f"Failed to extract zip: {e}"}, 500

    if LOCAL_TEST:
        user_configs_folder = tmp_folder_path_wsl
    else:
        user_configs_folder = tmp_folder_path

    print(f"DEBUG: Passing to Ansible: user_configs_folder={user_configs_folder}")

    pb_filename = "rollback_playbook.yml"
    pb_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, pb_filename)

    # run rollback playbook with extra_vars required by client
    extra_vars = {"type": "configs", "reservation_id": reservation_id, "user_configs_folder": user_configs_folder, "containerlab_test": is_virtual}
    rc, out, err = run_ansible_playbook(inv_path, pb_path, extra_vars=extra_vars)

    # remove temporary folder after execution
    try:
        if os.path.exists(tmp_folder_path):
            shutil.rmtree(tmp_folder_path)
            print(f"Removed temp folder: {tmp_folder_path}")
    except Exception as e:
        print(f"Warning: failed to remove temp folder {tmp_folder_path}: {e}")

    if rc == 0:
        return jsonify({"ok": True, "message": "Configurations applied", "results": f"rc={rc}, stdout={out}, stderr={err}"}), 200
    else:
        return jsonify({"ok": False, "message": f"Apply configs playbook failed", "results": f"rc={rc}, stdout={out}, stderr={err}"}), 500

@app.route('/api/validator/pingallTest', methods=['POST'])
def pingall_test():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Missing or invalid JSON body"}), 400

    reservation_id = data.get('reservation_id')

    if not reservation_id:
        return jsonify({"error": "reservation_id is required"}), 400

    is_virtual = get_is_virtual_from_db(reservation_id)

    # find inventory
    inv_path = get_inventory_path(reservation_id)

    if not os.path.exists(inv_path):
        return jsonify({"error": f"Inventory file not found for reservation {reservation_id}"}), 404

    local_results_filename = f"pingall_res_{reservation_id}.json"
    local_results_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, local_results_filename)

    if LOCAL_TEST:
       folder_path_wsl = win_to_wsl_path(local_results_path)
    else:
       folder_path_wsl = local_results_path.replace('\\', '/')

    pb_filename = "pingall_test_playbook.yml"
    pb_path = os.path.join(CONTROLLER_PLAYBOOKS_DIR, pb_filename)

    extra_vars = {"results_file": folder_path_wsl, "containerlab_test": is_virtual}

    # execute pingall playbook
    print(f"Running pingall_test_playbook with inventory {inv_path}")
    rc, out, err = run_ansible_playbook(inv_path, pb_path, extra_vars=extra_vars)

    # error during playbook execution
    if rc != 0:
        return jsonify({
            "error": "Ansible pingall playbook failed",
            "rc": rc,
            "message": "Error during Ansible execution. Check stderr for details.",
            "__raw_text": f"STDOUT:\n{out}\n\nSTDERR:\n{err}"
        }), 500

    try:
        with open(local_results_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # remove temporary file after read
        os.remove(local_results_path)

        # return formatted result
        return jsonify(data), 200

    except FileNotFoundError:
        return jsonify({"error": "Results file not found. Ansible succeeded but failed to generate output.",
                        "__raw_text": out}), 500
    except json.JSONDecodeError:
        return jsonify({"error": "Failed to parse JSON result file.", "__raw_text": out}), 500
    except Exception as e:
        return jsonify({"error": f"Internal server error reading results: {str(e)}", "__raw_text": out}), 500

if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=False, host='0.0.0.0', port=5003, use_reloader=False)