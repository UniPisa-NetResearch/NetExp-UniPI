import os
import re
from io import BytesIO
import traceback
from flask import request, send_file, jsonify
import json
import yaml
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename
from ...database.db import db, UserMetrics, Reservation, Experiment
from pygnmi.client import gNMIclient
from ...app import app
from ..controller import (safe_filename, run_ansible_playbook, INVENTORY_DIR)
# true if development mode is active
TEST = True

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXPERIMENT_TEMPLATES_DIR = os.path.join(BASE_DIR, "experimentTemplates")
EXPERIMENT_PLAYBOOKS_DIR = os.path.join(BASE_DIR, "experimentPlaybooks")
EXPERIMENT_TELEMETRY_DIR = os.path.join(BASE_DIR, "experimentTelemetry")
EXPERIMENT_RESULTS_DIR = os.path.join(BASE_DIR, "experimentResults")

running_experiments = {}  # {reservation_id: {'futures': [...], 'stop_flag': threading.Event()}}
experiments_lock = threading.Lock()     #lock for stopping threads

def ensure_experiment_dirs():
    # create directories when don't exist
    os.makedirs(EXPERIMENT_TEMPLATES_DIR, exist_ok=True)
    os.makedirs(EXPERIMENT_PLAYBOOKS_DIR, exist_ok=True)
    os.makedirs(EXPERIMENT_TELEMETRY_DIR, exist_ok=True)
    os.makedirs(EXPERIMENT_RESULTS_DIR, exist_ok=True)

def get_next_available_id():
    # find first available ID in experiment table
    try:
        existing_ids = db.session.query(Experiment.id).order_by(Experiment.id).all()
        existing_ids = [row[0] for row in existing_ids]

        if not existing_ids:
            return 1

        for i in range(1, existing_ids[-1] + 1):
            if i not in existing_ids:
                return i

        return existing_ids[-1] + 1

    except Exception as e:
        print(f"Error finding next available ID: {str(e)}")
        return None

def collect_telemetry_data(reservation_id, experiment_name, telemetry_config, inventory_path, duration_s):
    # collect telemetry data during experiment
    try:
        results_dir = os.path.join(EXPERIMENT_RESULTS_DIR, f"res_{reservation_id}", experiment_name)
        os.makedirs(results_dir, exist_ok=True)

        print(f"[TELEMETRY] Starting collection for {experiment_name}", flush=True)
        print(f"[TELEMETRY] Duration: {duration_s}s", flush=True)

        # read device ips from inventory
        device_ips = {}
        with open(inventory_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('[') and not line.startswith('#'):
                    parts = line.split()
                    if len(parts) >= 2:
                        device_name = parts[0]
                        for part in parts[1:]:
                            if part.startswith('ansible_host='):
                                device_ips[device_name] = part.split('=')[1]

        print(f"[TELEMETRY] Found devices: {list(device_ips.keys())}", flush=True)
        # results structure: {metric_name: {target: [data_points]}}
        telemetry_results = {}
        results_lock = threading.Lock()

        start_time = time.time()
        end_time = start_time + duration_s

        stop_requested = threading.Event()

        def collect_metric_from_target(metric_name, metric_path, target, target_ip, sampling_period):
            # function run on a separate thread for each combination of metric/target
            if stop_requested.is_set():
                print(f"[TELEMETRY] Stop signal received for {metric_name} from {target}", flush=True)
                return

            # check global flag
            with experiments_lock:
                if reservation_id in running_experiments:
                    if running_experiments[reservation_id]['stop_flag'].is_set():
                        print(f"[TELEMETRY] Global stop for {metric_name} from {target}", flush=True)
                        stop_requested.set()  # propagate to other threads
                        return
                    
            print(f"[TELEMETRY] Thread started: {metric_name} from {target} every {sampling_period}s", flush=True)
            # create results structure
            with results_lock:
                if metric_name not in telemetry_results:
                    telemetry_results[metric_name] = {}
                telemetry_results[metric_name][target] = []

            last_collection = start_time
            sample_count = 0

            while time.time() < end_time:
                # check if the stop is requested
                with experiments_lock:
                    if reservation_id in running_experiments:
                        if running_experiments[reservation_id]['stop_flag'].is_set():
                            print(f"[TELEMETRY] Stop requested for {metric_name} from {target}", flush=True)
                            return

                current_time = time.time()

                # check if it is time to sample
                if current_time - last_collection >= sampling_period:
                    sample_count += 1
                    elapsed = current_time - start_time
                    print(f"[TELEMETRY] Sample {sample_count} at T+{elapsed:.1f}s: {metric_name} from {target}", flush=True)

                    try:
                        # use gNMI to collect metric
                        with gNMIclient(
                                target=(target_ip, 8080),
                                username='admin',
                                password='YourPaSsWoRd',
                                insecure=True,
                                skip_verify=True
                        ) as gc:
                            # check between OpenConfig and SONiC DB
                            if ':' in metric_name and not metric_name.startswith('/openconfig-'):
                                # SONiC DB format
                                db_name, path = metric_name.split(':', 1)
                                print(f"[TELEMETRY] Querying SONiC DB: {db_name}:{path}", flush=True)
                                result = gc.get(path=[path], target=db_name, encoding='json')
                            else:
                                # OpenConfig format
                                # create path for the test
                                match = re.match(r'^(/openconfig-[^:]+):(.+)$', metric_path)
                                if match:
                                    prefix = match.group(1)
                                    path_after_colon = match.group(2)
                                    # add, if there is not the double prefix
                                    prefix_without_slash = prefix[1:]

                                    if not path_after_colon.startswith(prefix_without_slash + ':'):
                                        # Add the same prefix
                                        path_for_execution = prefix + ':' + prefix_without_slash + ':' + path_after_colon
                                    else:
                                        # double prefix present, use the original one
                                        path_for_execution = metric_path
                                else:
                                    # double prefix present, use the original one
                                    path_for_execution = metric_path

                                print(f"[TELEMETRY] Querying OpenConfig: {path_for_execution}", flush=True)
                                result = gc.get(path=[path_for_execution], encoding='json')

                            timestamp = datetime.now().isoformat()

                            # save result in a thread-safe way
                            with results_lock:
                                telemetry_results[metric_name][target].append({
                                    'timestamp': timestamp,
                                    'value': result
                                })

                            print(f"[TELEMETRY] {metric_name} from {target} at {timestamp}", flush=True)

                    except Exception as e:
                        print(f"[TELEMETRY ERROR] {metric_name} from {target}: {str(e)}", flush=True)
                        traceback.print_exc()

                    last_collection = current_time

                time.sleep(0.5)  # check every 0.5 seconds

            print(f"[TELEMETRY] Thread finished: {metric_name} from {target}", flush=True)

        # create a thread for each combination metric/target
        threads = []
        for metric_config in telemetry_config['metric']:
            metric_name = metric_config['name']
            metric_path = metric_config['name']
            sampling_period = metric_config['sampling_period']
            targets = metric_config['targets']

            print(f"[TELEMETRY] Setting up collection for: {metric_name}", flush=True)
            print(f"[TELEMETRY] Targets: {targets}, Sampling: {sampling_period}s", flush=True)

            for target in targets:
                if target not in device_ips:
                    print(f"[TELEMETRY] Device {target} not found in inventory", flush=True)
                    continue

                target_ip = device_ips[target]

                # start thread for the current combination
                thread = threading.Thread(target=collect_metric_from_target, args=(metric_name, metric_path, target, target_ip, sampling_period), daemon=False)
                thread.start()
                threads.append(thread)

        print(f"[TELEMETRY] Started {len(threads)} collection threads", flush=True)

        stop_detected = False
        # wait every thread
        for idx, thread in enumerate(threads):
            while thread.is_alive():
                # check if stop requested
                with experiments_lock:
                    if reservation_id in running_experiments:
                        if running_experiments[reservation_id]['stop_flag'].is_set():
                            if not stop_detected:
                                print(f"[TELEMETRY] Stop requested, signaling all threads", flush=True)
                                stop_requested.set()
                                stop_detected = True
                            # threads will stp in the next check
                            #return False, "Telemetry collection stopped by user"

                thread.join(timeout=0.5)  # wait 1 second at a time

            print(f"[TELEMETRY] Thread {idx + 1}/{len(threads)} joined", flush=True)

        all_stopped = all(not thread.is_alive() for thread in threads)
        if not all_stopped:
            print(f"[TELEMETRY] WARNING: Some threads still alive, waiting...", flush=True)
            max_additional_wait = 5
            waited = 0
            while waited < max_additional_wait:
                still_alive = [i for i, thread in enumerate(threads) if thread.is_alive()]
                if not still_alive:
                    print(f"[TELEMETRY] All threads stopped after {waited:.1f}s additional wait", flush=True)
                    break
                print(f"[TELEMETRY] Still waiting for threads: {still_alive}", flush=True)
                time.sleep(0.5)
                waited += 0.5

            still_alive = [i for i, thread in enumerate(threads) if thread.is_alive()]
            if still_alive:
                print(f"[TELEMETRY] ERROR: Threads {still_alive} still alive after {max_additional_wait}s", flush=True)

        print(f"[TELEMETRY] All {len(threads)} threads confirmed stopped", flush=True)

        # save results in a JSON file
        results_file = os.path.join(results_dir, f"{experiment_name}_telemetry_results.json")
        with open(results_file, 'w') as f:
            json.dump(telemetry_results, f, indent=2)

        total_samples = sum(len(samples) for metric in telemetry_results.values() for samples in metric.values())

        print(f"[TELEMETRY] Collection completed. Total samples: {total_samples}", flush=True)
        print(f"[TELEMETRY] Results saved to {results_file}", flush=True)
        return True, None

    except Exception as e:
        error_msg = f"Telemetry collection failed: {str(e)}"
        print(f"[TELEMETRY ERROR] {error_msg}", flush=True)
        traceback.print_exc()
        return False, error_msg


def convert_iperf_experiment_to_schedule(experiment_data):
    # Convert a guided mode experiment in standard schedule format

    iperf_flows = experiment_data.get('iperf_flows', [])
    schedule_actions = experiment_data.get('schedule', [])
    playbooks_base_path = experiment_data.get('playbooks_base_path', 'iperf_common')

    # create flows dictionary
    flows_dict = {flow['flow_id']: flow for flow in iperf_flows}

    standard_schedule = []

    # group actions by time
    actions_by_time = {}

    for action_item in schedule_actions:
        time_offset = action_item.get('time_offset_s', 0)
        action = action_item.get('action', '')

        if time_offset not in actions_by_time:
            actions_by_time[time_offset] = []
        actions_by_time[time_offset].append(action_item)

    # process each group time
    for time_offset in sorted(actions_by_time.keys()):
        actions = actions_by_time[time_offset]

        all_servers = []
        server_extra_vars = {}

        all_clients = []
        client_flows = []

        for action_item in actions:
            action = action_item.get('action', '')

            if action == 'start_iperf_servers':
                # start server for every flow
                flow_ids = action_item.get('flow_ids', [])

                # create a separate task for each server
                for fid in flow_ids:
                    if fid in flows_dict:
                        flow = flows_dict[fid]
                        server = flow['server']

                        if server not in all_servers:
                            all_servers.append(server)
                            server_extra_vars[server] = {
                                'server_ip': flow['server_ip'],
                                'port': flow['port']
                            }

            elif action == 'start_iperf_client':
                # start client for a single flow
                flow_id = action_item.get('flow_id')
                if flow_id and flow_id in flows_dict:
                    flow = flows_dict[flow_id]
                    client = flow['client']

                    if client not in all_clients:
                        all_clients.append(client)

                    client_flows.append({
                        'client': client,
                        'flow': flow,
                        'flow_id': flow_id
                    })

            elif action == 'stop_iperf':
                # stop iperf in every device
                flow_ids = action_item.get('flow_ids', [])
                devices = set()
                for fid in flow_ids:
                    if fid in flows_dict:
                        devices.add(flows_dict[fid]['client'])
                        devices.add(flows_dict[fid]['server'])

                standard_schedule.append({
                    'time_offset_s': time_offset,
                    'name': 'STOP_IPERF',
                    'playbook': 'stop_iperf.yml',
                    'targets': list(devices)
                })


        if all_servers:
            servers_config = {}
            for server in all_servers:
                if server in server_extra_vars:
                    servers_config[server] = server_extra_vars[server]

            standard_schedule.append({
                'time_offset_s': time_offset,
                'name': f"START_SERVERS_T{time_offset}",
                'playbook': 'start_iperf_server.yml',
                'targets': all_servers,
                'extra_vars': {
                    'servers_config': servers_config
                }
            })

        if all_clients:
            clients_config = {}
            for cf in client_flows:
                client = cf['client']
                flow = cf['flow']
                flow_id = cf['flow_id']

                if client not in clients_config:
                    clients_config[client] = []

                clients_config[client].append({
                    'flow_id': flow_id,
                    'server': flow['server'],
                    'server_ip': flow['server_ip'],
                    'port': flow['port'],
                    'bandwidth_mbps': flow.get('bandwidth_mbps', 'unlimited'),
                    'protocol': flow.get('protocol', 'tcp'),
                    'duration': flow.get('duration_s', 60)
                })

            standard_schedule.append({
                'time_offset_s': time_offset,
                'name': f"START_CLIENTS_T{time_offset}",
                'playbook': 'start_iperf_client.yml',
                'targets': all_clients,
                'extra_vars': {
                    'clients_config': clients_config
                }
            })

    return standard_schedule, playbooks_base_path

def execute_experiment_schedule(reservation_id, experiment_name, experiment_data, inventory_path):
    # execute experiment schedule
    try:
        results_dir = os.path.join(EXPERIMENT_RESULTS_DIR, f"res_{reservation_id}", experiment_name)
        os.makedirs(results_dir, exist_ok=True)
        # get schedule section values and global duration
        schedule = experiment_data.get('schedule', [])
        duration_s = experiment_data.get('duration_s', 0)

        if 'playbooks_base_path' in experiment_data:
            # Guided mode: use shared playbooks
            playbooks_base = experiment_data['playbooks_base_path']
            playbooks_dir = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, playbooks_base)
            print(f"[EXPERIMENT] Using shared playbooks: {playbooks_dir}", flush=True)
        else:
            # Free/Interactive mode
            experiment_name_base = os.path.splitext(experiment_name)[0]
            playbooks_dir = os.path.join(EXPERIMENT_PLAYBOOKS_DIR, f'res_{reservation_id}', experiment_name_base)

        print(f"[EXPERIMENT] Starting execution of {experiment_name}", flush=True)
        print(f"[EXPERIMENT] Total duration: {duration_s}s", flush=True)
        print(f"[EXPERIMENT] Schedule steps: {len(schedule)}", flush=True)

        start_time = time.time()
        start_dt = datetime.fromtimestamp(start_time)
        print(f"[EXPERIMENT] Start time: {start_dt.strftime('%Y-%m-%d %H:%M:%S.%f')}", flush=True)
        print(f"[EXPERIMENT] Start timestamp: {start_time}", flush=True)

        execution_log = []
        has_errors = False

        # sort schedule for time_offset_s
        sorted_schedule = sorted(schedule, key=lambda x: x.get('time_offset_s', 0))
        scheduled_times = []

        for step in sorted_schedule:
            time_offset = step.get('time_offset_s', 0)
            absolute_time = start_time + time_offset
            scheduled_times.append({
                'step': step,
                'time_offset': time_offset,
                'absolute_time': absolute_time
            })

        for item in scheduled_times:
            # check if stop has been requested
            with experiments_lock:
                if reservation_id in running_experiments:
                    if running_experiments[reservation_id]['stop_flag'].is_set():
                        print(f"[EXPERIMENT] Stop requested, aborting execution", flush=True)
                        return False, "Experiment stopped by user"

            step = item['step']
            time_offset = item['time_offset']
            #absolute_time = item['absolute_time']

            step_name = step.get('name', 'unnamed_step')
            playbook_name = step.get('playbook', '')
            targets = step.get('targets', [])

            absolute_time = start_time + time_offset
            #wait_time = absolute_time - time.time()

            current_time = time.time()
            wait_time = absolute_time - current_time
            elapsed = current_time - start_time

            print(f"[EXPERIMENT] Step '{step_name}' scheduled at T+{time_offset}s (absolute: {datetime.fromtimestamp(absolute_time).strftime('%H:%M:%S')})", flush=True)
            print(f"[EXPERIMENT] Current time: T+{elapsed:.1f}s (absolute: {datetime.fromtimestamp(current_time).strftime('%H:%M:%S')})", flush=True)
            print(f"[EXPERIMENT] Wait time: {wait_time:.1f}s", flush=True)

            if wait_time > 0:
                    print(f"[EXPERIMENT] Waiting {wait_time:.1f}s until step '{step_name}'", flush=True)
                    end_wait_time = time.time() + wait_time
                    while time.time() < end_wait_time:
                        # check if the stop has been requested during wait
                        with experiments_lock:
                            if reservation_id in running_experiments:
                                if running_experiments[reservation_id]['stop_flag'].is_set():
                                    print(f"[EXPERIMENT] Stop requested during wait, aborting (no playbook running)",
                                          flush=True)
                                    return False, "Experiment stopped by user during wait"

                        # sleep for maximum 0,5 seconds
                        remaining = end_wait_time - time.time()
                        if remaining > 0:
                            time.sleep(min(0.5, remaining))

            elif wait_time < -5:  # print if the delay is greater than 5 seconds
                print(f"[EXPERIMENT WARNING] Step '{step_name}' is {abs(wait_time):.1f}s late!", flush=True)

            # effective time of execution
            actual_time = time.time()
            actual_elapsed = actual_time - start_time
            actual_dt = datetime.fromtimestamp(actual_time)
            print(f"[EXPERIMENT] Executing '{step_name}' at T+{actual_elapsed:.1f}s (absolute: {actual_dt.strftime('%H:%M:%S.%f')})", flush=True)

            # run playbook
            playbook_path = os.path.join(playbooks_dir, playbook_name)

            if not os.path.exists(playbook_path):
                error_msg = f"Playbook not found: {playbook_path}"
                print(f"[EXPERIMENT ERROR] {error_msg}", flush=True)
                execution_log.append({
                    'step': step_name,
                    'time_offset_s': time_offset,
                    'playbook': playbook_name,
                    'status': 'error',
                    'error': error_msg
                })
                has_errors = True
                continue

            print(f"[EXPERIMENT] Executing step '{step_name}' - playbook: {playbook_name}", flush=True)

            # Timestamp before execution
            exec_start = time.time()
            exec_elapsed = exec_start - start_time
            print(f"[EXPERIMENT] Playbook execution starting at T+{exec_elapsed:.1f}s (scheduled: T+{time_offset}s)",
                  flush=True)

            extra_vars = step.get('extra_vars', {})
            extra_vars['target_devices'] = targets

            returncode, stdout, stderr = run_ansible_playbook(inventory_path=inventory_path, playbook_path=playbook_path, extra_vars=extra_vars, timeout=300)

            # Timestamp after execution
            exec_end = time.time()
            exec_duration = exec_end - exec_start
            exec_total_elapsed = exec_end - start_time
            print(f"[EXPERIMENT] Playbook '{playbook_name}' completed in {exec_duration:.1f}s (now at T+{exec_total_elapsed:.1f}s)", flush=True)

            step_result = {
                'step': step_name,
                'time_offset_s': time_offset,
                'scheduled_absolute_time': absolute_time,
                'actual_absolute_time': actual_time,
                'playbook': playbook_name,
                'targets': targets,
                'returncode': returncode,
                'status': 'success' if returncode == 0 else 'error',
                'stdout': stdout,
                'stderr': stderr
            }

            execution_log.append(step_result)

            if returncode == 0:
                print(f"[EXPERIMENT] Step '{step_name}' completed successfully", flush=True)
            else:
                print(f"[EXPERIMENT ERROR] Step '{step_name}' failed with code {returncode}", flush=True)
                has_errors = True

            # check flag after playbook execution
            with experiments_lock:
                if reservation_id in running_experiments:
                    if running_experiments[reservation_id]['stop_flag'].is_set():
                        print(f"[EXPERIMENT] Stop requested after playbook completion, stopping now", flush=True)
                        print(f"[EXPERIMENT] Playbook '{playbook_name}' completed successfully before stopping",
                              flush=True)

                        # save partial log
                        log_file = os.path.join(results_dir, f"{experiment_name}_execution_log.json")
                        with open(log_file, 'w') as f:
                            json.dump(execution_log, f, indent=2)
                        print(f"[EXPERIMENT] Partial execution log saved to: {log_file}", flush=True)

                        return False, "Experiment stopped by user (playbook completed safely)"

        # save execution log
        log_file = os.path.join(results_dir, f"{experiment_name}_execution_log.json")
        with open(log_file, 'w') as f:
            json.dump(execution_log, f, indent=2)

        print(f"[EXPERIMENT] Execution completed. Log saved to {log_file}", flush=True)
        if has_errors:
            return True, "Experiment completed with some errors"
        else:
            return True, None

    except Exception as e:
        error_msg = f"Experiment execution failed: {str(e)}"
        print(f"[EXPERIMENT ERROR] {error_msg}", flush=True)
        traceback.print_exc()
        return False, error_msg

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
        ensure_experiment_dirs()

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
        reservation_id = data.get('reservation_id')

        if not experiment_name or not reservation_id:
            return jsonify({'success': False, 'error': 'Missing experiment_name or reservation_id'}), 400

        # check if there is a running experiment for that reservation
        existing_run = Experiment.query.filter_by(reservation_id=reservation_id, status='running').first()

        if existing_run:
            return jsonify({
                'success': False,
                'error': f'An experiment is already running: {existing_run.experiment_name}'
            }), 400

        telemetry_file_path = os.path.join(EXPERIMENT_TELEMETRY_DIR, f'res_{reservation_id}', f'{experiment_name}_telemetry.yml')
        # check if file exists
        if not os.path.exists(telemetry_file_path):
            return jsonify({
                'success': False,
                'error': f'Telemetry file not found: {experiment_name}_telemetry.yml'
            }), 404

        experiment_file_path = os.path.join(EXPERIMENT_TEMPLATES_DIR, f'res_{reservation_id}', f'{experiment_name}.yml')
        # get duration_s
        try:
            with open(telemetry_file_path, 'r') as f:
                telemetry_data = yaml.safe_load(f)

            with open(experiment_file_path, 'r') as f:
                experiment_data = yaml.safe_load(f)

            duration_s = experiment_data.get('duration_s')

            if 'iperf_flows' in experiment_data and 'playbooks_base_path' in experiment_data:
                print(f"[RUN] Detected guided mode (iperf) experiment", flush=True)

                # convert in standard format
                converted_schedule, playbooks_path = convert_iperf_experiment_to_schedule(experiment_data)

                # change schedule with the converted one
                experiment_data['schedule'] = converted_schedule

                print(f"[RUN] Converted {len(converted_schedule)} schedule steps", flush=True)
                print(f"[RUN] Using playbooks from: {playbooks_path}", flush=True)

            if duration_s is None:
                return jsonify({
                    'success': False,
                    'error': 'duration_s field not found in telemetry file'
                }), 400

            duration_s = int(duration_s)

        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'Error reading telemetry file: {str(e)}'
            }), 500

        # find reservation
        reservation = Reservation.query.filter_by(id=reservation_id).first()

        if not reservation:
            return jsonify({
                'success': False,
                'error': f'Reservation {reservation_id} not found'
            }), 404

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
        experiment_end = experiment_start + timedelta(seconds=duration_s)

        # find next available id
        next_id = get_next_available_id()

        # find record inside the database
        if next_id is not None:
            new_experiment = Experiment(
                id=next_id,
                reservation_id=reservation_id,
                experiment_name=experiment_name,
                start_time=experiment_start,
                end_time=experiment_end,
                duration_s=duration_s,
                status='running'
            )
        else:
            new_experiment = Experiment(
                reservation_id=reservation_id,
                experiment_name=experiment_name,
                start_time=experiment_start,
                end_time=experiment_end,
                duration_s=duration_s,
                status='running'
            )

        db.session.add(new_experiment)
        db.session.commit()

        experiment_id = new_experiment.id

        # inventory path
        safe_res = safe_filename(f"res-{reservation_id}-inventory")
        inventory_path = os.path.join(INVENTORY_DIR, f"{safe_res}.ini")

        # parallel execution: experiment + telemetry
        def run_experiment_with_telemetry():
            try:
                stop_flag = threading.Event()
                with experiments_lock:
                    running_experiments[reservation_id] = {
                        'futures': [],
                        'stop_flag': stop_flag
                    }

                with ThreadPoolExecutor(max_workers=2) as executor:
                    # start experiment and telemetry execution
                    experiment_future = executor.submit(
                        execute_experiment_schedule,
                        reservation_id,
                        experiment_name,
                        experiment_data,
                        inventory_path
                    )

                    telemetry_future = executor.submit(
                        collect_telemetry_data,
                        reservation_id,
                        experiment_name,
                        telemetry_data,
                        inventory_path,
                        duration_s
                    )

                    # save Futures and flag
                    with experiments_lock:
                        if reservation_id in running_experiments:
                            running_experiments[reservation_id]['futures'] = [experiment_future, telemetry_future]

                    # wait completion
                    experiment_success, experiment_error = experiment_future.result()
                    telemetry_success, telemetry_error = telemetry_future.result()

                    # remove from dictionary when completed
                    with experiments_lock:
                        if reservation_id in running_experiments:
                            del running_experiments[reservation_id]

                    with app.app_context():
                        # update experiment status
                        exp = Experiment.query.filter_by(id=experiment_id).first()
                        if exp:
                            # check if the termination is volunteered
                            is_user_stop = ((not experiment_success and experiment_error and "stopped by user" in experiment_error.lower()) or
                                    (not telemetry_success and telemetry_error and "stopped by user" in telemetry_error.lower()))

                            if is_user_stop:
                                exp.status = "stopped"
                                print(f"[EXPERIMENT] {experiment_name} stopped by user", flush=True)

                            elif experiment_success and telemetry_success:
                                exp.status = 'completed'
                                print(f"[EXPERIMENT] {experiment_name} marked as completed", flush=True)
                            else:
                                exp.status = 'error'
                                error_details = []
                                if not experiment_success  and not (experiment_error and "stopped by user" in experiment_error.lower()):
                                    error_details.append(f"Experiment: {experiment_error}")
                                if not telemetry_success and not (telemetry_error and "stopped by user" in telemetry_error.lower()):
                                    error_details.append(f"Telemetry: {telemetry_error}")
                                if error_details:
                                    print(f"[EXPERIMENT] {experiment_name} failed: {', '.join(error_details)}", flush=True)
                                else:
                                    print(f"[EXPERIMENT] {experiment_name} encountered an error", flush=True)

                            db.session.commit()

            except Exception as e:
                print(f"[EXPERIMENT THREAD ERROR] {str(e)}", flush=True)
                traceback.print_exc()
                with app.app_context():
                    exp = Experiment.query.filter_by(id=experiment_id).first()
                    if exp:
                        exp.status = 'error'
                        db.session.commit()

        # start thread for execution
        thread = threading.Thread(target=run_experiment_with_telemetry, daemon=True)
        thread.start()

        return jsonify({
            'success': True,
            'duration_s': duration_s,
            'start_time': experiment_start.isoformat(),
            'end_time': experiment_end.isoformat(),
            'experiment_id': new_experiment.id,
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

        # find running experiment for the current reservation
        running_experiment = Experiment.query.filter_by(
            reservation_id=reservation_id,
            status='running'
        ).first()

        if not running_experiment:
            return jsonify({
                'success': True,
                'running': False,
                'message': 'No experiment running'
            }), 200

        now = datetime.now()

        # check if the experiment is ended
        if now >= running_experiment.end_time:
            # update status to completed
            running_experiment.status = 'completed'
            db.session.commit()

            return jsonify({
                'success': True,
                'running': False,
                'just_completed': True,
                'experiment_name': running_experiment.experiment_name,
                'experiment_id': running_experiment.id,
                'message': 'Experiment completed'
            }), 200

        # compute remaining time in seconds
        remaining_seconds = int((running_experiment.end_time - now).total_seconds())

        return jsonify({
            'success': True,
            'running': True,
            'experiment_name': running_experiment.experiment_name,
            'remaining_seconds': remaining_seconds,
            'total_duration_s': running_experiment.duration_s,
            'start_time': running_experiment.start_time.isoformat(),
            'end_time': running_experiment.end_time.isoformat(),
            'experiment_id': running_experiment.id
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
            return jsonify({
                'success': False,
                'error': 'No experiment found for this reservation'
            }), 404

        print(f"[FINISH] Stopping experiment for reservation {reservation_id}", flush=True)


        # set stop flag for threads
        with experiments_lock:
            if reservation_id in running_experiments:
                print(f"[FINISH] Setting stop flag for threads", flush=True)
                running_experiments[reservation_id]['stop_flag'].set()
            else:
                print(f"[FINISH] Warning: No running experiment tracked for reservation {reservation_id}", flush=True)

        print(f"[FINISH] Waiting for threads to stop...", flush=True)
        max_wait = 20
        waited = 0
        threads_stopped = False

        while waited < max_wait:
            with experiments_lock:
                if reservation_id not in running_experiments:
                    print(f"[FINISH] Threads stopped naturally", flush=True)
                    threads_stopped = True
                    break

                # check if futures are ready
                futures = running_experiments[reservation_id].get('futures', [])
                if futures:
                    all_done = all(f.done() for f in futures)
                    if all_done:
                        print(f"[FINISH] All futures completed after {waited:.1f}s", flush=True)
                        del running_experiments[reservation_id]
                        threads_stopped = True
                        break

            time.sleep(0.5)
            waited += 0.5
        if not threads_stopped:
            # remove if still running
            with experiments_lock:
                if reservation_id in running_experiments:
                    print(f"[FINISH] Force removing experiment from tracking after {max_wait}s timeout", flush=True)
                    del running_experiments[reservation_id]

        print(f"[FINISH] Running cleanup playbook", flush=True)

        # get inventory path
        safe_res = safe_filename(f"res-{reservation_id}-inventory")
        inventory_path = os.path.join(INVENTORY_DIR, f"{safe_res}.ini")

        cleanup_success = True
        cleanup_message = ""

        if not os.path.exists(inventory_path):
            print(f"[FINISH] Warning: inventory file not found", flush=True)
            cleanup_message = "Warning: inventory file not found, cleanup skipped"
        else:
            # cleanup playbook
            cleanup_playbook_path = os.path.join(
                EXPERIMENT_PLAYBOOKS_DIR,
                "iperf_common",
                "cleanup_iperf.yml"
            )

            if os.path.exists(cleanup_playbook_path):
                print(f"[FINISH] Executing cleanup playbook: {cleanup_playbook_path}", flush=True)

                # run playbook on every device
                returncode, stdout, stderr = run_ansible_playbook(
                    inventory_path=inventory_path,
                    playbook_path=cleanup_playbook_path,
                    extra_vars={},
                    timeout=120
                )

                if returncode == 0:
                    print(f"[FINISH] Cleanup playbook completed successfully", flush=True)
                    cleanup_message = "Cleanup completed successfully"
                else:
                    print(f"[FINISH] Cleanup playbook failed with code {returncode}", flush=True)
                    print(f"[FINISH] stdout: {stdout}", flush=True)
                    print(f"[FINISH] stderr: {stderr}", flush=True)
                    cleanup_success = False
                    cleanup_message = f"Cleanup failed: {stderr[:200]}"
            else:
                print(f"[FINISH] Warning: cleanup playbook not found at {cleanup_playbook_path}", flush=True)

        # remove record from database
        print(f"[FINISH] Removing experiment from database", flush=True)
        db.session.delete(running_experiment)
        db.session.commit()

        print(f"[FINISH] Experiment finished and removed successfully", flush=True)

        return jsonify({
            'success': True,
            "message": f"Experiment stopped and removed. {cleanup_message}",
            "cleanup_success": cleanup_success
        }), 200

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


@app.route('/api/experimenter/getExperimentResults', methods=['POST'])
def get_experiment_results():
    # return results of the last completed experiment
    try:
        data = request.json
        reservation_id = data.get('reservation_id')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        # find last completed experiment
        completed_experiment = Experiment.query.filter_by(
            reservation_id=reservation_id,
            status='completed'
        ).order_by(Experiment.end_time.desc()).first()

        if not completed_experiment:
            return jsonify({
                'success': False,
                'error': 'No completed experiment found'
            }), 404

        experiment_name = completed_experiment.experiment_name
        results_dir = os.path.join(EXPERIMENT_RESULTS_DIR, f"res_{reservation_id}", experiment_name)

        # read telemetry files
        telemetry_file = os.path.join(results_dir, f"{experiment_name}_telemetry_results.json")
        execution_log_file = os.path.join(results_dir, f"{experiment_name}_execution_log.json")

        telemetry_results = None
        execution_log = None

        if os.path.exists(telemetry_file):
            with open(telemetry_file, 'r') as f:
                telemetry_results = json.load(f)

        if os.path.exists(execution_log_file):
            with open(execution_log_file, 'r') as f:
                execution_log = json.load(f)

        return jsonify({
            'success': True,
            'experiment_name': experiment_name,
            'experiment_id': completed_experiment.id,
            'start_time': completed_experiment.start_time.isoformat(),
            'end_time': completed_experiment.end_time.isoformat(),
            'duration_s': completed_experiment.duration_s,
            'telemetry_results': telemetry_results,
            'execution_log': execution_log
        }), 200

    except Exception as e:
        print(f"Error in getExperimentResults: {str(e)}")
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': f'Server error: {str(e)}'
        }), 500

@app.route('/api/experimenter/downloadResults', methods=['POST'])
def download_results():
    # download result files as ZIP
    try:
        import zipfile
        from io import BytesIO

        data = request.json
        reservation_id = data.get('reservation_id')
        experiment_name = data.get('experiment_name')

        if not reservation_id or not experiment_name:
            return jsonify({'success': False, 'error': 'Missing parameters'}), 400

        results_dir = os.path.join(EXPERIMENT_RESULTS_DIR, f"res_{reservation_id}", experiment_name)

        if not os.path.exists(results_dir):
            return jsonify({'success': False, 'error': 'Results not found'}), 404

        # create in memory ZIP
        memory_file = BytesIO()
        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(results_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, results_dir)
                    zf.write(file_path, arcname)

        memory_file.seek(0)

        return send_file(
            memory_file,
            mimetype='application/zip',
            as_attachment=True,
            download_name=f'{experiment_name}_results.zip'
        )

    except Exception as e:
        print(f"Error in downloadResults: {str(e)}")
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5004, use_reloader=False)