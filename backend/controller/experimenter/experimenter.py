import os
import subprocess
import re

from flask import request, send_file, jsonify

import yaml
from datetime import datetime
from werkzeug.utils import secure_filename
from ...database.db import db, UserMetrics
from pygnmi.client import gNMIclient
from ...app import app
from ..controller import (
    ensure_inventory_dir, safe_filename, run_ansible_playbook, win_to_wsl_path,
    CONTROLLER_PLAYBOOKS_DIR,
    CONTROLLER_CONFIGS_DIR,
    USER_PLAYBOOKS_DIR,
    USER_CONFIGS_DIR,
    INVENTORY_DIR
)
# true if development mode is active
TEST = True

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXPERIMENT_TEMPLATES_DIR =  os.path.join(BASE_DIR, "experimentTemplates")
EXPERIMENT_PLAYBOOKS_DIR = os.path.join(BASE_DIR, "experimentPlaybooks")


def ensure_experiment_dirs():
    # Create directories when don't exist
    EXPERIMENT_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    EXPERIMENT_PLAYBOOKS_DIR.mkdir(parents=True, exist_ok=True)


@app.route('/api/experimenter/getDevices', methods=['POST'])
def get_devices():
    #read host names from inventory res_<reservation_id>_inventory and return them as list

    try:
        data = request.get_json()
        reservation_id = data.get('reservation_id')

        if not reservation_id:
            return jsonify({'error': 'reservation_id is required'}), 400

        safe_res = safe_filename(f"res-{reservation_id}-inventory")
        inv_path = os.path.join(INVENTORY_DIR, f"{safe_res}.ini")

        # verify file existence
        if not os.path.exists(inv_path):
            return jsonify({'error': f'Inventory file not found for reservation {reservation_id}'}), 404

        # read inventory file
        devices = []
        with open(inv_path, 'r', encoding='utf-8') as f:
            in_all_section = False
            for line in f:
                line = line.strip()

                # skip comments and empty rows
                if not line or line.startswith('#'):
                    continue

                # verify if we are in the section [all]
                if line == '[all]':
                    in_all_section = True
                    continue
                elif line.startswith('['):
                    in_all_section = False
                    continue

                # if we are in the section [all], extract device name
                if in_all_section:
                    # parse the line to extract device_name, ip, and role
                    parts = line.split()
                    if not parts:
                        continue

                    device_name = parts[0]
                    ip_address = None
                    role = None

                    # extract ansible_host and role from the line
                    for part in parts[1:]:
                        if part.startswith('ansible_host='):
                            ip_address = part.split('=', 1)[1]
                        elif part.startswith('role='):
                            role = part.split('=', 1)[1]

                    devices.append({
                        'name': device_name,
                        'ip': ip_address,
                        'role': role
                    })

        return jsonify({'devices': devices}), 200

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/experimenter/downloadTemplate', methods=['POST'])
def download_experiment_template():
    # return experiment template
    reservation_id = request.form.get('reservation_id')
    template = {
        'experiment_id': 'EXPERIMENT_NAME',
        'duration_s': 600,
        'reservation_id': reservation_id,
        'schedule': [
            {
                'time_offset': 0,
                'name': 'INITIAL_CHECK',
                'playbook': 'initial_check.yml',
                'targets': ['sw1', 'sw2']
            },
            {
                'time_offset_s': 120,
                'name': 'MAIN_ACTION',
                'playbook': 'main_action.yml',
                'targets': ['sw1']
            }
        ]
    }

    # convert in YAML
    yaml_content = yaml.dump(template, default_flow_style=False, sort_keys=False)

    # create temporary file
    from io import BytesIO
    buffer = BytesIO()
    buffer.write(yaml_content.encode('utf-8'))
    buffer.seek(0)

    return send_file(
        buffer,
        mimetype='application/x-yaml',
        as_attachment=True,
        download_name='experiment_template.yml'
    )


@app.route('/api/experimenter/createExperiment', methods=['POST'])
def create_experiment():
    # create experiment file from interactive mode
    try:
        ensure_experiment_dirs()

        # get form data
        duration = request.form.get('duration')
        reservation_id = request.form.get('reservation_id')
        playbooks_data = request.form.get('playbooks_data')

        if not duration or not reservation_id or not playbooks_data:
            return jsonify({'error': 'Missing required fields'}), 400

        # parse playbooks data
        import json
        playbooks = json.loads(playbooks_data)

        # create playbook directory for the reservation
        playbooks_dir = EXPERIMENT_PLAYBOOKS_DIR / f'res_{reservation_id}_playbooks'
        playbooks_dir.mkdir(parents=True, exist_ok=True)

        # save playbooks
        schedule = []
        for index, playbook_data in enumerate(playbooks):
            file_key = f'playbook_{index}'
            if file_key in request.files:
                file = request.files[file_key]
                if file and file.filename:
                    # save the file
                    filename = secure_filename(file.filename)
                    file_path = playbooks_dir / filename
                    file.save(str(file_path))

                    # add to the schedule
                    schedule.append({
                        'time_offset': int(playbook_data['execution_time']),
                        'name': f'STEP_{index + 1}',
                        'playbook': f'{filename}',
                        'targets': playbook_data['devices'],
                        'vars': {}
                    })

        # Ordina per tempo di esecuzione
        schedule.sort(key=lambda x: x['time_offset_s'])

        # Crea il documento YAML
        experiment_doc = {
            'experiment_id': f'EXP_{reservation_id}_{datetime.now().strftime("%Y%m%d_%H%M%S")}',
            'duration': int(duration),
            'reservation_id': reservation_id,
            'schedule': schedule
        }

        # convert in YAML
        yaml_content = yaml.dump(experiment_doc, default_flow_style=False, sort_keys=False)

        # save the file
        exp_filename = f'res_{reservation_id}_exp_description.yml'
        exp_path = EXPERIMENT_TEMPLATES_DIR / exp_filename
        with open(exp_path, 'w') as f:
            f.write(yaml_content)

        # return file for download
        from io import BytesIO
        buffer = BytesIO()
        buffer.write(yaml_content.encode('utf-8'))
        buffer.seek(0)

        return send_file(
            buffer,
            mimetype='application/x-yaml',
            as_attachment=True,
            download_name=exp_filename
        )

    except Exception as e:
        print(f"Error creating experiment: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/experimenter/getUserMetrics', methods=['POST'])
def get_user_metrics():
    # returns user's custom metrics from database

    data = request.get_json()
    username = data.get('username')

    if not username:
        return jsonify({
            'success': False,
            'error': 'Username is required'
        }), 400

    try:
        user_metrics = UserMetrics.query.filter_by(username=username).all()

        custom_metrics = []
        for metric in user_metrics:
            custom_metrics.append({
                'id': f'custom_{metric.id}',
                'path': metric.metric,
                'type': metric.type
            })

        return jsonify({
            'success': True,
            'custom': custom_metrics
        }), 200

    except Exception as e:
        return jsonify({
            'success': False,
            'error': f'Database error: {str(e)}'
        }), 500


@app.route('/api/experimenter/addMetrics', methods=['POST'])
def add_metrics():
    # validates and adds multiple metrics in one call

    data = request.get_json()
    username = data.get('username')
    switch_ip = data.get('switch_ip')
    metrics = data.get('metrics')  # list of metrics with paths

    if not username or not switch_ip or not metrics or not isinstance(metrics, list):
        return jsonify({
            'success': False,
            'error': 'Missing required fields'
        }), 400

    results = []

    for idx, metric_data in enumerate(metrics, 1):
        metric_path = metric_data.get('path', '').strip()

        print(f"\n[METRIC {idx}/{len(metrics)}] Processing: {metric_path}", flush=True)

        result = {
            'path': metric_path,
            'status': 'error',
            'message': ''
        }

        metric_type = None
        original_path = None

        # Validate metric on device
        try:
            if metric_path.startswith('/openconfig-'):
                # OpenConfig format
                match = re.match(r'^(/openconfig-[^:]+):(.+)$', metric_path)
                if not match:
                    result['message'] = 'Invalid OpenConfig format'
                    results.append(result)
                    continue

                metric_type = 'openconfig'

                # copy the original string
                original_path = metric_path

                # create path for the test
                prefix = match.group(1)  # es. /openconfig-interfaces
                path_after_colon = match.group(2)  # es. openconfig-interfaces:interfaces/interface[name=Ethernet1]

                # add, if there is not the double prefix
                prefix_without_slash = prefix[1:]  # es. openconfig-interfaces

                if not path_after_colon.startswith(prefix_without_slash + ':'):
                    # Add the same prefix
                    path_for_validation = prefix + ':' + prefix_without_slash + ':' + path_after_colon
                else:
                    # double prefix present, use the original one
                    path_for_validation = original_path

                try:
                    with gNMIclient(
                            target=(switch_ip, 8080),
                            username='admin',
                            password='YourPaSsWoRd',
                            insecure=True,
                            skip_verify=True
                    ) as gc:
                        get_result = gc.get(path=[path_for_validation], encoding='json')

                        if not get_result or 'notification' not in get_result:
                            raise Exception("Empty response")

                except Exception as e:
                    result['message'] = f'Not available: {str(e)[:100]}'
                    results.append(result)
                    continue

            elif ':' in metric_path:
                # SONiC DB format
                parts = metric_path.split(':', 1)
                if len(parts) != 2:
                    result['message'] = 'Invalid SONiC DB format'
                    results.append(result)
                    continue

                db_name = parts[0]
                path = parts[1]

                valid_dbs = ['COUNTERS_DB', 'CONFIG_DB', 'STATE_DB', 'APPL_DB', 'FLEX_COUNTER_DB', 'ASIC_DB']
                if db_name not in valid_dbs:
                    result['message'] = f'Invalid database name'
                    results.append(result)
                    continue

                metric_type = 'sonic_db'

                try:
                    with gNMIclient(
                            target=(switch_ip, 8080),
                            username='admin',
                            password='YourPaSsWoRd',
                            insecure=True,
                            skip_verify=True
                    ) as gc:
                        get_result = gc.get(path=[path], target=db_name, encoding='json')

                        if not get_result or 'notification' not in get_result:
                            raise Exception("Empty response")

                except Exception as e:
                    result['message'] = f'Not available: {str(e)[:100]}'
                    results.append(result)
                    continue

            else:
                result['message'] = 'Invalid format. Must be OpenConfig or SONiC DB'
                results.append(result)
                continue

            # existence check in database (use original_path for OpenConfig, metric_path for SONiC)
            path_to_save = original_path if metric_type == 'openconfig' else metric_path

            existing = UserMetrics.query.filter_by(
                username=username,
                metric=path_to_save
            ).first()

            if existing:
                result['status'] = 'warning'
                result['message'] = 'Already exists in your collection'
            else:
                new_metric = UserMetrics(
                    username=username,
                    metric=path_to_save,
                    type=metric_type,
                )
                db.session.add(new_metric)
                result['status'] = 'success'
                result['message'] = 'Validated and added'

        except Exception as e:
            result['message'] = f'Error: {str(e)}'

        results.append(result)

    # Commit all successful additions
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()

        return jsonify({
            'success': False,
            'error': f'Database error: {str(e)}'
        }), 500

    print(f"{'=' * 80}\n", flush=True)

    return jsonify({
        'success': True,
        'results': results
    }), 200


if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    #app.run(debug=True, host='0.0.0.0', port=5004)#, use_reloader=False)
    app.run(debug=False, host='0.0.0.0', port=5004, use_reloader=False)