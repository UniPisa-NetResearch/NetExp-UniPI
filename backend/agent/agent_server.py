import json
import uuid
import time
import os
import io
import zipfile
from flask import request, jsonify, send_file, Response
from concurrent.futures import ThreadPoolExecutor, as_completed
from ..app import app
from ..utils import parse_complete_inventory_hosts
from ..config import PHASES_ORDER, AVAILABLE_MODELS, LLM_MODEL, TROUBLESHOOTER_PHASES_ORDER
from .agents_util.prompts import ROLLBACK_BASE_CMD, TROUBLESHOOTER_PROMPTS
from .agents_util.agent_server_utils import (redis_client, testbed_topology, open_ssh_connections, close_ssh_connections, execute_single_ssh_command, 
                                             run_agent_execution_plan, run_parallel_commands, validate_json_format, handle_chat_logic, generate_troubleshooter_sse)


@app.route("/api/agent_server/chat", methods=["POST"])
def chat():
    message = request.form.get("message", "")
    username = request.form.get("username", "")
    reservation_id = request.form.get("reservation_id", "")
    agent_role = request.form.get("agent_role", "")
    chat_id = request.form.get("chat_id", "")
    is_manual_chat = request.form.get("is_manual_chat", "false").lower() == "true"
    files = request.files.getlist("files")
    llm_model = request.form.get("llm_model", LLM_MODEL)

    if not username or not reservation_id:
        return jsonify({"error": "Missing username or reservation_id"}), 400

    result, status_code = handle_chat_logic(username, reservation_id, chat_id, agent_role, message, llm_model, files, is_manual_chat)
    return jsonify(result), status_code

@app.route("/api/agent_server/advance", methods=["POST"])
def advance_agent():
    data = request.get_json()
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")
    current_role = data.get("current_agent", "")
    next_role = data.get("next_agent", "")
    llm_model = data.get("llm_model", LLM_MODEL)
    execution_mode = data.get("execution_mode", "serial")

    if not all([username, reservation_id, chat_id, current_role, next_role]):
        return jsonify({"error": "Missing parameters"}), 400

    current_key = f"agent_history:{current_role}:{username}:{reservation_id}:{chat_id}"
    next_key = f"agent_history:{next_role}:{username}:{reservation_id}:{chat_id}"

    history_str = redis_client.get(current_key)
    if not history_str:
        return jsonify({"error": "Current session not found"}), 404

    history = json.loads(history_str)
    last_reply = history[-1]["content"]

    is_valid, parsed = validate_json_format(last_reply, current_role)
    if not is_valid:
        return jsonify({"error": "Failed to parse last valid JSON for context extraction"}), 500
    
    # convert json lists in formatted text
    def format_as_string(val):
        if isinstance(val, list):
            return "\n".join([str(item) for item in val])
        return str(val)

    # extract payload from current role
    context_payload = ""

    # retrieve negotiation experiment context if available, it is common for next agents, usefull also in execution when the experiment is not approved
    experiment_context = "No specific experiment context provided."
    exit_conditions = "No specific exit conditions provided."

    if current_role in ["planning", "safety", "execution"]:
        negotiation_key = f"agent_history:negotiation:{username}:{reservation_id}:{chat_id}"
        negotiation_history_str = redis_client.get(negotiation_key)
        
        if negotiation_history_str:
            negotiation_history = json.loads(negotiation_history_str)
            last_negotiation_msg = negotiation_history[-1]["content"]
            is_valid_negotiation, parsed_negotiation = validate_json_format(last_negotiation_msg, "negotiation")
            
            if is_valid_negotiation and parsed_negotiation.get("status") == "APPROVED":
                experiment_context = format_as_string(parsed_negotiation.get("context_for_planning", "No specific experiment context provided."))
                exit_conditions = format_as_string(parsed_negotiation.get("exit_conditions", "No specific exit conditions provided."))

    if current_role == "negotiation":

        raw_context = format_as_string(parsed.get("context_for_planning", ""))
        raw_exit = format_as_string(parsed.get("exit_conditions", ""))
        context_payload = f"<experiment_context>\n{raw_context}\n</experiment_context>\n\n<exit_conditions>\n{raw_exit}\n</exit_conditions>"

    elif current_role == "planning":
        plan = format_as_string(parsed.get("execution_plan", ""))
        verification = format_as_string(parsed.get("verification", []))
        
        context_payload = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<execution_plan>\n{plan}\n</execution_plan>\n\n<verification_commands>\n{verification}\n</verification_commands>\n\n<device_report>\nnull\n</device_report>"
    
    elif current_role == "safety":
        plan = parsed.get("executable_plan", "[]")
        v_plan = parsed.get("verification_plan", [])

        base_dir = os.path.dirname(os.path.abspath(__file__))
        inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))

        def parse_plan(plan):
            if isinstance(plan, str):
                if plan.strip().upper() in ["", "N/A", "NONE", "[]"]:
                    return []
                else:
                    # if the plan is a string, we parse as a list of commands
                    return [line.strip() for line in plan.strip().split('\n') if line.strip()]
            return plan if isinstance(plan, list) else []

        plan = parse_plan(plan)
        v_plan = parse_plan(v_plan)

        if len(plan) > 0 and len(v_plan) > 0:
            
            if execution_mode == "parallel":

                all_devices = set()
                for item in plan + v_plan:
                    if ":" in item:
                        all_devices.add(item.split(":", 1)[0].strip())

                shared_connections = open_ssh_connections(all_devices, inventory_path, reservation_id)

                start_time = time.time()

                try:
                    exec_report = run_parallel_commands(inventory_path, plan, reservation_id, is_intent=False, connections=shared_connections)
                    verif_report = run_parallel_commands(inventory_path, v_plan, reservation_id, is_intent=False, connections=shared_connections)
                finally:
                    close_ssh_connections(shared_connections)

                execution_report = f"--- CONFIGURATION REPORT ---\n{exec_report}\n\n--- VERIFICATION REPORT ---\n{verif_report}"

                elapsed_time = time.time() - start_time
                print(f"\n[DEBUG EXECUTION] --- PARALLEL PLAN EXECUTED IN {elapsed_time:.2f} SECONDS ---")      
            else:
                complete_plan = plan + v_plan

                start_time = time.time()

                execution_report = run_agent_execution_plan(inventory_path, complete_plan, reservation_id)

                elapsed_time = time.time() - start_time
                print(f"\n[DEBUG EXECUTION] --- SERIAL PLAN EXECUTED IN {elapsed_time:.2f} SECONDS ---")      

            context_payload = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<execution_results>\n{execution_report}\n</execution_results>\n"
            
        else:    
            context_payload = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<execution_results>\nNo execution plan was provided. Report that the safety check passed with no commands to execute.\n</execution_results>\n"
            
    elif current_role == "execution" and next_role == "planning":
        # get the report generated by the execution agent
        execution_report = format_as_string(parsed.get("report", ""))

        # retrieve the approved experiment plan from the safety agent
        safety_key = f"agent_history:safety:{username}:{reservation_id}:{chat_id}"
        safety_history_str = redis_client.get(safety_key)
        
        if safety_history_str:
            safety_history = json.loads(safety_history_str)
            # get the last safety message
            last_safety_msg = safety_history[-1]["content"]
            is_parsed_safety_valid, parsed_safety = validate_json_format(last_safety_msg, "safety")

            if is_parsed_safety_valid:
                old_plan = format_as_string(parsed_safety.get("executable_plan", ""))
            else:
                old_plan = "No previous plan found."
        else:
            old_plan = "No previous plan found."

        context_payload = f"Please analyze the errors below and generate a NEW corrected execution plan. You MUST respond in a valid JSON object.\n\n<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<failed_execution_plan>\n{old_plan}\n</failed_execution_plan>\n\n<execution_report>\n{execution_report}\n</execution_report>"
        
    result, status_code = handle_chat_logic(username, reservation_id, chat_id, next_role, context_payload, llm_model, files=None)
    
    if status_code == 200:
        result["context_sent"] = context_payload

    return jsonify(result), status_code
    
@app.route("/api/agent_server/sessions", methods=["GET"])
def get_sessions():
   # return every chat_id for a user and a specific reservation
    username = request.args.get("username", "")
    reservation_id = request.args.get("reservation_id", "")
    agent_role = request.args.get("agent_role", "")
    
    if not username or not reservation_id:
        return jsonify({"error": "Missing parameters"}), 400

    # find all chats relative to thie current reservation
    pattern = f"agent_history:{agent_role}:{username}:{reservation_id}:*"
    keys = redis_client.keys(pattern)

    # extract the last part (the chat_id)
    chat_ids = [key.split(":")[-1] for key in keys]
    
    # order chat_ids in descendent order
    chat_ids.sort(reverse=True)
    
    return jsonify({"chat_ids": chat_ids, "phases_order": PHASES_ORDER, "troubleshooter_phases_order": TROUBLESHOOTER_PHASES_ORDER, "available_models": AVAILABLE_MODELS, "default_model": LLM_MODEL})

@app.route("/api/agent_server/history", methods=["GET"])
def get_history():
    username = request.args.get("username", "")
    reservation_id = request.args.get("reservation_id", "")
    chat_id = request.args.get("chat_id", "")
    agent_role = request.args.get("agent_role", "")

    if not username or not reservation_id or not chat_id:
        return jsonify({"error": "Missing parameters"}), 400

    session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"
    history_str = redis_client.get(session_key)

    if history_str:
        history = json.loads(history_str)
        visible_messages = [msg for msg in history if msg.get("role") not in ["system", "summary"]]
        return jsonify({"messages": visible_messages})
    
    return jsonify({"messages": []})

@app.route("/api/agent_server/history", methods=["DELETE"])
def delete_history():
    # remove all chat history for a specific user and reservation
    data = request.get_json() or {}
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")

    if not username or not reservation_id:
        return jsonify({"error": "Missing parameters"}), 400
    
    if not chat_id:
        pattern = f"agent_history:*:{username}:{reservation_id}:*"
    else:
        pattern = f"agent_history:*:{username}:{reservation_id}:{chat_id}"
        
    keys = redis_client.keys(pattern)
    if keys:
        redis_client.delete(*keys) # remove all keys matching the pattern
    
    return jsonify({"status": "success", "message": f"Deleted {len(keys)} chats"})

@app.route("/api/agent_server/download", methods=["GET"])
def download_chat():
    username = request.args.get("username", "")
    reservation_id = request.args.get("reservation_id", "")
    chat_id = request.args.get("chat_id", "")
    agent_role = request.args.get("agent_role", "")

    if not username or not reservation_id:
        return jsonify({"error": "Missing parameters"}), 400

    memory_file = io.BytesIO()
    has_data = False

    # in memory file ZIP creation
    with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
        # if chat_id is defined, the user wants to download a specific chat
        if chat_id:
            chat_ids = [chat_id]
        else:
            # retrieve every chat_id for user/reservation to download every chat
            pattern = f"agent_history:*:{username}:{reservation_id}:*"
            keys = redis_client.keys(pattern)
            chat_ids = sorted(set(key.split(":")[-1] for key in keys), reverse=True)

        for cid in chat_ids:

            roles_to_download = [agent_role] if agent_role else PHASES_ORDER

            for role in roles_to_download:
                session_key = f"agent_history:{role}:{username}:{reservation_id}:{cid}"
                history_str = redis_client.get(session_key)
                
                if history_str:
                    try:
                        # format JSON in a more readable way
                        history = json.loads(history_str)
                        formatted_json = json.dumps(history, indent=4)
                    except Exception:
                        formatted_json = history_str
                    
                    # group in the same folder every agent chat
                    folder = f"{cid}/" if not chat_id else ""
                    # add json file to ZIP file 
                    zf.writestr(f"{folder} {role}_chat.json", formatted_json)
                    has_data = True

    if not has_data:
        return jsonify({"error": "No chat data found"}), 404

    # pointer to the file start
    memory_file.seek(0)

    if chat_id:
        download_name = f"chat_{chat_id}.zip"  
    elif agent_role:
        download_name = f"all_troubleshooter_chats_{reservation_id}.zip" 
    else:
        download_name = f"all_chats_{reservation_id}.zip"
    
    return send_file(memory_file, mimetype="application/zip", as_attachment=True, download_name=download_name)

@app.route("/api/agent_server/experimentRollback", methods=["POST"])
def rollback_experiment():
    data = request.get_json()
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")

    if not reservation_id or not username or not chat_id:
        return jsonify({"error": "Missing parameters"}), 400

    # verify on redis if there was an execution
    exec_key = f"agent_history:execution:{username}:{reservation_id}:{chat_id}"
    exec_history = redis_client.get(exec_key)
    if not exec_history:
        # if an experiment was never executed, cancel the rollback
        print("No execution history found, rollback is skipped")
        return jsonify({"status": "SKIPPED", "message": "No execution phase found, skip rollback."}), 200

    base_dir = os.path.dirname(os.path.abspath(__file__))
    inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
    snapshot_dir = os.path.abspath(os.path.join(base_dir, "..", "controller", "snapshots", f"res_{reservation_id}_snapshots", "snapshot0"))

    # read inventory
    try:
        devices = parse_complete_inventory_hosts(inventory_path)
    except Exception as e:
        return jsonify({"error": f"Error reading inventory: {str(e)}"}), 500

    connections = open_ssh_connections(devices.keys(), inventory_path, reservation_id, hosts=devices)

    def execute_rollback_for_device(device, info):
        # format base string from agents_util
        cmd_str = ROLLBACK_BASE_CMD.format(iface=info['iface'])

        # reload FRR node of type host ignored
        if info['role'] != "host":
            frr_file_path = os.path.join(snapshot_dir, f"{device}_frr.conf")
            try:
                with open(frr_file_path, 'r') as frr_file:
                    frr_content = frr_file.read()
                # escaping of ' for bash
                safe_content = frr_content.replace("'", "'\\''")
                # write the content to /etc/frr/frr.conf and restart FRR service, redirecting output to a temorary log file, remove the file after reading it
                cmd_str += (f"printf '%s\\n' '{safe_content}' > /etc/frr/frr.conf; " "service frr restart > /tmp/frr_restart.log 2>&1; " "cat /tmp/frr_restart.log; rm -f /tmp/frr_restart.log; true;")
            except FileNotFoundError:
                cmd_str += ("> /etc/frr/frr.conf; " "(service frr restart > /tmp/frr_restart.log 2>&1 || systemctl restart frr > /tmp/frr_restart.log 2>&1); " "cat /tmp/frr_restart.log; rm -f /tmp/frr_restart.log; true;")

        entry = connections.get(device)
        if not entry:
            return f"{device}: [ERROR] No SSH connection available for rollback\n"
        client, conn_info = entry

        return execute_single_ssh_command(device, cmd_str, client, conn_info, timeout=60)

    try:
        # parallel execution with Worker
        report_lines = []
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(execute_rollback_for_device, dev, info) for dev, info in devices.items()]
            for future in as_completed(futures):
                report_lines.append(future.result())
    finally:
        close_ssh_connections(connections)

    return jsonify({"status": "SUCCESS", "report": "\n".join(report_lines)}), 200

@app.route("/api/agent_server/troubleshooter/chat", methods=["POST"])
def troubleshooter_chat():

    print("\n" + "="*50)

    request_data = {
        'username': request.form.get("username", ""),
        'reservation_id': request.form.get("reservation_id", ""),
        'chat_id': request.form.get("chat_id", ""),
        'message': request.form.get("message", ""),
        'llm_model': request.form.get("llm_model", LLM_MODEL),
        'current_phase': request.form.get("current_phase", "diagnostic_intent"),
        'context': request.form.get("context", ""),
        'execution_report': request.form.get("execution_report", ""),
        'safe_commands': json.loads(request.form.get("safe_commands", "[]") or "[]"),
        'approved_commands': json.loads(request.form.get("approved_commands", "[]") or "[]")
    }

    print(f"[DEBUG SSE] Request phase: {request_data['current_phase']} | User: {request_data['username']} | Reservation: {request_data['reservation_id']}")
    
    if not request_data['chat_id']:
        request_data['chat_id'] = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    # retrieve chat history if present
    request_data['session_key'] = f"agent_history:troubleshooter_chat:{request_data['username']}:{request_data['reservation_id']}:{request_data['chat_id']}"
    history_str = redis_client.get(request_data['session_key'])
    
    if history_str:
        # load history if present
        history = json.loads(history_str)
    else:
        # add system promtp to the history
        system_prompt = TROUBLESHOOTER_PROMPTS["diagnostic_intent"]
        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"
        history = [{"role": "system", "content": system_prompt}]

    sse_stream = generate_troubleshooter_sse(history=history, request_data=request_data)
    
    print("[DEBUG SSE] Return Flask response to the Client...")
    return Response(sse_stream, mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5006, use_reloader=False)