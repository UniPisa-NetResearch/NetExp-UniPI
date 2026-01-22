import os
import re
from io import BytesIO
import traceback
from flask import request, send_file, jsonify
import json
import yaml
import zipfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename
from ...database.db import db, UserMetrics, Reservation, Experiment
from pygnmi.client import gNMIclient
from ...app import app
from ..controller import (safe_filename, INVENTORY_DIR, TEST)
from .experimenter_utils import (ensure_experiment_dirs, get_next_available_id, collect_telemetry_data, convert_iperf_experiment_to_schedule, execute_experiment_schedule, validate_experiment_template_schema, IndentedDumper, finish_cleanup_and_remove, finalize_batch_results, cleanup_batch_temp_results)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXPERIMENT_TEMPLATES_DIR = os.path.join(BASE_DIR, "experimentTemplates")
EXPERIMENT_PLAYBOOKS_DIR = os.path.join(BASE_DIR, "experimentPlaybooks")
EXPERIMENT_TELEMETRY_DIR = os.path.join(BASE_DIR, "experimentTelemetry")
EXPERIMENT_RESULTS_DIR = os.path.join(BASE_DIR, "experimentResults")

running_experiments = {}                # {reservation_id: {'futures': [...], 'playbook_running': False, 'current_playbook': None}
experiments_lock = threading.Lock()     #lock for stopping threads

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

@app.route('/api/experimenter/calculateBatchDuration', methods=['POST'])
def calculate_batch_duration():
    # calculate total duration for batch experiments including transition time
    try:
        data = request.json
        experiment_names = data.get('experiments', [])
        reservation_id = data.get('reservation_id')

        if not experiment_names or not reservation_id:
            return jsonify({'success': False, 'error': 'Missing experiments or reservation_id'}), 400

        total_duration = 0

        for exp_name in experiment_names:
            exp_path = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}', f'{exp_name}.yml')

            if not os.path.exists(exp_path):
                return jsonify({'success': False, 'error': f'Experiment {exp_name} not found'}), 404

            with open(exp_path, 'r') as f:
                exp_data = yaml.safe_load(f)

            total_duration += exp_data.get('duration_s', 0)

        # add 1 minute between each experiment
        if len(experiment_names) > 1:
            total_duration += (len(experiment_names) -  1) * 60

        return jsonify({
            'success': True,
            'total_duration_s': total_duration,
            'num_experiments': len(experiment_names)
        }), 200

    except Exception as e:
        print(f"Error calculating batch duration: {str(e)}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/experimenter/downloadTemplate', methods=['GET'])
def download_experiment_template():
    # return experiment template
    template_yaml_path = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, 'general_playbooks', 'experiment_template.yml')
    example_playbook_path = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, 'general_playbooks', 'iperf_client_example.yml')
    readme_path = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, 'general_playbooks', 'README.txt')

    # create temporary file
    buffer = BytesIO()

    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as b:
        if os.path.exists(template_yaml_path):
            with open(template_yaml_path, 'r') as f:
                b.writestr('experiment_template.yml', f.read())

        if os.path.exists(example_playbook_path):
            with open(example_playbook_path, 'r') as f:
                b.writestr('iperf_client_example.yml', f.read())

        if os.path.exists(readme_path):
            with open(readme_path, 'r') as f:
                b.writestr('README.txt', f.read())

    buffer.seek(0)

    return send_file(
        buffer,
        mimetype='application/zip',
        as_attachment=True,
        download_name='experiment_template_package.zip'
    )

@app.route('/api/experimenter/downloadIperfExample', methods=['GET'])
def download_iperf_example():
    # download only the iperf3 example playbook (for interactive mode)

    try:
        example_playbook_path = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, 'general_playbooks', 'iperf_client_example.yml')

        if not os.path.exists(example_playbook_path):
            return jsonify({'error': 'Example playbook not found'}), 404

        return send_file(
            example_playbook_path,
            mimetype='application/x-yaml',
            as_attachment=True,
            download_name='iperf_client_example.yml'
        )

    except Exception as e:
        print(f"[DOWNLOAD IPERF EXAMPLE ERROR] {str(e)}", flush=True)
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/experimenter/validateTemplate', methods=['POST'])
def validate_experiment_template():
    # validate experiment template, load playbooks nd check their presence
    try:
        ensure_experiment_dirs(EXPERIMENT_TEMPLATES_DIR, EXPERIMENT_PLAYBOOKS_DIR, EXPERIMENT_TELEMETRY_DIR, EXPERIMENT_RESULTS_DIR)

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

        experiment_filename = experiment_file.filename
        experiment_name_base = os.path.splitext(experiment_filename)[0]
        # sanitize experiment_id to create directory valid
        experiment_name_clean = experiment_name_base.replace(' ', '_')
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
        ensure_experiment_dirs(EXPERIMENT_TEMPLATES_DIR, EXPERIMENT_PLAYBOOKS_DIR, EXPERIMENT_TELEMETRY_DIR, EXPERIMENT_RESULTS_DIR)

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
            'experiment_id': experiment_name.strip().upper().replace(' ', '_'),  # uppercase
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
        ensure_experiment_dirs(EXPERIMENT_TEMPLATES_DIR, EXPERIMENT_PLAYBOOKS_DIR, EXPERIMENT_TELEMETRY_DIR, EXPERIMENT_RESULTS_DIR)

        data = request.get_json()
        experiment_name = data.get('experiment_name')
        duration = data.get('duration')
        reservation_id = data.get('reservation_id')
        flows = data.get('flows', [])

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
        all_flow_ids = []
        for idx, flow in enumerate(flows, 1):
            start_offset = int(flow.get('startOffset')) if flow.get('startOffset') else 5

            if flow.get('duration'):
                flow_duration = int(flow.get('duration'))
                if flow_duration + start_offset > int(duration) - 5:
                    flow_duration = int(duration) - start_offset - 5
            else:
                flow_duration = int(duration) - start_offset - 5

            iperf_flows.append({
                'flow_id': idx,
                'client': flow['client'],
                'server': flow['server'],
                'server_ip': flow['serverIp'],
                'port': int(flow['port']),
                'bandwidth_mbps': int(flow['bandwidth']) if flow.get('bandwidth') else 1000,
                'protocol': flow.get('protocol', 'tcp'),
                #'parallel_streams': int(flow.get('parallelStreams', 1)),
                'start_offset_s': start_offset,
                'duration_s': flow_duration
            })
            all_flow_ids.append(idx)

        experiment_doc = {
            'experiment_id': experiment_name.strip().upper().replace(' ', '_'),
            'duration_s': int(duration),
            'reservation_id': int(reservation_id),
            'playbooks_base_path': iperf_playbooks_base,
            'iperf_flows': iperf_flows,
            'schedule': schedule
        }

        yaml_content = yaml.dump(experiment_doc, Dumper=IndentedDumper, default_flow_style=False, sort_keys=False, indent=2, width=1000)

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
        ensure_experiment_dirs(EXPERIMENT_TEMPLATES_DIR, EXPERIMENT_PLAYBOOKS_DIR, EXPERIMENT_TELEMETRY_DIR, EXPERIMENT_RESULTS_DIR)

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
        ensure_experiment_dirs(EXPERIMENT_TEMPLATES_DIR, EXPERIMENT_PLAYBOOKS_DIR, EXPERIMENT_TELEMETRY_DIR, EXPERIMENT_RESULTS_DIR)

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
        filename = f"{safe_base}.yml"
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

@app.route('/api/experimenter/runExperiment', methods=['POST'])
def run_experiment():
    try:
        data = request.json
        experiment_name = data.get('experiment_name')
        experiment_names = data.get('experiment_names')  # array for batch
        reservation_id = data.get('reservation_id')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        if experiment_names:
            experiments_list = experiment_names
            is_batch = True
        elif experiment_name:
            experiments_list = [experiment_name]
            is_batch = False
        else:
            return jsonify({'success': False, 'error': 'Missing experiment_name or experiment_names'}), 400

        # check if there is a running experiment for that reservation
        existing_run = Experiment.query.filter_by(reservation_id=reservation_id, status='running').first()

        if existing_run:
            return jsonify({
                'success': False,
                'error': f'An experiment is already running: {existing_run.experiment_name}'
            }), 400

        experiments_data = []
        duration_s = 0
        for exp_name in experiments_list:
            telemetry_file_path = os.path.join(EXPERIMENT_TELEMETRY_DIR, f'res_{reservation_id}', f'{exp_name}_telemetry.yml')
            # check if file exists
            if not os.path.exists(telemetry_file_path):
                return jsonify({'success': False, 'error': f'Telemetry file not found: {exp_name}_telemetry.yml'}), 404

            experiment_file_path = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}', f'{exp_name}.yml')
            # get duration_s
            try:
                with open(telemetry_file_path, 'r') as f:
                    telemetry_data = yaml.safe_load(f)

                with open(experiment_file_path, 'r') as f:
                    experiment_data = yaml.safe_load(f)

                exp_duration_s = experiment_data.get('duration_s')

                if 'iperf_flows' in experiment_data and 'playbooks_base_path' in experiment_data:
                    print(f"[RUN] Detected guided mode (iperf) experiment", flush=True)

                    # convert in standard format
                    converted_schedule, playbooks_path = convert_iperf_experiment_to_schedule(experiment_data)

                    # change schedule with the converted one
                    experiment_data['schedule'] = converted_schedule

                    print(f"[RUN] Converted {len(converted_schedule)} schedule steps", flush=True)
                    print(f"[RUN] Using playbooks from: {playbooks_path}", flush=True)

                if exp_duration_s is None:
                    return jsonify({'success': False, 'error': 'duration_s field not found in telemetry file'}), 400

                exp_duration_s = int(exp_duration_s)
                duration_s += exp_duration_s

                experiments_data.append({
                    'name': exp_name,
                    'experiment_data': experiment_data,
                    'telemetry_data': telemetry_data,
                    'duration': exp_duration_s
                })

            except Exception as e:
                return jsonify({'success': False, 'error': f'Error reading telemetry file: {str(e)}'}), 500

        batch_id = None
        # add 1 minute after each experiment except the last one
        if is_batch:
            # unique batch id
            batch_id = f"batch_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            if len(experiments_list) > 1:
                duration_s += (len(experiments_list) - 1) * 60

        # find reservation
        reservation = Reservation.query.filter_by(id=reservation_id).first()

        if not reservation:
            return jsonify({'success': False, 'error': f'Reservation {reservation_id} not found'}), 404

        # compute reservation end
        reservation_end = datetime.combine(reservation.endDate, reservation.endTime)

        now = datetime.now()

        # remaining time since reservation end
        time_until_end = (reservation_end - now).total_seconds()

        # 10 minutes (600 seconds)  margin
        safety_margin = 600

        # check if reservation duration exceeds
        if duration_s > (time_until_end - safety_margin):
            minutes_available = int((time_until_end - safety_margin) / 60)
            return jsonify({
                'success': False,
                'error': f'Experiment duration ({duration_s}s) exceeds available time. Only {minutes_available} minutes available (10 min margin before reservation ends)'
            }), 400

        # create record in database
        experiment_start = now
        created_experiment_ids = []
        cumulative_time = 0
        # create a record for each experiment in the batch
        for idx, exp_info in enumerate(experiments_data):
            exp_name = exp_info['name']
            exp_duration = exp_info['duration']

            exp_start = experiment_start + timedelta(seconds=cumulative_time)
            exp_end = exp_start + timedelta(seconds=exp_duration)
            cumulative_time += exp_duration
            if is_batch:
                cumulative_time += 60

            # find next available id
            next_id = get_next_available_id()

            # find record inside the database
            if next_id is not None:
                new_experiment = Experiment(
                    id=next_id,
                    reservation_id=reservation_id,
                    experiment_name=exp_name,
                    start_time=exp_start,
                    end_time=exp_end,
                    duration_s=exp_duration,
                    status='running',
                    batch_id=batch_id,
                    clean_ended=False
                )
            else:
                new_experiment = Experiment(
                    reservation_id=reservation_id,
                    experiment_name=exp_name,
                    start_time=exp_start,
                    end_time=exp_end,
                    duration_s=exp_duration,
                    status='running',
                    batch_id=batch_id,
                    clean_ended=False
                )

            db.session.add(new_experiment)
            db.session.flush()

            created_experiment_ids.append(new_experiment.id)

            print(f"[DB] Created experiment record: {exp_name} (ID: {new_experiment.id}, batch: {batch_id})", flush=True)

        db.session.commit()

        # inventory path
        safe_res = safe_filename(f"res-{reservation_id}-inventory")
        inventory_path = os.path.join(INVENTORY_DIR, f"{safe_res}.ini")

        # parallel execution: experiment + telemetry
        def run_experiment_with_telemetry():
            try:
                with experiments_lock:
                    running_experiments[reservation_id] = {
                        'futures': [],
                        'playbook_running': False,
                        'current_playbook': None
                    }

                for id_x, experiment_info in enumerate(experiments_data):
                    # check stop flag
                    with experiments_lock:
                        if reservation_id not in running_experiments:
                            print(f"[EXPERIMENT] Stop requested, aborting remaining experiments", flush=True)
                            break

                    name_exp = experiment_info['name']
                    data_exp = experiment_info['experiment_data']
                    telemetry_exp = experiment_info['telemetry_data']
                    id_exp = created_experiment_ids[id_x]

                    print(f"[EXPERIMENT] Starting {id_x + 1}/{len(experiments_data)}: {name_exp}", flush=True)

                    with ThreadPoolExecutor(max_workers=2) as executor:
                        # start experiment and telemetry execution
                        experiment_future = executor.submit(
                            execute_experiment_schedule,
                      reservation_id,
                            name_exp, data_exp, inventory_path,
                            EXPERIMENT_RESULTS_DIR, EXPERIMENT_PLAYBOOKS_DIR,
                            running_experiments, experiments_lock, TEST,is_batch
                        )

                        telemetry_future = executor.submit(
                            collect_telemetry_data,
                      reservation_id,
                            name_exp, telemetry_exp, inventory_path,
                            experiment_info['duration'], EXPERIMENT_RESULTS_DIR,
                            running_experiments, experiments_lock, is_batch
                        )

                        # save Futures and flag
                        with experiments_lock:
                            if reservation_id in running_experiments:
                                running_experiments[reservation_id]['futures'] = [experiment_future, telemetry_future]

                        # wait completion
                        experiment_success, experiment_error, actual_start_timestamp, actual_end_timestamp = experiment_future.result()
                        telemetry_success, telemetry_error = telemetry_future.result()

                    # update experiment status
                    with app.app_context():
                        exp = Experiment.query.filter_by(id=id_exp).first()
                        if exp:
                            if actual_start_timestamp:
                                actual_start_dt = datetime.fromtimestamp(actual_start_timestamp)
                                exp.start_time = actual_start_dt
                                print(f"[EXPERIMENT] {name_exp} - Updated with actual start time: {actual_start_dt.strftime('%H:%M:%S')}", flush=True)

                            if actual_end_timestamp:
                                actual_end_dt = datetime.fromtimestamp(actual_end_timestamp)
                                exp.end_time = actual_end_dt
                                print(f"[EXPERIMENT] {name_exp} - Updated with actual end time: {actual_end_dt.strftime('%H:%M:%S')}", flush=True)

                            if actual_start_timestamp and actual_end_timestamp:
                                actual_duration = int((actual_end_dt - actual_start_dt).total_seconds())
                                exp.duration_s = actual_duration
                                print(f"[EXPERIMENT] {name_exp} - Actual duration: {actual_duration}s", flush=True)

                            is_user_stop = ((not experiment_success and experiment_error and "stopped by user" in experiment_error.lower()) or
                                            (not telemetry_success and telemetry_error and "stopped by user" in telemetry_error.lower()))

                            if is_user_stop:
                                print(f"[EXPERIMENT] {name_exp} stopped by user", flush=True)
                            elif experiment_success and telemetry_success:
                                exp.status = 'completed'
                                print(f"[EXPERIMENT] {name_exp} completed", flush=True)

                                exp.clean_ended = True
                                print(f"[EXPERIMENT] {name_exp} - Cleanup completed, clean_ended set to True", flush=True)

                                db.session.commit()
                            else:
                                exp.status = 'error'
                                error_details = []
                                if not experiment_success and not (experiment_error and "stopped by user" in experiment_error.lower()):
                                    error_details.append(f"Experiment: {experiment_error}")
                                if not telemetry_success and not (telemetry_error and "stopped by user" in telemetry_error.lower()):
                                    error_details.append(f"Telemetry: {telemetry_error}")
                                if error_details:
                                    print(f"[EXPERIMENT] {name_exp} failed: {', '.join(error_details)}", flush=True)

                            # if all experiments are completed, write results
                            if is_batch:
                                all_completed_successfully = all(
                                    exp.status == 'completed' for exp in
                                    db.session.query(Experiment).filter_by(reservation_id=reservation_id, batch_id=batch_id).all()
                                )

                                if all_completed_successfully:
                                    print(f"[BATCH] All experiments completed successfully, finalizing results...", flush=True)
                                    finalize_success, finalize_error = finalize_batch_results(
                                        reservation_id,
                                        [info['name'] for info in experiments_data],
                                        EXPERIMENT_RESULTS_DIR
                                    )
                                    if not finalize_success:
                                        print(f"[BATCH] Warning: Failed to finalize results: {finalize_error}", flush=True)
                                else:
                                    print(f"[BATCH] Some experiments failed, keeping temporary results", flush=True)
                            db.session.commit()

                # remove from dictionary when completed
                with experiments_lock:
                    if reservation_id in running_experiments:
                        del running_experiments[reservation_id]

            except Exception as e:
                print(f"[EXPERIMENT THREAD ERROR] {str(e)}", flush=True)
                traceback.print_exc()
                with app.app_context():
                    for exp_id in created_experiment_ids:
                        exp = Experiment.query.filter_by(id=exp_id).first()
                        if exp and exp.status == 'running':
                            exp.status = 'error'
                    db.session.commit()

        # start thread for execution
        thread = threading.Thread(target=run_experiment_with_telemetry, daemon=True)
        thread.start()

        return jsonify({
            'success': True,
            'duration_s': duration_s,
            'start_time': experiment_start.isoformat(),
            'end_time': (experiment_start + timedelta(seconds=duration_s)).isoformat(),
            'experiment_id': created_experiment_ids[0],
            'experiment_ids': created_experiment_ids,
            'is_batch': is_batch,
            'batch_id': batch_id,
            'num_experiments': len(experiments_list),
            'message': 'Experiment started successfully'
        }), 200

    except Exception as e:
        db.session.rollback()
        print(f"Error in runExperiment: {str(e)}")
        return jsonify({
            'success': False,
            'error': f'Server error: {str(e)}'
        }), 500

@app.route('/api/experimenter/getExperimentStatus', methods=['POST'])
def get_experiment_status():
    # check if there is an active experiment and return remaining time
    try:
        data = request.json
        reservation_id = data.get('reservation_id')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        stopping_experiment = Experiment.query.filter_by(
            reservation_id=reservation_id,
            status='stopping'
        ).order_by(Experiment.start_time).first()

        if stopping_experiment:
            return jsonify({
                'success': True,
                'running': False,
                'stopping': True,
                'clean_ended': False,
                'experiment_name': stopping_experiment.experiment_name,
                'experiment_id': stopping_experiment.id,
                'is_batch': stopping_experiment.batch_id is not None,
                'message': 'Experiment is stopping. Please wait...'
            }), 200

        # find running experiment for the current reservation
        running_experiment = Experiment.query.filter_by(
            reservation_id=reservation_id,
            status='running'
        ).order_by(Experiment.start_time).first()

        if not running_experiment:
            running_experiment = Experiment.query.filter_by(
                reservation_id=reservation_id,
                status='completed',
                clean_ended=False
            ).order_by(Experiment.start_time).first()

            if not running_experiment:
                return jsonify({
                    'success': True,
                    'running': False,
                    'stopping': False,
                    'clean_ended': True,
                    'message': 'No experiment running'
                }), 200

        now = datetime.now()

        with experiments_lock:
            is_actually_running = reservation_id in running_experiments

        if running_experiment.status == 'completed':
            is_batch = running_experiment.batch_id is not None

            if is_batch:
                batch_experiments = Experiment.query.filter_by(
                    reservation_id=reservation_id,
                    batch_id=running_experiment.batch_id
                ).all()

                all_clean_ended = all(exp.clean_ended for exp in batch_experiments)

                if not is_actually_running and all_clean_ended:
                    return jsonify({
                        'success': True,
                        'running': False,
                        'stopping': False,
                        'clean_ended': True,
                        'just_completed': True,
                        'experiment_name': running_experiment.experiment_name,
                        'experiment_id': running_experiment.id,
                        'is_batch': True,
                        'batch_id': running_experiment.batch_id,
                        'message': 'Batch completed and cleanup finished'
                    }), 200
                else:
                    not_cleaned = [exp.experiment_name for exp in batch_experiments if not exp.clean_ended]
                    print(f"[STATUS] Batch {running_experiment.batch_id}: waiting for cleanup. Pending: {not_cleaned}",
                          flush=True)

                    return jsonify({
                        'success': True,
                        'running': False,
                        'stopping': False,
                        'clean_ended': False,
                        'waiting_cleanup': True,
                        'experiment_name': running_experiment.experiment_name,
                        'is_batch': True,
                        'batch_id': running_experiment.batch_id,
                        'message': 'Batch completed. Waiting for cleanup to finish...'
                    }), 200
            else:
                if not is_actually_running and running_experiment.clean_ended:
                    return jsonify({
                        'success': True,
                        'running': False,
                        'stopping': False,
                        'clean_ended': True,
                        'just_completed': True,
                        'experiment_name': running_experiment.experiment_name,
                        'experiment_id': running_experiment.id,
                        'is_batch': False,
                        'message': 'Experiment completed and cleanup finished'
                    }), 200
                else:
                    print(f"[STATUS] Experiment {running_experiment.experiment_name}: waiting for cleanup", flush=True)

                    return jsonify({
                        'success': True,
                        'running': False,
                        'stopping': False,
                        'clean_ended': False,
                        'waiting_cleanup': True,
                        'experiment_name': running_experiment.experiment_name,
                        'is_batch': False,
                        'message': 'Experiment completed. Waiting for cleanup to finish...'
                    }), 200

        is_batch = running_experiment.batch_id is not None

        if is_batch:
            # find every batch experiment
            batch_experiments = Experiment.query.filter_by(
                reservation_id=reservation_id,
                batch_id=running_experiment.batch_id
            ).order_by(Experiment.start_time).all()

            # remaining time from the end of the last experiment
            last_experiment = batch_experiments[-1]
            remaining_seconds = int((last_experiment.end_time - datetime.now()).total_seconds())
            remaining_seconds = max(0, remaining_seconds)

            current_running = None
            for exp in batch_experiments:
                if exp.status == 'running':
                    current_running = exp
                    break

            current_exp_name = current_running.experiment_name if current_running else running_experiment.experiment_name

            return jsonify({
                'success': True,
                'running': True,
                'stopping': False,
                'clean_ended': False,
                'experiment_id': running_experiment.id,
                'experiment_name': running_experiment.experiment_name,
                'remaining_seconds': remaining_seconds,
                'is_batch': True,
                'batch_id': running_experiment.batch_id,
                'current_experiment': current_exp_name,
                'total_experiments': len(batch_experiments)
            }), 200
        else:

            # compute remaining time in seconds
            remaining_seconds = int((running_experiment.end_time - now).total_seconds())

            return jsonify({
                'success': True,
                'running': True,
                'stopping': False,
                'clean_ended': False,
                'experiment_name': running_experiment.experiment_name,
                'remaining_seconds': remaining_seconds,
                'total_duration_s': running_experiment.duration_s,
                'start_time': running_experiment.start_time.isoformat(),
                'end_time': running_experiment.end_time.isoformat(),
                'experiment_id': running_experiment.id,
                'is_batch': False
            }), 200

    except Exception as e:
        print(f"Error in getExperimentStatus: {str(e)}")
        return jsonify({
            'success': False,
            'error': f'Server error: {str(e)}'
        }), 500

@app.route('/api/experimenter/finishExperiment', methods=['POST'])
def finish_experiment():
    # end manually an experiment
    try:
        data = request.json
        reservation_id = data.get('reservation_id')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        # find running experiment
        running_experiment = Experiment.query.filter_by(
            reservation_id=reservation_id,
            status='running'
        ).first()

        if not running_experiment:
            return jsonify({'success': False, 'error': 'No experiment found for this reservation'}), 400

        print(f"[FINISH] Stopping experiment for reservation {reservation_id}", flush=True)
        running_experiment.status = 'stopping'
        db.session.commit()

        # set stop flag for threads
        with experiments_lock:
            if reservation_id not in running_experiments:
                print(f"[FINISH] Warning: No running experiment tracked for reservation {reservation_id}", flush=True)
                return finish_cleanup_and_remove(reservation_id, running_experiment, EXPERIMENT_PLAYBOOKS_DIR, experiments_lock, running_experiments, EXPERIMENT_RESULTS_DIR)

        playbook_running = False
        current_playbook = None
        with experiments_lock:
            if reservation_id in running_experiments:
                playbook_running = running_experiments[reservation_id].get('playbook_running', False)
                current_playbook = running_experiments[reservation_id].get('current_playbook', None)

        if playbook_running:
            print(f"[FINISH] Playbook '{current_playbook}' is currently running - waiting for completion", flush=True)
            max_wait_playbook = 300
            waited = 0

            while waited < max_wait_playbook:
                with experiments_lock:
                    if reservation_id not in running_experiments:
                        print(f"[FINISH] Threads stopped naturally", flush=True)
                        break

                    still_running = running_experiments[reservation_id].get('playbook_running', False)
                    if not still_running:
                        print(f"[FINISH] Playbook completed after {waited:.1f}s", flush=True)
                        break

                time.sleep(0.5)
                waited += 0.5

            if waited >= max_wait_playbook:
                print(f"[FINISH] WARNING: Playbook still running after {max_wait_playbook}s - forcing stop", flush=True)

        else:
            print(f"[FINISH] No playbook currently running - stop will be immediate", flush=True)

        with experiments_lock:
            if reservation_id in running_experiments:
                print(f"[FINISH] Removing reservation {reservation_id} from tracking to signal thread", flush=True)
                del running_experiments[reservation_id]

        print(f"[FINISH] Waiting for threads to complete...", flush=True)
        time.sleep(2.0)

        return finish_cleanup_and_remove(reservation_id, running_experiment, EXPERIMENT_PLAYBOOKS_DIR, experiments_lock, running_experiments, EXPERIMENT_RESULTS_DIR)

    except Exception as e:
        db.session.rollback()
        print(f"Error in finishExperiment: {str(e)}")
        return jsonify({
            'success': False,
            'error': f'Server error: {str(e)}'
        }), 500

@app.route('/api/experimenter/updateExperimentStatus', methods=['POST'])
def update_experiment_status():
    # update status of a 'completed' experiment
    try:
        data = request.json
        reservation_id = data.get('reservation_id')
        experiment_id = data.get('experiment_id')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        if experiment_id:
            experiment = Experiment.query.filter_by(
                id=experiment_id,
                reservation_id=reservation_id
            ).first()
        else:
            experiment = Experiment.query.filter_by(
                reservation_id=reservation_id,
                status='running'
            ).first()

        if not experiment:
            return jsonify({'success': False, 'error': 'Experiment not found'}), 404

        experiment.status = 'completed'
        db.session.commit()

        return jsonify({'success': True, 'message': 'Experiment status updated to completed'}), 200

    except Exception as e:
        db.session.rollback()
        print(f"Error updating experiment status: {str(e)}")
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500

@app.route('/api/experimenter/checkFileExists', methods=['POST'])
def check_file_exists():
    # check if a file already exists in experimentTemplate or experimentTelemetry
    try:
        data = request.get_json()
        reservation_id = data.get('reservation_id')
        filename = data.get('filename')
        file_type = data.get('file_type')  # 'template' or 'telemetry'

        if not reservation_id or not filename or not file_type:
            return jsonify({'success': False, 'error': 'Missing required fields'}), 400

        if file_type == 'template':
            file_path = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}', filename)
        elif file_type == 'telemetry':
            file_path = os.path.join(EXPERIMENT_TELEMETRY_DIR, f'res_{reservation_id}', filename)
        else:
            return jsonify({'success': False, 'error': 'Invalid file_type'}), 400

        exists = os.path.exists(file_path)
        return jsonify({'success': True, 'exists': exists}), 200

    except Exception as e:
        print(f"CHECK FILE EXISTS ERROR: {str(e)}", flush=True)
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5004, use_reloader=False)