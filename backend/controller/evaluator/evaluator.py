import os
import json
import traceback
import zipfile
from io import BytesIO
import paramiko
from stat import S_ISDIR, S_ISREG
from flask import request, send_file, jsonify
from ...database.db import Experiment
from ..experimenter.experimenter import EXPERIMENT_RESULTS_DIR
from ...controller.controller import NAS_IP, MINIPC_USER, MINIPC_PASS, INVENTORY_DIR, safe_filename
from ...app import app

NAS_EXPORT_BASE = "/export"

@app.route('/api/evaluator/getExperimentResults', methods=['POST'])
def get_experiment_results():
    # return results of the last completed experiment
    try:
        data = request.json
        reservation_id = data.get('reservation_id')
        specific_experiment_name = data.get('experiment_name')

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        # find last completed experiment
        completed_experiment = Experiment.query.filter_by(
            reservation_id=reservation_id,
            status='completed'
        ).order_by(Experiment.end_time.desc()).first()

        if not completed_experiment:
            return jsonify({'success': False, 'error': 'No completed experiment found'}), 404

        is_batch = completed_experiment.batch_id is not None
        batch_experiments = []

        if is_batch:
            # find each experiment of the batch
            batch_exps = Experiment.query.filter_by(
                reservation_id=reservation_id,
                batch_id=completed_experiment.batch_id
            ).order_by(Experiment.start_time).all()

            batch_experiments = [exp.experiment_name for exp in batch_exps]

            print(f"[GET RESULTS] Found batch {completed_experiment.batch_id} with {len(batch_experiments)} experiments", flush=True)

            if specific_experiment_name:
                if specific_experiment_name not in batch_experiments:
                    return jsonify({'success': False, 'error': f'Experiment {specific_experiment_name} not in batch'}), 404
                experiment_name = specific_experiment_name
                experiment = Experiment.query.filter_by(
                    reservation_id=reservation_id,
                    experiment_name=experiment_name,
                    batch_id=completed_experiment.batch_id
                ).first()
            else:
                experiment = batch_exps[0]
                experiment_name = experiment.experiment_name
        else:
            experiment = completed_experiment
            experiment_name = experiment.experiment_name

        results_dir = os.path.join(EXPERIMENT_RESULTS_DIR, f"res_{reservation_id}", experiment_name)

        # read telemetry files
        telemetry_file = os.path.join(str(results_dir), f"{experiment_name}_telemetry_results.json")
        execution_log_file = os.path.join(str(results_dir), f"{experiment_name}_execution_log.json")

        telemetry_results = None
        execution_log = None

        if os.path.exists(telemetry_file):
            with open(telemetry_file, 'r') as f:
                telemetry_results = json.load(f)

        if os.path.exists(execution_log_file):
            with open(execution_log_file, 'r') as f:
                execution_log = json.load(f)

        # read iperf3 results
        iperf_results = {}
        for filename in os.listdir(str(results_dir)):
            if filename.startswith('iperf_') and filename.endswith('.txt'):
                filepath = os.path.join(str(results_dir), filename)
                try:
                    with open(filepath, 'r') as f:
                        text_content = f.read()
                        if text_content:  # check if file is not empty
                            # use filename without extension as key
                            flow_name = os.path.splitext(filename)[0]

                            iperf_results[flow_name] = {
                                'text': text_content
                            }
                except Exception as e:
                    print(f"[ERROR] Error reading {filename}: {str(e)}", flush=True)

        return jsonify({
            'success': True,
            'experiment_name': experiment_name,
            'experiment_id': experiment.id,
            'start_time': experiment.start_time.isoformat(),
            'end_time': experiment.end_time.isoformat(),
            'duration_s': experiment.duration_s,
            'status': experiment.status,
            'telemetry_results': telemetry_results,
            'execution_log': execution_log,
            'iperf_results': iperf_results,
            'is_batch': is_batch,
            'batch_id': completed_experiment.batch_id if is_batch else None,
            'batch_experiments': batch_experiments if is_batch else []
        }), 200

    except Exception as e:
        print(f"Error in getExperimentResults: {str(e)}")
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': f'Server error: {str(e)}'
        }), 500

@app.route('/api/evaluator/downloadResults', methods=['POST'])
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
            for root, dirs, files in os.walk(str(results_dir)):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, str(results_dir))
                    zf.write(file_path, str(arcname))

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


@app.route('/api/evaluator/downloadNFSData', methods=['POST'])
def download_nfs_data():
    # download all NFS mounted directories data for the experiment
    try:

        data = request.json
        reservation_id = data.get('reservation_id')
        selected_devices = data.get('selected_devices', [])

        if not reservation_id:
            return jsonify({'success': False, 'error': 'Missing reservation_id'}), 400

        if not selected_devices or not isinstance(selected_devices, list):
            return jsonify({'success': False, 'error': 'No devices selected'}), 400

        # parse inventory to extract device asset_tags
        device_tags = selected_devices

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        try:
            print(f"[NFS DOWNLOAD] Connecting to NAS {NAS_IP}...", flush=True)
            ssh.connect(
                hostname=NAS_IP,
                username=MINIPC_USER,
                password=MINIPC_PASS,
                timeout=10,
                allow_agent=False,
                look_for_keys=False
            )
            print(f"[NFS DOWNLOAD] Connected to NAS", flush=True)

            # create SFTP client
            sftp = ssh.open_sftp()

            # create in-memory ZIP file
            memory_file = BytesIO()
            files_added = 0

            with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
                # download NFS data for each device
                for device_tag in device_tags:
                    nfs_device_path = f"{NAS_EXPORT_BASE}/{device_tag}"

                    print(f"[NFS DOWNLOAD] Processing device: {device_tag}", flush=True)

                    try:
                        # check if directory exists
                        try:
                            sftp.stat(nfs_device_path)
                            print(f"[NFS DOWNLOAD] Found directory: {nfs_device_path}", flush=True)
                        except FileNotFoundError:
                            print(f"[NFS DOWNLOAD] Directory not found: {nfs_device_path}", flush=True)
                            zf.writestr(f"{device_tag}/NO_DATA.txt",f"Directory not found on NAS: {nfs_device_path}")
                            continue

                        # recursively download all files from device directory
                        def download_recursive(remote_path, zip_base_path=""):
                            nonlocal files_added

                            try:
                                items = sftp.listdir_attr(remote_path)

                                for item in items:
                                    remote_item_path = f"{remote_path}/{item.filename}"
                                    zip_item_path = f"{zip_base_path}/{item.filename}" if zip_base_path else item.filename

                                    if S_ISDIR(item.st_mode):
                                        # recursively download directory
                                        print(f"[NFS DOWNLOAD]   Entering directory: {remote_item_path}", flush=True)
                                        download_recursive(remote_item_path, zip_item_path)
                                    elif S_ISREG(item.st_mode):
                                        # download file
                                        print(
                                            f"[NFS DOWNLOAD]   Downloading: {remote_item_path} ({item.st_size} bytes)", flush=True)

                                        # download file to memory
                                        file_buffer = BytesIO()
                                        sftp.getfo(remote_item_path, file_buffer)
                                        file_buffer.seek(0)

                                        # add to ZIP
                                        zf.writestr(zip_item_path, file_buffer.read())
                                        files_added += 1

                                        print(f"[NFS DOWNLOAD]   Added: {zip_item_path}", flush=True)

                            except Exception as e:
                                print(f"[NFS DOWNLOAD ERROR] Failed to process {remote_path}: {str(e)}", flush=True)

                        # start recursive download from device root
                        download_recursive(nfs_device_path, device_tag)

                        print(f"[NFS DOWNLOAD] Completed {device_tag} ({files_added} files total so far)", flush=True)

                    except Exception as e:
                        print(f"[NFS DOWNLOAD ERROR] {device_tag}: {str(e)}", flush=True)
                        traceback.print_exc()
                        zf.writestr(f"{device_tag}/ERROR.txt",f"Error downloading {device_tag}: {str(e)}")

            sftp.close()

        except Exception as e:
            print(f"[NFS DOWNLOAD ERROR] SSH/SFTP error: {str(e)}", flush=True)
            traceback.print_exc()
            return jsonify({'success': False, 'error': f'SSH connection failed: {str(e)}'}), 500

        finally:
            ssh.close()

        memory_file.seek(0)

        download_filename = f'nfs_data_res_{reservation_id}.zip'

        print(f"[NFS DOWNLOAD] Archive ready: {download_filename} ({files_added} files)", flush=True)

        if files_added == 0:
            print(f"[NFS DOWNLOAD WARNING] No files were added to archive!", flush=True)

        return send_file(
            memory_file,
            mimetype='application/zip',
            as_attachment=True,
            download_name=download_filename
        )

    except Exception as e:
        print(f"Error in downloadNFSData: {str(e)}", flush=True)
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5005, use_reloader=False)