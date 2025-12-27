import os

from flask import request, send_file, jsonify
from pathlib import Path
import yaml
from datetime import datetime
from werkzeug.utils import secure_filename
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
                    # device name is the first part before the space
                    device_name = line.split()[0] if line else None
                    if device_name:
                        devices.append(device_name)

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

if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=False, host='0.0.0.0', port=5004, use_reloader=False)