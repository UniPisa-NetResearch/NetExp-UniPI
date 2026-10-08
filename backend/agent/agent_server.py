import json
import uuid
import time
import threading
import os
import io
import zipfile
from flask import request, jsonify, send_file, Response
from concurrent.futures import ThreadPoolExecutor, as_completed
from ..app import app
from ..utils import parse_complete_inventory_hosts, get_remaining_minutes, get_is_virtual_from_db
from ..config import PHASES_ORDER, AVAILABLE_MODELS, LLM_MODEL, DIAGNOSTIC_ASSISTANT_PHASES_ORDER, SAFETY_ITERATIONS, AGENT_NAMES, FRONTEND_LLM_PREVENTION_MINUTES, BACKEND_LLM_PREVENTION_MINUTES, SAFETY_SUBAGENT_ROLES
from .agents_util.prompts import ROLLBACK_BASE_CMD
from .agents_util.agent_server_workers import run_experiment_pipeline_worker, run_diagnostic_pipeline_worker, run_interactive_pipeline_worker
from .agents_util.agent_server_utils import (redis_client, open_ssh_connections, close_ssh_connections, 
                                             execute_single_ssh_command, redis_stream_generator, delete_agent_history_keys)

# endpoint called when the user answer agent questions or sends a prompt to the LLM for the execution pipeline
@app.route("/api/agent_server/experiment/stream", methods=["POST"])
def experiment_stream():
    
    username = request.form.get("username", "")
    reservation_id = request.form.get("reservation_id", "")
    chat_id = request.form.get("chat_id", "")
    current_role = request.form.get("current_phase", "")
    message = request.form.get("message", "")
    llm_model = request.form.get("llm_model", LLM_MODEL)
    execution_mode = request.form.get("execution_mode", "serial")
    context_payload = request.form.get("context", "")
    files = request.files.getlist("files")
    is_manual_chat = request.form.get("is_manual_chat", "false").lower() == "true"

    if not all([username, reservation_id, current_role]):
        return jsonify({"error": "Missing parameters"}), 400

    # check if there is enough time to process the request on the backend or the reservation is about to expire
    minutes_left = get_remaining_minutes(reservation_id)
    if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
        def abort_gen():
            error_msg = f"Operation blocked: Less than {BACKEND_LLM_PREVENTION_MINUTES} minutes remaining before reservation ends"
            print(error_msg)
            yield f"data: {json.dumps({'type': 'result', 'data': {'error': error_msg}})}\n\n"
        # return the error immediately using SSE
        return Response(abort_gen(), mimetype="text/event-stream")

    # generate chat_id before starting thread if it's a new chat
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    # prepare request data to pass to the background worker
    request_data = {
        'username': username,
        'reservation_id': reservation_id,
        'chat_id': chat_id,
        'current_phase': current_role,
        'message': message,
        'llm_model': llm_model,
        'execution_mode': execution_mode,
        'is_manual_chat': is_manual_chat,
        'context': context_payload
    }
        
    # spawn background worker to process the request by executing the experiment pipeline and return the result asynchronously using SSE
    worker_args = (request_data, files)
    thread = threading.Thread(target=run_experiment_pipeline_worker, args=worker_args)
    thread.start()

    # redis subscription to channel for reading messages published by the workers       
    return Response(redis_stream_generator(chat_id), mimetype="text/event-stream")

# endpoint called during LLM agents pages (execution and diagnostic), to retrieve the list of chat sessions, available models, phases order, agent names, safety subagents, safety iterations and prevention minutes to lock LLM call when a reservation is aboutto expire    
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
    
    return jsonify({"chat_ids": chat_ids, "phases_order": PHASES_ORDER, "diagnostic_assistant_phases_order": DIAGNOSTIC_ASSISTANT_PHASES_ORDER, "available_models": AVAILABLE_MODELS, "default_model": LLM_MODEL, "safety_iterations": SAFETY_ITERATIONS, "agent_names": AGENT_NAMES, "frontend_llm_prevention_minutes": FRONTEND_LLM_PREVENTION_MINUTES, "safety_subagents": SAFETY_SUBAGENT_ROLES})

# endpoint called when user wants to retrieve the chat history of a chat session and a specific agent role, or all agents roles if the frontend sends a special value (all_llm_agents). Returns a list of messages ordered by timestamp, excluding system and summary messages
@app.route("/api/agent_server/history", methods=["GET"])
def get_history():
    username = request.args.get("username", "")
    reservation_id = request.args.get("reservation_id", "")
    chat_id = request.args.get("chat_id", "")
    agent_roles_str = request.args.get("agent_role", "")

    if not username or not reservation_id or not chat_id or not agent_roles_str:
        return jsonify({"error": "Missing parameters"}), 400

    # frontend sends a special value if needs all agents
    if agent_roles_str == "all_llm_agents":
        agent_roles = PHASES_ORDER
    else:
        # frontend sends list of agents separated with comma if needs a partial list of agents
        agent_roles = [r.strip() for r in agent_roles_str.split(",") if r.strip()]

    # combine messages of different agents in the same list
    combined_messages = []

    for agent_role in agent_roles:
        session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"
        history_str = redis_client.get(session_key)

        if history_str:
            history = json.loads(history_str)
            # exclude system and summary messages, the user is not interested in seeing them
            visible_messages = [msg for msg in history if msg.get("role") not in ["system", "summary"]]
            # add agent_phase field to each message
            for msg in visible_messages:
                msg["agent_phase"] = agent_role

            combined_messages.extend(visible_messages)

    # order messages by timestamp ascendent
    combined_messages.sort(key=lambda x: x.get("timestamp", 0))

    return jsonify({"messages": combined_messages})

# endpoint called when the user wants to terminate an exeriment after the rejection in the execution phase    
@app.route("/api/agent_server/terminate", methods=["POST"])
def terminate_experiment():
    # save permanently TERMINATED status for execution messages on redis
    data = request.get_json() or {}
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")

    if not all([username, reservation_id, chat_id]):
        return jsonify({"error": "Missing parameters"}), 400
    
    session_key = f"agent_history:execution:{username}:{reservation_id}:{chat_id}"
    history_str = redis_client.get(session_key)
    
    if history_str:
        history = json.loads(history_str)
        # add termination message to execution history
        history.append({
            "role": "assistant", 
            "content": '{"status": "TERMINATED", "report": "The experiment was manually terminated after an execution failure."}',
            "timestamp": time.time()
        })
        redis_client.set(session_key, json.dumps(history), ex=432000)

    # delete safety temporary context for the previous turn
    delete_agent_history_keys(username=username, reservation_id=reservation_id, chat_id=chat_id, role_prefix="safety_turn_state")
        
    return jsonify({"status": "success"}), 200

# endpoint called when the user wants to delete a specific chat of the current reservation
@app.route("/api/agent_server/history", methods=["DELETE"])
def delete_history():
    # remove all chat history for a specific user and reservation
    data = request.get_json() or {}
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")

    if not username or not reservation_id:
        return jsonify({"error": "Missing parameters"}), 400
    
    # delete the chat with the specified chat_id
    deleted = delete_agent_history_keys(username, reservation_id, chat_id)
    
    return jsonify({"status": "success", "message": f"Deleted {deleted} chats"})

# endpoint called when a user wants to download the chat history of a specific chat or all chats of a current reservation
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
            # ordering chat ids in descendent order
            chat_ids = sorted(set(key.split(":")[-1] for key in keys), reverse=True)

        for cid in chat_ids:

            roles_to_download = [agent_role] if agent_role else PHASES_ORDER

            for role in roles_to_download:
                # retrieve chat sessions for every role and add them to the zip file
                session_key = f"agent_history:{role}:{username}:{reservation_id}:{cid}"
                history_str = redis_client.get(session_key)
                
                if history_str:
                    try:
                        # format JSON in a more readable way
                        history = json.loads(history_str)
                        formatted_json = json.dumps(history, indent=4)
                    except Exception:
                        formatted_json = history_str
                    
                    # group in the same folder every agent chat, if chat_id is not null save files directly in the root of teh zip folder (only a single chat is requested), otherwise create a folder for each chat_id, every chat is requested
                    folder = f"{cid}/" if not chat_id else ""
                    # create file name adding _chat only if not present
                    file_name = f"{role}.json" if role.endswith("_chat") else f"{role}_chat.json"
                    
                    # add json file to ZIP file 
                    zf.writestr(f"{folder}{file_name}", formatted_json)
                    has_data = True

    if not has_data:
        return jsonify({"error": "No chat data found"}), 404

    # pointer to the file start
    memory_file.seek(0)

    # if a chat_id is specified, the name of the files includes the id
    if chat_id:
        download_name = f"chat_{chat_id}.zip"
    # if an agent role is specified, is the case of diagnostic assistant  
    elif agent_role:
        download_name = f"all_diagnostic_assistant_chats_{reservation_id}.zip"
    # every chat of the current pipeline     
    else:
        download_name = f"all_chats_{reservation_id}.zip"
    
    return send_file(memory_file, mimetype="application/zip", as_attachment=True, download_name=download_name)

# endpoint called when the user wants to rollback the experiment to initial state
@app.route("/api/agent_server/experimentRollback", methods=["POST"])
def rollback_experiment():
    data = request.get_json()
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    
    if not reservation_id or not username:
        return jsonify({"error": "Missing parameters"}), 400

    base_dir = os.path.dirname(os.path.abspath(__file__))
    # get inventory and snapshot0 paths
    inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
    snapshot_dir = os.path.abspath(os.path.join(base_dir, "..", "controller", "snapshots", f"res_{reservation_id}_snapshots", "snapshot0"))

    # read inventory to get devices
    try:
        devices = parse_complete_inventory_hosts(inventory_path)
    except Exception as e:
        return jsonify({"error": f"Error reading inventory: {str(e)}"}), 500

    # open apool of connections for every device
    connections = open_ssh_connections(devices.keys(), inventory_path, reservation_id, hosts=devices)

    # check if the reservation is virtual or not, the frr. conf file path is different for the two testbeds
    is_virtual = get_is_virtual_from_db(reservation_id)

    if is_virtual:
        destination_frr_file_path = "/etc/frr/frr.conf"
    else:
        destination_frr_file_path = "/etc/sonic/frr/frr.conf"

    # execute the rollback in parallel for every device
    def execute_rollback_for_device(device, info):
        # format base string from list of available commands in agents_util
        cmd_str = ROLLBACK_BASE_CMD.format(iface=info['iface'])

        # reload FRR node of type host ignored
        if info['role'] != "host":
            # get the frr.conf file from the snapshot0 folder
            frr_file_path = os.path.join(snapshot_dir, f"{device}_frr.conf")
            try:
                with open(frr_file_path, 'r') as frr_file:
                    frr_content = frr_file.read()
                # escaping of ' for bash
                safe_content = frr_content.replace("'", "'\\''")
                # write the content of the frr.conf file in the snapshot to frr.conf and restart FRR service, redirecting output to a temorary log file, remove the file after reading it
                cmd_str += (f"printf '%s\\n' '{safe_content}' > '{destination_frr_file_path}'; " "service frr restart > /tmp/frr_restart.log 2>&1; " "cat /tmp/frr_restart.log; rm -f /tmp/frr_restart.log; true;")
            except FileNotFoundError:
                cmd_str += (f"> '{destination_frr_file_path}'; " "(service frr restart > /tmp/frr_restart.log 2>&1 || systemctl restart frr > /tmp/frr_restart.log 2>&1); " "cat /tmp/frr_restart.log; rm -f /tmp/frr_restart.log; true;")

        # get the SSH connection for the devic
        entry = connections.get(device)
        if not entry:
            return f"{device}: [ERROR] No SSH connection available for rollback\n"
        client, conn_info = entry
        # execute commands in sequence for the single device
        return execute_single_ssh_command(device, cmd_str, client, conn_info, timeout=60)

    try:
        # parallel execution of rollback in different devices with Worker
        report_lines = []
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(execute_rollback_for_device, dev, info) for dev, info in devices.items()]
            for future in as_completed(futures):
                # create output report of the rollback execution
                report_lines.append(future.result())
    finally:
        # close every connection at the end
        close_ssh_connections(connections)

    return jsonify({"status": "SUCCESS", "report": "\n".join(report_lines)}), 200

# endpoint called when the user answer agent questions or sends a prompt to the LLM for the diagnostic pipeline
@app.route("/api/agent_server/diagnosticAssistant/chat", methods=["POST"])
def diagnostic_assistant_chat():

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

    # check if there is enough time to process the request on the backend or the reservation is about to expire
    minutes_left = get_remaining_minutes(request_data['reservation_id'])
    if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
        def abort_gen():
            error_msg = f"Operation blocked: Less than {BACKEND_LLM_PREVENTION_MINUTES} minutes remaining before reservation ends"
            print(error_msg)
            yield f"data: {json.dumps({'type': 'result', 'data': {'error': error_msg}})}\n\n"
        return Response(abort_gen(), mimetype="text/event-stream")
    
    if not request_data['chat_id']:
        request_data['chat_id'] = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    # create background worker to process the request by executing the diagnostic pipeline and return the result asynchronously using SSE
    thread = threading.Thread(target=run_diagnostic_pipeline_worker, args=[request_data])
    thread.start()

    print("[DEBUG SSE] Return Flask response to the Client...")
  
    # subscribe to redis channel for reading messages published by the workers 
    return Response(redis_stream_generator(request_data['chat_id']), mimetype="text/event-stream")

@app.route("/api/agent_server/interactiveAssistant/chat", methods=["POST"])
def interactive_assistant_chat():
    request_data = {
        'username': request.form.get("username", ""),
        'reservation_id': request.form.get("reservation_id", ""),
        'chat_id': request.form.get("chat_id", ""),
        'message': request.form.get("message", ""),
        'llm_model': request.form.get("llm_model", LLM_MODEL),
        'current_phase': request.form.get("current_phase", "interactive_negotiator")
    }

    minutes_left = get_remaining_minutes(request_data['reservation_id'])
    if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
        def abort_gen():
            error_msg = f"Operation blocked: Less than {BACKEND_LLM_PREVENTION_MINUTES} minutes remaining before reservation ends"
            yield f"data: {json.dumps({'type': 'result', 'data': {'error': error_msg}})}\n\n"
        return Response(abort_gen(), mimetype="text/event-stream")
    
    if not request_data['chat_id']:
        request_data['chat_id'] = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    thread = threading.Thread(target=run_interactive_pipeline_worker, args=[request_data])
    thread.start()

    return Response(redis_stream_generator(request_data['chat_id']), mimetype="text/event-stream")

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5006, use_reloader=False)