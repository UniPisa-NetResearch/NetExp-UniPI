import json
import redis
import uuid
import time
import os
import subprocess
import yaml
from flask import request, jsonify
from ..app import app
from .llm_client import chat_with_llm
from ..utils import get_is_virtual_from_db
from ..config import REDIS_HOST, REDIS_PORT, REDIS_DB, SAFETY_ITERATIONS, PHASES_ORDER, JSON_RETRIES, MAX_EXECUTION_ITERATIONS, LOCAL_TEST, CONTAINERLAB_HOST, CONTAINERLAB_HOST_USER
from .agents_util.prompts import AGENT_PROMPTS, DEVICE_KIND_RULES, FORBIDDEN_RULES

# redis store for conversation history, keyed by username and reservation_id
redis_client = redis.Redis(
    host=REDIS_HOST, 
    port=REDIS_PORT, 
    db=REDIS_DB, 
    decode_responses=True   # automatically decodes bytes in strings
)

topology_file_path = os.path.join(os.path.dirname(__file__), "agents_util", "topology_plain.yaml")
try:
    with open(topology_file_path, "r") as topo_file:
        testbed_topology = topo_file.read()
except FileNotFoundError:
    testbed_topology = "# Topology file not found"
    print(f"Warning: Could not find {topology_file_path}")

def get_dynamic_device_rules(agent_role: str) -> str:
    # extracts device kinds dfrom the topologia and retrieve rules for the current agent
    
    kinds_in_topo = set()
    try:
        # topology parsing
        topo_dict = yaml.safe_load(testbed_topology) or {}
        nodes = topo_dict.get("topology", {}).get("nodes", {})
        
        # extract unique nodes
        for node_info in nodes.values():
            if isinstance(node_info, dict) and "kind" in node_info:
                kinds_in_topo.add(node_info["kind"])
    except yaml.YAMLError as e:
        print(f"Error parsing yaml topology: {e}")
        return ""

    dynamic_rules = ""
    
    for kind_tuple, agent_rules in DEVICE_KIND_RULES.items():
        # find all kinds of the current tuple
        present_kinds = [k for k in kind_tuple if k in kinds_in_topo]
        
        # if there is at least one kind and there is a rule for the current role
        if present_kinds and agent_role in agent_rules:
            # unifies kinds in a string (ex. "linux, host" or "sonic-vs")
            kinds_str = ", ".join(present_kinds)
            dynamic_rules += f"--- RULES FOR KIND(S): {kinds_str} ---\n"
            dynamic_rules += agent_rules[agent_role] + "\n\n"
            
    return dynamic_rules.strip()

def run_agent_execution_plan(inventory_path: str, execution_plan: list, reservation_id):
    
    if LOCAL_TEST:
        base_cmd = ["wsl","ansible"]
    else:
        base_cmd = ["ansible"]
    
    report_lines = []
    extra_vars = {}

    # if virtual deployment, we add proxy command to ansible ssh connection
    is_virtual = get_is_virtual_from_db(reservation_id)

    if is_virtual:
        proxy_cmd = f"-o StrictHostKeyChecking=no -o ProxyCommand=\"ssh -W %h:%p -o StrictHostKeyChecking=no {CONTAINERLAB_HOST_USER}@{CONTAINERLAB_HOST}\""
        extra_vars['ansible_ssh_common_args'] = proxy_cmd

    for step in execution_plan:
        if ":" not in step:
            continue
            
        device, command = step.split(":", 1)
        device = device.strip()
        command = command.strip()

        # create ansible command to execute the command on the device using the provided inventory
        cmd = base_cmd + [device, "-i", inventory_path, "-m", "shell", "-a", command]
        
        # add extra vars if present
        if extra_vars:
            cmd += ["--extra-vars", json.dumps(extra_vars)]

        try:
            # execution with 1 minute timeout
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            
            raw_out = proc.stdout.strip()
            error_out = proc.stderr.strip()

            print(f"[DEBUG] Device: {device} | Command: {command}")
            print(f"[DEBUG] Return code: {proc.returncode}")
            print(f"[DEBUG] STDOUT:\n{raw_out}")

            if error_out:
                print(f"[DEBUG] STDERR:\n{error_out}")
            print("-" * 60)

            # check if the command was executed successfully based on ansible output or return code
            is_ansible_success = "CHANGED" in raw_out or "SUCCESS" in raw_out or proc.returncode == 0
            
            # ansible output cleaning
            if ">>" in raw_out:
                clean_out = raw_out.split(">>", 1)[1].strip()
            else:
                clean_out = raw_out
            
            # remove standard ansible string in case of non-zero return code
            clean_out = clean_out.replace("non-zero return code", "").strip()

            final_message = ""

            if is_ansible_success:
                # always caprure errors and warnings, even if the command was successful
                if error_out:
                    final_message = f"[WARNING: Ansible reported CHANGED/SUCCESS but generated stderr]:\n{error_out}"
                    
                    if clean_out:
                        final_message = f"[SUCCESS]:\n{clean_out}"
                
                else:
                    if not clean_out:
                        # Ansible reported CHANGED without any output, so the command has been executed succesfully
                        final_message = "[SUCCESS: Command applied successfully (Ansible reported CHANGED)]"
                    else:
                        final_message = f"[SUCCESS]:\n{clean_out}"

            else:
                final_message = f"[FAILED: Return code {proc.returncode}]"

                if "UNREACHABLE" in raw_out:
                    final_message = "[FAILED: Device UNREACHABLE (SSH/Network issue)]"
                elif "FAILED" in raw_out:
                    final_message = f"[FAILED: Ansible reported rc={proc.returncode}]"

                if error_out:
                    final_message += f"\n[STDERR]:\n{error_out}"
                if clean_out:
                    final_message += f"\n[STDOUT]:\n{clean_out}"
                
                if not error_out and not clean_out:
                    final_message += "\n[No output or error message returned]"
                    
                
            report_lines.append(f"{device}: {command} |\n{final_message}\n")

        except subprocess.TimeoutExpired:
            report_lines.append(f"{device}: {command} |\n[EXECUTION ERROR: Timeout expired (60s)]\n")
        except Exception as e:
            report_lines.append(f"{device}: {command} |\n[SYSTEM ERROR]: {str(e)}\n")

    return "\n-------------------------\n".join(report_lines)

def validate_json_format(reply_text, agent_role):
    # verify the agent's output is a valid json
    try:
        data = json.loads(reply_text)
        if agent_role == "negotiation" and not all(k in data for k in ["summary", "topology_diagram", "clarifying_questions", "status", "context_for_planning"]):
            return False, "Missing keys. Required: summary, topology_diagram, clarifying_questions, status, context_for_planning"
        
        if agent_role == "planning":
            if not all(k in data for k in ["execution_plan", "verification", "status"]):
                return False, "Missing keys. Required: execution_plan, verification, status"
            
            if not isinstance(data.get("execution_plan"), list):
                return False, "execution_plan must be a JSON array"
            
            if not isinstance(data.get("verification"), list):
                return False, "verification must be a JSON array"
              
        if agent_role == "safety":
            if not all(k in data for k in ["status", "issues", "topology_mapping_check", "executable_plan", "clarifying_questions"]):
                return False, "Missing keys. Required: status, issues, topology_mapping_check, executable_plan, clarifying_questions"
            
            if not isinstance(data.get("issues"), list):
                return False, "issues must be a JSON array"
            
            if not isinstance(data.get("topology_mapping_check"), list):
                return False, "topology_mapping_check must be a JSON array"
            
            if not isinstance(data.get("executable_plan"), list):
                return False, "executable_plan must be a JSON array"
            
            if not isinstance(data.get("clarifying_questions"), list):
                return False, "clarifying_questions must be a JSON array"
            
        if agent_role == "execution":
            if not all(k in data for k in ["status", "report"]):
                return False, "Missing keys. Required: status, report"
            
        return True, data
    
    except json.JSONDecodeError:
        return False, "The output is not a valid JSON object."
    
def get_validated_llm_reply(history, agent_role):
    for _ in range(JSON_RETRIES):
        reply_text = chat_with_llm(history)

        is_valid, validation_result = validate_json_format(reply_text, agent_role)
        if is_valid:
            return True, reply_text, validation_result

        history.append({"role": "assistant", "content": reply_text})
        correction_prompt = f"Your previous response failed validation: {validation_result}. Please generate a new complete response in valid JSON following the mandatory structure."
        
        history.append({"role": "user", "content": correction_prompt})

    return False, None, None
    
def handle_chat_logic(username, reservation_id, chat_id, agent_role, message, files=None):
    # if there is no chat_id, it means the user is starting a new chat. We generate one.
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"          # added timestamp to guarantee chronological order

    session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"

    # retrieve history from Redis
    history_str = redis_client.get(session_key)
    if history_str:
        history = json.loads(history_str)
    else:

        system_prompt = AGENT_PROMPTS.get(agent_role)

        dynamic_rules = get_dynamic_device_rules(agent_role)
        if dynamic_rules:
            system_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```</topology>\n"

        if agent_role == "safety":
            rules_formatted = "\n".join([f"- {rule}" for rule in FORBIDDEN_RULES])
            system_prompt += f"\n\n<forbidden_rules>\n{rules_formatted}\n</forbidden_rules>\n"
        
        # initialize history if it doesn't exist
        history = [{"role": "system", "content": system_prompt}]

    # add user message and file info to conversation history
    user_content = message
    if files:
       for f in files:
            if f.filename != '':
                try:
                    # read the content of the file and append it to the user message in a structured way
                    file_content = f.read().decode('utf-8')
                    user_content += f"\n\n<attached_file name=\"{f.filename}\">\n{file_content}\n</attached_file>\n"
                    
                except UnicodeDecodeError:
                    # message if the file is not a text file or cannot be decoded
                    user_content += f"\n\n<attached_file name=\"{f.filename}\">\n[Note: The file was ignored because it is not a readable text file.]\n</attached_file>\n"

    # add user message, if present, advancement send an empty message
    if user_content.strip():
        history.append({"role": "user", "content": user_content})

    try:
        reasoning_steps = []
        reply = ""
        
        # extract system prompt (index 0) from the history and last user message
        system_msg = history[0] 
        latest_user_msg = {"role": "user", "content": user_content} if user_content.strip() else None

        if agent_role == "safety":

            # create isolate array for current turn
            current_turn_safety_history = [system_msg]
            if latest_user_msg:
                current_turn_safety_history.append(latest_user_msg)

            # autocorrection loop for Safety Check (max N iterations)
            for iteration in range(SAFETY_ITERATIONS):
                len_before = len(current_turn_safety_history)
                valid_output, reply_text, reply = get_validated_llm_reply(current_turn_safety_history, agent_role)

                # synchronize failed validation tries in the main history
                for msg in current_turn_safety_history[len_before:]:
                    history.append(msg)

                if not valid_output:
                    return {"error": "LLM failed to produce valid JSON after retries"}, 500

                reasoning_steps.append({"iteration": iteration + 1, "content": reply_text})
                history.append({"role": "assistant", "content": reply_text})
                
                status = str(reply.get("status", "")).upper()
                questions = reply.get("clarifying_questions", [])
                issues_found = reply.get("issues", [])
                issues_text = "\n".join([f"- {issue}" for issue in issues_found])

                is_approved = "APPROVED" in status
                is_awaiting_info = "AWAITING INFORMATION" in status

                has_questions = isinstance(questions, list) and len(questions) > 0
            
                # exit the loop if approved or has questions for the user
                if is_approved or is_awaiting_info or has_questions:
                    break 
               
                # if rejected, we instruct the LLM for the next iteration
                correction_prompt = (f"Your previous plan was REJECTED for the following reasons:\n{issues_text}\n\n"
                    "Please generate a completely new response. STRICTLY verify that every interface "
                    "and device name exists in the physical topology YAML. Fix all the issues mentioned above."
                )
                
                # insert correction in the two arrays
                history.append({"role": "user", "content": correction_prompt})
                current_turn_safety_history.append({"role": "user", "content": correction_prompt})

        else:

            # for planning and execution we use a minimal array. Negotiation use all the history.
            if agent_role in ["planning", "execution"]:
                llm_history = [system_msg]
                if latest_user_msg:
                    llm_history.append(latest_user_msg)
            else:
                llm_history = history 

            len_before = len(llm_history)

            valid_output, reply, _ = get_validated_llm_reply(llm_history, agent_role)

            # update history
            if agent_role in ["planning", "execution"]:
                for msg in llm_history[len_before:]:
                    history.append(msg)
            
            if not valid_output:
                return {"error": "LLM failed to produce valid JSON after retries"}, 500
           
            # add response to history and save it back to Redis
            history.append({"role": "assistant", "content": reply})    
                
        # save updated history to Redis (expiration set to 5 days as security, when the reservation ends, the key is automatically removed)
        redis_client.set(session_key, json.dumps(history), ex=432000)
        
        return {"reply": reply, "chat_id": chat_id, "reasoning_steps": reasoning_steps}, 200
    except Exception as e:
        return {"error": str(e)}, 500


@app.route("/api/agent_server/chat", methods=["POST"])
def chat():
    message = request.form.get("message", "")
    username = request.form.get("username", "")
    reservation_id = request.form.get("reservation_id", "")
    agent_role = request.form.get("agent_role", "")
    chat_id = request.form.get("chat_id", "")
    files = request.files.getlist("files")

    if not username or not reservation_id:
        return jsonify({"error": "Missing username or reservation_id"}), 400

    result, status_code = handle_chat_logic(username, reservation_id, chat_id, agent_role, message, files)
    return jsonify(result), status_code

    
@app.route("/api/agent_server/advance", methods=["POST"])
def advance_agent():
    data = request.get_json()
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")
    current_role = data.get("current_agent", "")
    next_role = data.get("next_agent", "")

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
    if current_role in ["planning", "safety", "execution"]:
        negotiation_key = f"agent_history:negotiation:{username}:{reservation_id}:{chat_id}"
        negotiation_history_str = redis_client.get(negotiation_key)
        
        if negotiation_history_str:
            negotiation_history = json.loads(negotiation_history_str)
            last_negotiation_msg = negotiation_history[-1]["content"]
            is_valid_negotiation, parsed_negotiation = validate_json_format(last_negotiation_msg, "negotiation")
            
            if is_valid_negotiation and parsed_negotiation.get("status") == "APPROVED":
                experiment_context = format_as_string(parsed_negotiation.get("context_for_planning", "No specific experiment context provided."))

    if current_role == "negotiation":

        raw_context = format_as_string(parsed.get("context_for_planning", ""))
        context_payload = f"<experiment_context>\n{raw_context}\n</experiment_context>"

    elif current_role == "planning":
        plan = format_as_string(parsed.get("execution_plan", ""))
        verification = format_as_string(parsed.get("verification", []))
        
        context_payload = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<execution_plan>\n{plan}\n</execution_plan>\n\n<verification_commands>\n{verification}\n</verification_commands>"
    
    elif current_role == "safety":
        plan = parsed.get("executable_plan", "[]")

        base_dir = os.path.dirname(os.path.abspath(__file__))
        inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
        
        if isinstance(plan, str):
            if plan.strip().upper() in ["", "N/A", "NONE", "[]"]:
                plan = []
            else:
                # if the plan is a string, we parse as a list of commands
                plan = [line.strip() for line in plan.strip().split('\n') if line.strip()]

        if isinstance(plan, list) and len(plan) > 0:
            execution_report = run_agent_execution_plan(inventory_path, plan, reservation_id)      
            context_payload = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<execution_results>\n{execution_report}\n</execution_results>\n"
            
        else:    
            context_payload = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<execution_results>\nNo execution plan was provided. Report that the safety check passed with no commands to execute.\n</execution_results>\n"
            
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

        context_payload = f"Please analyze the errors below and generate a NEW corrected execution plan.\n\n<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<failed_execution_plan>\n{old_plan}\n</failed_execution_plan>\n\n<execution_report>\n{execution_report}\n</execution_report>"
        
    result, status_code = handle_chat_logic(username, reservation_id, chat_id, next_role, context_payload, files=None)
    
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
    
    return jsonify({"chat_ids": chat_ids, "phases_order": PHASES_ORDER, "max_iterations": MAX_EXECUTION_ITERATIONS})

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
        visible_messages = [msg for msg in history if msg.get("role") != "system"]
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

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5006, use_reloader=False)