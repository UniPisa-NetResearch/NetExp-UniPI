import os
import re
import json
import yaml
import time
import threading
import traceback
import shutil
from datetime import datetime

from flask import jsonify
from pygnmi.client import gNMIclient
from ...database.db import db, Experiment
from ..controller import run_ansible_playbook, win_to_wsl_path, safe_filename, INVENTORY_DIR
from ...app import app

# function to indent yaml file
class IndentedDumper(yaml.Dumper):
    def increase_indent(self, flow=False, indentless=False):
        return super(IndentedDumper, self).increase_indent(flow, False)

    def ignore_aliases(self, data):
        return True

def ensure_experiment_dirs(templates_dir, playbooks_dir, telemetry_dir, results_dir):
    # create directories when don't exist
    os.makedirs(templates_dir, exist_ok=True)
    os.makedirs(playbooks_dir, exist_ok=True)
    os.makedirs(telemetry_dir, exist_ok=True)
    os.makedirs(results_dir, exist_ok=True)

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

def finalize_batch_results(reservation_id, experiment_names, results_base_dir):
    # copy temporary results to final location and remove temp directories

    try:
        for exp_name in experiment_names:
            temp_dir = os.path.join(results_base_dir, f"res_{reservation_id}", f"temp_{exp_name}")
            final_dir = os.path.join(results_base_dir, f"res_{reservation_id}", exp_name)

            if os.path.exists(temp_dir):
                print(f"[BATCH FINALIZE] Copying results from temp_{exp_name} to {exp_name}", flush=True)

                # if final directory exists, remove it first
                if os.path.exists(final_dir):
                    shutil.rmtree(final_dir)

                # copy temp directory to final location
                shutil.copytree(temp_dir, str(final_dir))

                # remove temp directory
                shutil.rmtree(temp_dir)
                print(f"[BATCH FINALIZE] Finalized results for {exp_name}", flush=True)

        return True, None
    except Exception as e:
        error_msg = f"Error finalizing batch results: {str(e)}"
        print(f"[BATCH FINALIZE] ERROR: {error_msg}", flush=True)
        traceback.print_exc()
        return False, error_msg

def cleanup_batch_temp_results(reservation_id, experiment_names, results_base_dir):
    # remove temporary result directories when a batch is terminated

    try:
        import shutil
        removed_count = 0
        for exp_name in experiment_names:
            temp_dir = os.path.join(results_base_dir, f"res_{reservation_id}", f"temp_{exp_name}")

            if os.path.exists(temp_dir):
                print(f"[BATCH CLEANUP] Removing temporary results for temp_{exp_name}", flush=True)
                shutil.rmtree(temp_dir)
                removed_count += 1

        print(f"[BATCH CLEANUP] Removed {removed_count} temporary result directories", flush=True)
        return True, None
    except Exception as e:
        error_msg = f"Error cleaning up batch temp results: {str(e)}"
        print(f"[BATCH CLEANUP] ERROR: {error_msg}", flush=True)
        traceback.print_exc()
        return False, error_msg

def collect_telemetry_data(reservation_id, experiment_name, telemetry_config, inventory_path, duration_s, results_base_dir, running_experiments, experiments_lock, is_batch=False):
    # collect telemetry data during experiment
    try:
        exp_dir_name = f"temp_{experiment_name}" if is_batch else experiment_name
        results_dir = os.path.join(results_base_dir, f"res_{reservation_id}", exp_dir_name)
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

            print(f"[TELEMETRY] Thread started: {metric_name} from {target} every {sampling_period}s", flush=True)
            # create results structure
            with results_lock:
                if metric_name not in telemetry_results:
                    telemetry_results[metric_name] = {}
                telemetry_results[metric_name][target] = []

            last_collection = start_time
            sample_count = 0

            while time.time() < end_time:
                if stop_requested.is_set():
                    print(f"[TELEMETRY] Local stop detected for {metric_name} from {target}", flush=True)
                    return

                current_time = time.time()

                # check if it is time to sample
                if current_time - last_collection >= sampling_period:
                    sample_count += 1
                    elapsed = current_time - start_time
                    print(f"[TELEMETRY] Sample {sample_count} at T+{elapsed:.1f}s: {metric_name} from {target}",
                          flush=True)

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

                if stop_requested.is_set():
                    print(f"[TELEMETRY] Stop before sleep for {metric_name} from {target}", flush=True)
                    return

                with experiments_lock:
                    if reservation_id not in running_experiments:
                        print(f"[TELEMETRY] Reservation removed before sleep - stopping {metric_name} from {target}",
                              flush=True)
                        return

                sleep_time = 0.5
                sleep_start = time.time()

                while time.time() - sleep_start < sleep_time:
                    time.sleep(0.1)

                    if stop_requested.is_set():
                        print(f"[TELEMETRY] Stop after sleep for {metric_name} from {target}", flush=True)
                        return

                    with experiments_lock:
                        if reservation_id not in running_experiments:
                            print(
                                f"[TELEMETRY] Reservation removed during sleep - stopping {metric_name} from {target}",
                                flush=True)
                            return

                if stop_requested.is_set():
                    print(f"[TELEMETRY] Stop after sleep for {metric_name} from {target}", flush=True)
                    return

                with experiments_lock:
                    if reservation_id not in running_experiments:
                        print(f"[TELEMETRY] Reservation removed after sleep - stopping {metric_name} from {target}",
                              flush=True)
                        return

            if stop_requested.is_set():
                print(f"[TELEMETRY] Thread {metric_name} from {target} stopped by request", flush=True)
                return

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
                thread = threading.Thread(target=collect_metric_from_target,
                                          args=(metric_name, metric_path, target, target_ip, sampling_period),
                                          daemon=False)
                thread.start()
                threads.append(thread)

        print(f"[TELEMETRY] Started {len(threads)} collection threads", flush=True)

        stop_detected = False
        while True:
            with experiments_lock:
                if reservation_id not in running_experiments:
                    print(f"[TELEMETRY] Stop requested - terminating immediately (daemon threads)", flush=True)
                    stop_detected = True
                    break

            # check if time is naturally expired
            if time.time() >= end_time:
                print(f"[TELEMETRY] Collection time completed", flush=True)
                break

            time.sleep(0.5)

        # if stopped, exit
        if stop_detected:
            print(f"[TELEMETRY] Stopped by user - daemon threads will terminate automatically", flush=True)
            return False, "Telemetry collection stopped by user"

        # wait every thread
        for idx, thread in enumerate(threads):
            thread.join(timeout=0.5)  # wait 1 second at a time
            print(f"[TELEMETRY] Thread {idx + 1}/{len(threads)} joined", flush=True)

        # save results in a JSON file
        results_file = os.path.join(str(results_dir), f"{experiment_name}_telemetry_results.json")
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

def execute_experiment_schedule(reservation_id, username, experiment_name, experiment_data, inventory_path, results_base_dir, playbooks_base_dir, running_experiments, experiments_lock, test_mode, is_batch=False):
    # execute experiment schedule
    with experiments_lock:
        if reservation_id in running_experiments:
            running_experiments[reservation_id]['playbook_running'] = False
            running_experiments[reservation_id]['next_step_time'] = None
            running_experiments[reservation_id]['current_playbook'] = None
    try:
        exp_dir_name = f"temp_{experiment_name}" if is_batch else experiment_name
        results_dir = os.path.join(results_base_dir, f"res_{reservation_id}", exp_dir_name)
        os.makedirs(results_dir, exist_ok=True)
        # get schedule section values and global duration
        schedule = experiment_data.get('schedule', [])
        duration_s = experiment_data.get('duration_s', 0)

        if 'playbooks_base_path' in experiment_data:
            # Guided mode: use shared playbooks
            playbooks_base = experiment_data['playbooks_base_path']
            playbooks_dir = os.path.join(playbooks_base_dir, playbooks_base)
            print(f"[EXPERIMENT] Using shared playbooks: {playbooks_dir}", flush=True)
        else:
            # Free/Interactive mode
            experiment_name_base = os.path.splitext(experiment_name)[0]
            playbooks_dir = os.path.join(playbooks_base_dir, f'res_{reservation_id}', experiment_name_base)

            cleanup_playbook_path = os.path.join(playbooks_base_dir, 'iperf_common', 'stop_iperf.yml')
            if os.path.exists(cleanup_playbook_path):
                wsl_results_dir = ''
                if test_mode:
                    wsl_results_dir = win_to_wsl_path(results_dir)
                schedule.append({
                    'time_offset_s': duration_s,
                    'name': 'CLEANUP_IPERF',
                    'targets': [],
                    'playbook': '../../iperf_common/stop_iperf.yml',
                    'extra_vars': {'experiment_results_path': wsl_results_dir if test_mode else results_dir, 'save_results': True}
                })


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
                if reservation_id not in running_experiments:
                    print(f"[EXPERIMENT] Stop requested, aborting execution", flush=True)
                    return False, "Experiment stopped by user", None, None

            step = item['step']
            time_offset = item['time_offset']

            step_name = step.get('name')
            playbook_name = step.get('playbook', '')
            targets = step.get('targets', [])

            absolute_time = start_time + time_offset

            current_time = time.time()
            wait_time = absolute_time - current_time
            elapsed = current_time - start_time

            # set time of netx step
            with experiments_lock:
                if reservation_id in running_experiments:
                    running_experiments[reservation_id]['next_step_time'] = absolute_time

            print(f"[EXPERIMENT] Step '{step_name}' scheduled at T+{time_offset}s (absolute: {datetime.fromtimestamp(absolute_time).strftime('%H:%M:%S')})", flush=True)
            print(f"[EXPERIMENT] Current time: T+{elapsed:.1f}s (absolute: {datetime.fromtimestamp(current_time).strftime('%H:%M:%S')})", flush=True)
            print(f"[EXPERIMENT] Wait time: {wait_time:.1f}s", flush=True)

            if wait_time > 0:
                    print(f"[EXPERIMENT] Waiting {wait_time:.1f}s until step '{step_name}'", flush=True)
                    end_wait_time = time.time() + wait_time
                    while time.time() < end_wait_time:
                        # check if the stop has been requested during wait
                        with experiments_lock:
                            if reservation_id not in running_experiments:
                                print(f"[EXPERIMENT] Reservation removed after playbook - stopping now", flush=True)
                                return False, "Experiment stopped by user during wait", None, None

                        # sleep for maximum 0,2 seconds
                        remaining = end_wait_time - time.time()
                        if remaining > 0:
                            time.sleep(min(0.2, remaining))

            elif wait_time < -5:  # print if the delay is greater than 5 seconds
                print(f"[EXPERIMENT WARNING] Step '{step_name}' is {abs(wait_time):.1f}s late!", flush=True)

            with experiments_lock:
                if reservation_id not in running_experiments:
                    print(f"[EXPERIMENT] Stop requested before executing {step_name}, aborting", flush=True)
                    return False, "Experiment stopped by user before playbook execution", None, None

            # effective time of execution
            actual_time = time.time()
            actual_elapsed = actual_time - start_time
            actual_dt = datetime.fromtimestamp(actual_time)
            print(f"[EXPERIMENT] Executing '{step_name}' at T+{actual_elapsed:.1f}s (absolute: {actual_dt.strftime('%H:%M:%S.%f')})", flush=True)

            if playbook_name.startswith('../') or playbook_name.startswith('..\\'):
                playbook_path = os.path.normpath(os.path.join(str(playbooks_dir), playbook_name))
                print(f"[EXPERIMENT] Resolved relative path: {playbook_name} -> {playbook_path}", flush=True)
            else:
                # run playbook
                playbook_path = os.path.join(str(playbooks_dir), playbook_name)

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

            # check if the playbook is predefined or loaded by user
            is_user_playbook = f"res_{reservation_id}" in playbook_path and "iperf_common" not in playbook_path
            if is_user_playbook:
                remote_user = username
            else:
                remote_user = None

            # Timestamp before execution
            exec_start = time.time()
            exec_elapsed = exec_start - start_time
            print(f"[EXPERIMENT] Playbook execution starting at T+{exec_elapsed:.1f}s (scheduled: T+{time_offset}s)", flush=True)

            with experiments_lock:
                if reservation_id in running_experiments:
                    running_experiments[reservation_id]['playbook_running'] = True
                    running_experiments[reservation_id]['current_playbook'] = playbook_name

            extra_vars = step.get('extra_vars', {})
            extra_vars['target_devices'] = targets

            if 'STOP_IPERF' in step.get('name', ''):
                # test mode
                wsl_results_dir = ''
                if test_mode:
                    wsl_results_dir = win_to_wsl_path(results_dir)

                extra_vars = step.get('extra_vars', {})
                extra_vars['experiment_results_path'] = wsl_results_dir if test_mode else results_dir
                if 'save_results' not in extra_vars:
                    extra_vars['save_results'] = True
                step['extra_vars'] = extra_vars

            with experiments_lock:
                if reservation_id not in running_experiments:
                    print(f"[EXPERIMENT] Reservation {reservation_id} removed before executing '{step_name}' - aborting", flush=True)
                    return False, "Experiment stopped by user (reservation removed before playbook)", None, None

                running_experiments[reservation_id]['playbook_running'] = True
                running_experiments[reservation_id]['current_playbook'] = playbook_name

            returncode, stdout, stderr = run_ansible_playbook(inventory_path=inventory_path, playbook_path=playbook_path, extra_vars=extra_vars, timeout=300, remote_user=remote_user)
            # reset flag after execution
            with experiments_lock:
                if reservation_id in running_experiments:
                    running_experiments[reservation_id]['playbook_running'] = False
                    running_experiments[reservation_id]['current_playbook'] = None

            # Timestamp after execution
            exec_end = time.time()
            exec_duration = exec_end - exec_start
            exec_total_elapsed = exec_end - start_time
            print(f"[EXPERIMENT] Playbook '{playbook_name}' completed in {exec_duration:.1f}s (now at T+{exec_total_elapsed:.1f}s)", flush=True)

            step_result = {
                'step': step_name,
                'time_offset_s': time_offset,
                'scheduled_absolute_time': absolute_time,
                'actual_start_time': actual_time,
                'actual_end_time': exec_end,
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
                if reservation_id not in running_experiments:
                    print(f"[EXPERIMENT] Reservation removed after playbook - stopping now", flush=True)
                    return False, "Experiment stopped by user (playbook completed safely)", None, None

        # save execution log
        log_file = os.path.join(str(results_dir), f"{experiment_name}_execution_log.json")
        with open(log_file, 'w') as f:
            json.dump(execution_log, f, indent=2)

        print(f"[EXPERIMENT] Execution completed. Log saved to {log_file}", flush=True)

        actual_end_timestamp = None
        if execution_log:
            last_step = execution_log[-1]
            actual_end_timestamp = last_step.get('actual_end_time')
            print(f"[EXPERIMENT] Experiment start timestamp (T+0.0s): {start_time}", flush=True)
            print(f"[EXPERIMENT] Actual end timestamp: {actual_end_timestamp}", flush=True)

        if has_errors:
            return True, "Experiment completed with some errors", start_time, actual_end_timestamp
        else:
            return True, None, start_time, actual_end_timestamp

    except Exception as e:
        error_msg = f"Experiment execution failed: {str(e)}"
        print(f"[EXPERIMENT ERROR] {error_msg}", flush=True)
        traceback.print_exc()
        return False, error_msg, None, None

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

def finish_cleanup_and_remove(reservation_id, running_experiment, playbooks_base_dir, experiments_lock, running_experiments, results_base_dir ):
    # cleanup and remove experiment from database
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
        cleanup_playbook_path = os.path.join(str(playbooks_base_dir), "iperf_common", "stop_iperf.yml")

        if os.path.exists(cleanup_playbook_path):
            print(f"[FINISH] Executing cleanup playbook: {cleanup_playbook_path}", flush=True)

            # run playbook on every device
            returncode, stdout, stderr = run_ansible_playbook(
                inventory_path=inventory_path,
                playbook_path=cleanup_playbook_path,
                extra_vars={'save_results': False},
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

    #remove entry from running_experiments if exists
    with experiments_lock:
        if reservation_id in running_experiments:
            print(f"[FINISH] Removing from running_experiments tracking", flush=True)
            del running_experiments[reservation_id]

    is_batch = running_experiment.batch_id is not None

    if is_batch:
        # find and delete all experiments in the batch
        batch_experiments = Experiment.query.filter_by(
            reservation_id=reservation_id,
            batch_id=running_experiment.batch_id
        ).all()
        # collect experiment names before deleting them
        experiment_names = [exp.experiment_name for exp in batch_experiments]
        print(f"[FINISH] Removing batch {running_experiment.batch_id} with {len(batch_experiments)} experiments from database", flush=True)

        with app.app_context():
            cleanup_success_temp, cleanup_error_temp = cleanup_batch_temp_results(
                reservation_id,
                experiment_names,
                results_base_dir
            )
            if not cleanup_success_temp:
                print(f"[FINISH] Warning: Failed to cleanup temp results: {cleanup_error_temp}", flush=True)

        for exp in batch_experiments:
            db.session.delete(exp)

        db.session.commit()

        print(f"[FINISH] Batch finished and removed successfully ({len(batch_experiments)} experiments deleted)", flush=True)

        return jsonify({
            'success': True,
            "message": f"Batch stopped and removed ({len(batch_experiments)} experiments). {cleanup_message}",
            "cleanup_success": cleanup_success,
            "is_batch": True,
            "experiments_deleted": len(batch_experiments)
        }), 200

    else:
        # remove record from database
        print(f"[FINISH] Removing experiment from database", flush=True)
        db.session.delete(running_experiment)
        db.session.commit()

        print(f"[FINISH] Experiment finished and removed successfully", flush=True)

        return jsonify({
            'success': True,
            "message": f"Experiment stopped and removed. {cleanup_message}",
            "cleanup_success": cleanup_success,
            "is_batch": False
        }), 200

def modify_playbook_with_user(playbook_path):

    # modify playbooks added by user adding remote_user
    try:
        print(f"[PLAYBOOK] Processing: {os.path.basename(playbook_path)}", flush=True)
        with open(playbook_path, 'r', encoding='utf-8') as f:
            content = f.read()

        lines = content.split('\n')
        modified = False
        new_lines = []

        i = 0
        while i < len(lines):
            line = lines[i]
            stripped = line.strip()

            if stripped.startswith('- name:'):
                # find start play
                new_lines.append(line)
                i += 1

                while i < len(lines):
                    current_line = lines[i]
                    current_stripped = current_line.strip()

                    # check 'tasks:' (end of play)
                    if current_stripped.startswith('tasks:'):
                        new_lines.append(current_line)
                        i += 1
                        break

                    if current_stripped.startswith('become:'):
                        # change become: yes -> become: no
                        if 'yes' in current_stripped.lower() or 'true' in current_stripped.lower():
                            current_indent = len(current_line) - len(current_line.lstrip())
                            new_lines.append(f"{' ' * current_indent}become: no")
                            modified = True
                            print(f"[PLAYBOOK] Changed become: yes -> become: no", flush=True)
                        else:
                            new_lines.append(current_line)
                    else:
                        new_lines.append(current_line)

                    i += 1

                continue

            new_lines.append(line)
            i += 1

        # rewrite the playbook only if modified
        if modified:
            print(f"[PLAYBOOK] Writing modified playbook to disk...", flush=True)

            with open(playbook_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(new_lines))
            print(f"[PLAYBOOK] Successfully modified", flush=True)
        else:
            print(f"[PLAYBOOK] No modifications needed for {playbook_path}", flush=True)

        return True

    except Exception as e:
        print(f"[ERROR] Failed to modify playbook {playbook_path}: {str(e)}", flush=True)
        traceback.print_exc()
        return False


def validate_and_modify_user_playbooks(playbooks_dir):
    # validate and modify every playbook inside the directory
    try:
        if not os.path.isdir(playbooks_dir):
            return False, f"Directory not found: {playbooks_dir}"

        # find every YAML
        playbook_files = []
        for filename in os.listdir(playbooks_dir):
            if filename.endswith('.yml') or filename.endswith('.yaml'):
                playbook_files.append(os.path.join(playbooks_dir, filename))

        if not playbook_files:
            print(f"[PLAYBOOK] No YAML files found in {playbooks_dir}", flush=True)
            return True, None

        print(f"[PLAYBOOK] Found {len(playbook_files)} playbook(s) to modify", flush=True)

        # modify every playbook
        failed_playbooks = []
        for playbook_path in playbook_files:
            if not modify_playbook_with_user(playbook_path):
                failed_playbooks.append(os.path.basename(playbook_path))

        if failed_playbooks:
            error_msg = f"Failed to modify playbooks: {', '.join(failed_playbooks)}"
            print(f"[ERROR] {error_msg}", flush=True)
            return False, error_msg

        print(f"[PLAYBOOK] Successfully modified all playbooks", flush=True)
        return True, None

    except Exception as e:
        error_msg = f"Error validating/modifying playbooks: {str(e)}"
        print(f"[ERROR] {error_msg}", flush=True)
        traceback.print_exc()
        return False, error_msg
