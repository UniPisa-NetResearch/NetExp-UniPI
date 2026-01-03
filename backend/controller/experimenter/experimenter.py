import os
import subprocess
import re
from io import BytesIO
import traceback
from flask import request, send_file, jsonify
import json
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
EXPERIMENT_TEMPLATES_DIR = os.path.join(BASE_DIR, "experimentTemplates")
EXPERIMENT_PLAYBOOKS_DIR = os.path.join(BASE_DIR, "experimentPlaybooks")
EXPERIMENT_TELEMETRY_DIR = os.path.join(BASE_DIR, "experimentTelemetry")

def ensure_experiment_dirs():
    # Create directories when don't exist
    os.makedirs(EXPERIMENT_TEMPLATES_DIR, exist_ok=True)
    os.makedirs(EXPERIMENT_PLAYBOOKS_DIR, exist_ok=True)
    os.makedirs(EXPERIMENT_TELEMETRY_DIR, exist_ok=True)

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

# function to indent yaml file
class IndentedDumper(yaml.Dumper):
    def increase_indent(self, flow=False, indentless=False):
        return super(IndentedDumper, self).increase_indent(flow, False)

    def ignore_aliases(self, data):
        return True

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
                'time_offset_s': 0,
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
    yaml_content = yaml.dump(template, Dumper=IndentedDumper, default_flow_style=False, sort_keys=False, indent=2, width=1000)

    # create temporary file
    buffer = BytesIO()
    buffer.write(yaml_content.encode('utf-8'))
    buffer.seek(0)

    return send_file(
        buffer,
        mimetype='application/x-yaml',
        as_attachment=True,
        download_name='experiment_template.yml'
    )


def validate_experiment_template_schema(yaml_data):

    # validate root fields exist
    for field in ['experiment_id', 'duration_s', 'reservation_id', 'schedule']:
        if field not in yaml_data:
            return False, f'Missing field: {field}'

    # validate root field types
    if not isinstance(yaml_data['experiment_id'], str):
        return False, 'Field "experiment_id" must be string'

    if not isinstance(yaml_data['duration_s'], int):
        return False, 'Field "duration_s" must be integer'

    if not isinstance(yaml_data['reservation_id'], (int, str, type(None))):
        return False, 'Field "reservation_id" must be int, str or null'

    # validate schedule
    if not isinstance(yaml_data['schedule'], list):
        return False, 'Field "schedule" must be list'

    if len(yaml_data['schedule']) == 0:
        return False, 'Field "schedule" cannot be empty'

    # validate each schedule item
    for idx, step in enumerate(yaml_data['schedule']):
        if not isinstance(step, dict):
            return False, f'schedule[{idx}] must be dict'

        # check required fields
        for field in ['time_offset_s', 'name', 'playbook', 'targets']:
            if field not in step:
                return False, f'schedule[{idx}] missing field: {field}'

        # check field types
        if not isinstance(step['time_offset_s'], int):
            return False, f'schedule[{idx}].time_offset_s must be integer'

        if not isinstance(step['name'], str):
            return False, f'schedule[{idx}].name must be string'

        if not isinstance(step['playbook'], str):
            return False, f'schedule[{idx}].playbook must be string'

        if not isinstance(step['targets'], list):
            return False, f'schedule[{idx}].targets must be list'

        if len(step['targets']) == 0:
            return False, f'schedule[{idx}].targets cannot be empty'

        # check all targets are strings
        for t_idx, target in enumerate(step['targets']):
            if not isinstance(target, str):
                return False, f'schedule[{idx}].targets[{t_idx}] must be string'

    return True, None

@app.route('/api/experimenter/validateTemplate', methods=['POST'])
def validate_experiment_template():
    # validate experiment template, load playbooks nd check their presence
    try:
        ensure_experiment_dirs()

        experiment_file = request.files.get('experiment_description')
        reservation_id = request.form.get('reservation_id')
        playbook_files = request.files.getlist('playbooks')

        if not experiment_file or not reservation_id:
            return jsonify({
                'success': False,
                'error': 'invalid_request',
                'details': 'Missing experiment_description or reservation_id'
            }), 400

        # Parse YAML
        try:
            yaml_content = yaml.safe_load(experiment_file.stream)
        except yaml.YAMLError as e:
            return jsonify({
                'success': False,
                'error': 'invalid_format',
                'details': f'YAML parsing error: {str(e)}'
            }), 400

        # validate against schema
        is_valid, error_msg = validate_experiment_template_schema(yaml_content)
        if not is_valid:
            return jsonify({
                'success': False,
                'error': 'invalid_format',
                'details': error_msg
            }), 400

        experiment_id = yaml_content.get('experiment_id', 'EXPERIMENT')
        # sanitize experiment_id to create directory valid
        experiment_name_clean = experiment_id.strip().lower().replace(' ', '_')
        safe_exp_name = secure_filename(experiment_name_clean)

        # create reservation dir inside playbooks dir
        playbooks_dir = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, f'res_{reservation_id}', safe_exp_name)
        os.makedirs(playbooks_dir, exist_ok=True)

        # save loaded playbooks
        uploaded_playbooks = []
        if playbook_files:
            for playbook_file in playbook_files:
                if playbook_file.filename:
                    filename = secure_filename(playbook_file.filename)
                    filepath = os.path.join(playbooks_dir, filename)
                    playbook_file.save(filepath)
                    uploaded_playbooks.append(filename)

        # check presence of all needed playbooks
        required_playbooks = [step['playbook'] for step in yaml_content['schedule']]
        missing_playbooks = []

        for playbook_name in required_playbooks:
            playbook_path = os.path.join(playbooks_dir, playbook_name)
            if not os.path.exists(playbook_path):
                missing_playbooks.append(playbook_name)

        if missing_playbooks:
            return jsonify({
                'success': False,
                'error': 'missing_playbooks',
                'missing': missing_playbooks,
                'uploaded': uploaded_playbooks,
                'details': f'Missing {len(missing_playbooks)} playbook(s): {", ".join(missing_playbooks)}'
            }), 400

        # update reservation_id in template with actual value
        yaml_content['reservation_id'] = int(reservation_id)

        # save validated template
        templates_dir = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}')
        os.makedirs(templates_dir, exist_ok=True)

        experiment_name = secure_filename(experiment_file.filename)
        template_path = os.path.join(templates_dir, experiment_name)

        # Write modified YAML content
        with open(template_path, 'w', encoding='utf-8') as f:
            yaml.dump(yaml_content, f, Dumper=IndentedDumper, default_flow_style=False, sort_keys=False, indent=2, width=1000)

        print(f"[VALIDATE TEMPLATE] Success for reservation {reservation_id}", flush=True)
        print(f"  - Template: {experiment_name}", flush=True)
        print(f"  - Uploaded playbooks: {len(uploaded_playbooks)}", flush=True)
        print(f"  - Required playbooks: {len(required_playbooks)}", flush=True)

        return jsonify({
            'success': True,
            'message': 'Template validated and saved successfully',
            'experiment_name': experiment_name,
            'uploaded_playbooks': uploaded_playbooks,
            'required_playbooks': required_playbooks
        }), 200

    except Exception as e:
        print(f"[VALIDATE TEMPLATE ERROR] {str(e)}", flush=True)
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': 'server_error',
            'details': str(e)
        }), 500

@app.route('/api/experimenter/createExperiment', methods=['POST'])
def create_experiment():
    # create experiment file from interactive mode
    try:
        ensure_experiment_dirs()

        # get form data
        experiment_name = request.form.get('experiment_name')
        duration = request.form.get('duration')
        reservation_id = request.form.get('reservation_id')
        playbooks_data = request.form.get('playbooks_data')

        if not experiment_name or not duration or not reservation_id or not playbooks_data:
            return jsonify({'error': 'Missing required fields'}), 400

        # parse playbooks data
        playbooks = json.loads(playbooks_data)

        # sanitize experiment name for filename (lowercase, spaces -> underscores)
        experiment_name_clean = experiment_name.strip().lower().replace(' ', '_')

        # sanitize for folder creation
        safe_exp_name = secure_filename(experiment_name_clean)

        # create playbook directory for the reservation
        playbooks_dir = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, f'res_{reservation_id}', safe_exp_name)
        os.makedirs(playbooks_dir, exist_ok=True)

        # save playbooks
        schedule = []
        for index, playbook_data in enumerate(playbooks):
            file_key = f'playbook_{index}'
            if file_key in request.files:
                file = request.files[file_key]
                if file and file.filename:
                    # save the file
                    filename = secure_filename(file.filename)
                    file_path = os.path.join(playbooks_dir, filename)
                    file.save(file_path)

                    # extract playbook name without extension for the 'name' field
                    playbook_name_base = os.path.splitext(filename)[0].upper()

                    # add to the schedule
                    schedule.append({
                        'time_offset_s': int(playbook_data['execution_time']),
                        'name': playbook_name_base,
                        'playbook': filename,
                        'targets': playbook_data['devices']
                    })

        # sort by execution time
        schedule.sort(key=lambda x: x['time_offset_s'])

        # create YAML document with correct structure
        experiment_doc = {
            'experiment_id': experiment_name.strip().upper(),  # uppercase
            'duration_s': int(duration),
            'reservation_id': int(reservation_id),
            'schedule': schedule
        }

        # convert to YAML with custom dumper for proper indentation
        yaml_content = yaml.dump(
            experiment_doc,
            Dumper=IndentedDumper,
            default_flow_style=False,
            sort_keys=False,
            indent=2,
            width=1000
        )

        # save template file
        templates_dir = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}')
        os.makedirs(templates_dir, exist_ok=True)

        exp_filename = f'{safe_exp_name}.yml'
        exp_path = os.path.join(templates_dir, exp_filename)

        with open(exp_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)

        print(f"[CREATE EXPERIMENT] Created experiment '{experiment_name}' for reservation {reservation_id}",
              flush=True)
        print(f"  - Template saved: {exp_path}", flush=True)
        print(f"  - Playbooks dir: {playbooks_dir}", flush=True)

        # return file for download
        buffer = BytesIO()
        buffer.write(yaml_content.encode('utf-8'))
        buffer.seek(0)

        response = send_file(
            buffer,
            mimetype='application/x-yaml',
            as_attachment=True,
            download_name=exp_filename
        )
        # expose headers to let client read file name
        response.headers['Access-Control-Expose-Headers'] = 'Content-Disposition'

        return response

    except Exception as e:
        print(f"[CREATE EXPERIMENT ERROR] {str(e)}", flush=True)
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/experimenter/createIperfExperiment', methods=['POST'])
def create_iperf_experiment():
    #create iperf experiment YAML file for guided mode with flow-based configuration
    try:
        ensure_experiment_dirs()

        data = request.get_json()
        experiment_name = data.get('experiment_name')
        duration = data.get('duration')
        reservation_id = data.get('reservation_id')
        flows = data.get('flows', [])  # MODIFICATO: riceve lista di flussi

        if not experiment_name or not duration or not reservation_id:
            return jsonify({'error': 'Missing required fields'}), 400

        if not flows or len(flows) == 0:
            return jsonify({'error': 'At least one traffic flow required'}), 400

        # sanitize experiment name
        experiment_name_clean = experiment_name.strip().lower().replace(' ', '_')
        safe_exp_name = secure_filename(experiment_name_clean)

        # collect each unique server and client
        all_flow_ids = [idx for idx in range(1, len(flows) + 1)]

        # paths to the common playbooks
        iperf_playbooks_base = 'iperf_common'

        # build schedule
        schedule=[]

        # start each iperf server at the beginning
        schedule.append({
            'time_offset_s': 0,
            'action': 'start_iperf_servers',
            'flow_ids': list(all_flow_ids)
        })

        # add action for each client flow
        for idx, flow in enumerate(flows, 1):
            start_time = int(flow.get('startOffset')) if flow.get('startOffset') else 5

            schedule.append({
                'time_offset_s': start_time,
                'action': 'start_iperf_client',
                'flow_id': idx
            })

        # stop at the end
        schedule.append({
            'time_offset_s': int(duration) - 5,
            'action': 'stop_iperf',
            'flow_ids': list(all_flow_ids)
        })

        schedule.sort(key=lambda x: x['time_offset_s'])

        # iperf_flows section creation
        iperf_flows = []
        for idx, flow in enumerate(flows, 1):
            start_offset = int(flow.get('startOffset')) if flow.get('startOffset') else 5
            flow_duration = int(flow.get('duration')) if flow.get('duration') else int(duration) - start_offset - 5

            iperf_flows.append({
                'flow_id': idx,
                'client': flow['client'],
                'server': flow['server'],
                'bandwidth_mbps': int(flow['bandwidth']) if flow.get('bandwidth') else 1000,
                'protocol': flow.get('protocol', 'tcp'),
                #'parallel_streams': int(flow.get('parallelStreams', 1)),
                'start_offset_s': start_offset,
                'duration_s': flow_duration,
                'port': 5201
            })

        experiment_doc = {
            'experiment_id': experiment_name.strip().upper(),
            'duration_s': int(duration),
            'reservation_id': int(reservation_id),
            'playbooks_base_path': iperf_playbooks_base,
            'iperf_flows': iperf_flows,
            'schedule': schedule
        }

        yaml_content = yaml.dump(
            experiment_doc,
            Dumper=IndentedDumper,
            default_flow_style=False,
            sort_keys=False,
            indent=2,
            width=1000
        )

        templates_dir = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}')
        os.makedirs(templates_dir, exist_ok=True)

        exp_filename = f'{safe_exp_name}.yml'
        exp_path = os.path.join(templates_dir, exp_filename)

        with open(exp_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)

        print(f"[CREATE IPERF EXPERIMENT] Created experiment '{experiment_name}' for reservation {reservation_id}", flush=True)
        print(f"  - Template saved: {exp_path}", flush=True)
        print(f"  - Flows: {len(flows)}", flush=True)
        print(f"  - Schedule steps: {len(schedule)}", flush=True)

        buffer = BytesIO()
        buffer.write(yaml_content.encode('utf-8'))
        buffer.seek(0)

        response = send_file(
            buffer,
            mimetype='application/x-yaml',
            as_attachment=True,
            download_name=exp_filename
        )
        response.headers['Access-Control-Expose-Headers'] = 'Content-Disposition'

        return response

    except Exception as e:
        print(f"[CREATE IPERF EXPERIMENT ERROR] {str(e)}", flush=True)
        traceback.print_exc()
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

@app.route('/api/experimenter/showExperiments', methods=['POST'])
def show_experiments():
    try:
        ensure_experiment_dirs()

        data = request.get_json() or {}
        reservation_id = data.get('reservation_id')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'reservation_id is required'}), 400

        templates_dir = os.path.join(EXPERIMENT_TEMPLATES_DIR, f"res_{reservation_id}")

        # if the directory does not exist => empty list
        if not os.path.isdir(templates_dir):
            return jsonify({'success': True, 'experiments': []}), 200

        allowed_ext = {'.yml', '.yaml'}
        experiments = []

        for fn in os.listdir(templates_dir):
            full_path = os.path.join(templates_dir, fn)
            if not os.path.isfile(full_path):
                continue

            base, ext = os.path.splitext(fn)
            if ext.lower() not in allowed_ext:
                continue

            experiments.append({
                'label': base,      # in select no extension is shown
                'filename': fn      # complete value (useful for run)
            })

        experiments.sort(key=lambda x: x['label'].lower())

        return jsonify({'success': True, 'experiments': experiments}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/experimenter/createTelemetryFile', methods=['POST'])
def create_telemetry_file():
    try:
        ensure_experiment_dirs()

        data = request.get_json() or {}
        reservation_id = data.get('reservation_id')
        file_base = data.get('telemetry_filename_base')   # es: "<exp>_telemetry"
        experiment_name = data.get('experiment_name')     # es: "<exp>"
        telemetry_type = data.get('telemetry_type')       # 0 = real time, 1 = after experiment
        metrics = data.get('metrics', [])                 # lista di dict

        if not reservation_id:
            return jsonify({'success': False, 'error': 'reservation_id is required'}), 400
        if not file_base or not str(file_base).strip():
            return jsonify({'success': False, 'error': 'telemetry_filename_base is required'}), 400
        if not experiment_name or not str(experiment_name).strip():
            return jsonify({'success': False, 'error': 'experiment_name is required'}), 400
        if telemetry_type not in (0, 1):
            return jsonify({'success': False, 'error': 'telemetry_type must be 0 or 1'}), 400
        if not isinstance(metrics, list) or len(metrics) == 0:
            return jsonify({'success': False, 'error': 'metrics must be a non-empty list'}), 400

        # minimal metrics validation
        for idx, m in enumerate(metrics):
            if not isinstance(m, dict):
                return jsonify({'success': False, 'error': f'metrics[{idx}] must be an object'}), 400

            name = m.get('name')
            sampling_period = m.get('sampling_period')
            targets = m.get('targets')

            if not name or not str(name).strip():
                return jsonify({'success': False, 'error': f'metrics[{idx}].name is required'}), 400
            if sampling_period is None or str(sampling_period).strip() == '':
                return jsonify({'success': False, 'error': f'metrics[{idx}].sampling_period is required'}), 400
            if not isinstance(targets, list) or len(targets) == 0:
                return jsonify({'success': False, 'error': f'metrics[{idx}].targets must be a non-empty list'}), 400

        # yaml creation
        telemetry_doc = {
            'experiment_id': str(experiment_name).strip().upper(),
            'reservation_id': int(reservation_id),
            'telemetry_type': int(telemetry_type),
            'metric': [
                {
                    'name': str(m['name']).strip(),
                    'sampling_period': int(m['sampling_period']),
                    'targets': [str(t).strip() for t in m['targets']]
                } for m in metrics
            ]
        }

        yaml_content = yaml.dump(
            telemetry_doc,
            Dumper=IndentedDumper,
            default_flow_style=False,
            sort_keys=False,
            indent=2,
            width=1000
        )

        # save file in experimentTelemetry/res_<reservation_id>/
        telemetry_dir = os.path.join(EXPERIMENT_TELEMETRY_DIR, f"res_{reservation_id}")
        os.makedirs(telemetry_dir, exist_ok=True)

        safe_base = secure_filename(str(file_base).strip())
        filename = f"{safe_base}.yaml"
        out_path = os.path.join(telemetry_dir, filename)

        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(yaml_content)

        # return file for download
        buffer = BytesIO()
        buffer.write(yaml_content.encode('utf-8'))
        buffer.seek(0)

        response = send_file(
            buffer,
            mimetype='application/x-yaml',
            as_attachment=True,
            download_name=filename
        )
        response.headers['Access-Control-Expose-Headers'] = 'Content-Disposition'
        return response

    except Exception as e:
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    #app.run(debug=True, host='0.0.0.0', port=5004 #, use_reloader=False)
    app.run(debug=False, host='0.0.0.0', port=5004, use_reloader=False)