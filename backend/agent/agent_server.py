import json
import redis
import uuid
import time
import os
import subprocess
import yaml
import io
import zipfile
import re
from flask import request, jsonify, send_file
from concurrent.futures import ThreadPoolExecutor, as_completed
from ..app import app
from .llm_client import chat_with_llm
from ..utils import get_is_virtual_from_db
from ..config import REDIS_HOST, REDIS_PORT, REDIS_DB, SAFETY_ITERATIONS, PHASES_ORDER, JSON_RETRIES, LOCAL_TEST, CONTAINERLAB_HOST, CONTAINERLAB_HOST_USER, AVAILABLE_MODELS, LLM_MODEL
from .agents_util.prompts import AGENT_PROMPTS, DEVICE_KIND_RULES, FORBIDDEN_RULES, READ_INTENTS, ROLLBACK_BASE_CMD, TROUBLESHOOTER_PROMPTS, ALLOWED_DIAGNOSTIC_COMMANDS

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

# check if generated commands on 
def is_command_whitelisted(command: str) -> bool:
    for pattern in ALLOWED_DIAGNOSTIC_COMMANDS:
        if re.match(pattern, command.strip()):
            return True
    return False

def get_dynamic_device_rules(agent_role: str) -> str:
    # extracts device kinds from the topology and retrieve rules for the current agent
    
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


def setup_ansible_env(reservation_id):
    if LOCAL_TEST:
        base_cmd = ["wsl","ansible"]
    else:
        base_cmd = ["ansible"]

    extra_vars = {}

    # if virtual deployment, we add proxy command to ansible ssh connection
    is_virtual = get_is_virtual_from_db(reservation_id)

    if is_virtual:
        proxy_cmd = f"-o StrictHostKeyChecking=no -o ProxyCommand=\"ssh -W %h:%p -o StrictHostKeyChecking=no {CONTAINERLAB_HOST_USER}@{CONTAINERLAB_HOST}\""
        extra_vars['ansible_ssh_common_args'] = proxy_cmd

    return base_cmd, extra_vars

def execute_single_ansible_command(device, command, inventory_path, base_cmd, extra_vars, timeout=60):
    # create ansible command to execute the command on the device using the provided inventory
    cmd = base_cmd + [device, "-i", inventory_path, "-m", "shell", "-a", command]
    
    # add extra vars if present
    if extra_vars:
        cmd += ["--extra-vars", json.dumps(extra_vars)]

    try:
        # execution with 1 minute timeout
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        
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
        
        return f"{device}: {command} |\n{final_message}\n"
    
    except subprocess.TimeoutExpired:
        return f"{device}: {command} |\n[EXECUTION ERROR: Timeout expired ({timeout}s)]\n"
    except Exception as e:
        return f"{device}: {command} |\n[SYSTEM ERROR]: {str(e)}\n"

def run_agent_execution_plan(inventory_path: str, execution_plan: list, reservation_id):
    
    base_cmd, extra_vars = setup_ansible_env(reservation_id)
    
    report_lines = []
    
    for step in execution_plan:
        if ":" not in step:
            continue
            
        device, command = step.split(":", 1)
        device = device.strip()
        command = command.strip()

        report = execute_single_ansible_command(device=device, command=command, inventory_path=inventory_path, base_cmd=base_cmd, extra_vars=extra_vars, timeout=60)
        
        report_lines.append(report)

    return "\n-------------------------\n".join(report_lines)


def get_device_command(intent: str, device_kind: str) -> str:
    # read command to execute on the device from intent and device kind
    intent_map = READ_INTENTS.get(intent)
    if not intent_map:
        return None
    for kind_tuple, command in intent_map.items():
        # if device_kind is "linux (ubuntu)", match with "linux")
        if any(k in device_kind.lower() for k in kind_tuple):
            return command
    return None

def run_parallel_commands(inventory_path: str, ops_list: list, reservation_id: str, is_intent=False):

    if not ops_list:
        return "No commands to run"
    
    base_cmd, extra_vars = setup_ansible_env(reservation_id)

    topo_dict = yaml.safe_load(testbed_topology) or {}
    nodes = topo_dict.get("topology", {}).get("nodes", {})

    # group commands per device to serialize
    tasks_by_device = {}
    for op in ops_list:
        if ":" not in op:
            continue
        
        device, intent = op.split(":", 1)
        device = device.strip()
        intent = intent.strip()

        tasks_by_device.setdefault(device, []).append(intent)

    report_lines = []

    # function run by every thread
    def execute_for_device(device, intents):
        # get device kind from topology
        kind = nodes.get(device, {}).get("kind", "") if is_intent else None
        
        dev_report = []
        for intent in intents:
            cmd_str = intent
            # get command to run for every device kind and intent, in safety execution
            if is_intent:
                cmd_str = get_device_command(intent, kind)
                if not cmd_str:
                    dev_report.append(f"{device} [{intent}]: [ERROR] Intent '{intent}' not mapped for kind '{kind}'")
                    continue

            report = execute_single_ansible_command(device=device, command=cmd_str, inventory_path=inventory_path, base_cmd=base_cmd, extra_vars=extra_vars, timeout=30)
            dev_report.append(report)
            
        return "\n-------------------------\n".join(dev_report) if dev_report else ""

    # parralel execution between different devices
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(execute_for_device, dev, intents) for dev, intents in tasks_by_device.items()]
        for future in as_completed(futures):
            res = future.result()
            if res:
                report_lines.append(res)

    return "\n-------------------------\n".join(report_lines)

def validate_json_format(reply_text, agent_role):
    # remove characters added by some models
    if reply_text is None:
        return False, "LLM reply is None before JSON parsing."

    if not isinstance(reply_text, str):
        return False, f"LLM reply is not a string before JSON parsing. Type={type(reply_text).__name__}"

    if not reply_text.strip():
        return False, "LLM reply is an empty or blank string before JSON parsing."
    
    reply_text = reply_text.strip()

    if reply_text.startswith("```json"):
        reply_text = reply_text[7:]

    elif reply_text.startswith("```"):
        reply_text = reply_text[3:]

    if reply_text.endswith("```"):
        reply_text = reply_text[:-3]

    reply_text = reply_text.strip()

    # verify the agent's output is a valid json
    try:
        data = json.loads(reply_text)
        if agent_role == "negotiation": 
            if not all(k in data for k in ["summary", "topology_diagram", "clarifying_questions", "status", "context_for_planning"]):
                return False, "Missing keys. Required: summary, topology_diagram, clarifying_questions, status, context_for_planning"
            
            if not isinstance(data.get("exit_conditions"), list):
                return False, "exit_conditions must be a JSON array"
        
        if agent_role == "planning":
            if not all(k in data for k in ["execution_plan", "verification", "status"]):
                return False, "Missing keys. Required: execution_plan, verification, status"
            
            if not isinstance(data.get("execution_plan"), list):
                return False, "execution_plan must be a JSON array"
            
            if not isinstance(data.get("verification"), list):
                return False, "verification must be a JSON array"
                 
        if agent_role == "safety":
            if not all(k in data for k in ["status", "issues", "topology_mapping_check", "executable_plan", "verification_plan", "clarifying_questions", "read_operations"]):
                return False, "Missing keys. Required: status, issues, topology_mapping_check, executable_plan, clarifying_questions, read_operations"
            
            if not isinstance(data.get("read_operations"), list):
                return False, "read_operations must be a JSON array"
            
            if not isinstance(data.get("issues"), list):
                return False, "issues must be a JSON array"
            
            if not isinstance(data.get("topology_mapping_check"), list):
                return False, "topology_mapping_check must be a JSON array"
            
            if not isinstance(data.get("executable_plan"), list):
                return False, "executable_plan must be a JSON array"

            if not isinstance(data.get("verification_plan"), list):
                return False, "verification_plan must be a JSON array"
            
            if not isinstance(data.get("clarifying_questions"), list):
                return False, "clarifying_questions must be a JSON array"
            
        if agent_role == "execution":
            if not all(k in data for k in ["status", "report"]):
                return False, "Missing keys. Required: status, report"

        # troubleshooter validator
        if agent_role == "diagnostic_intent":
            if not all(k in data for k in ["status", "response", "context"]):
                return False, "Missing keys. Required: status, response, context"
                
        if agent_role == "diagnostic_planner":
            if not all(k in data for k in ["diagnostic_commands", "commands_to_approve"]):
                return False, "Missing keys. Required: diagnostic_commands, commands_to_approve"
            if not isinstance(data.get("diagnostic_commands"), list) or not isinstance(data.get("commands_to_approve"), list):
                return False, "diagnostic_commands and commands_to_approve must be a JSON array"
                
        if agent_role == "diagnostic_reporter":
            if not all(k in data for k in ["response"]):
                return False, "Missing keys. Required: response"
            
        return True, data
    
    except json.JSONDecodeError as e:
        return False, f"The output is not a valid JSON object. JSONDecodeError: {str(e)}"
    
def get_validated_llm_reply(history, agent_role, llm_model):
    local_history = history.copy()
    last_failure_reason = None

    for attempt in range(1, JSON_RETRIES + 1):

        payload_length = sum(len(str(m.get("content", ""))) for m in local_history)
        print(f"\n[DEBUG SERVER] get_validated_llm_reply | agent={agent_role} | attempt={attempt}/{JSON_RETRIES}")
        print(f"[DEBUG SERVER] history_messages={len(local_history)} | payload_chars~={payload_length}")

        try:

            reply_text = chat_with_llm(local_history, llm_model)

        except Exception as e:
            last_failure_reason = f"LLM call exception: {str(e)}"
            print(f"[DEBUG SERVER] LLM CALL FAILED | attempt={attempt} | reason={last_failure_reason}")

            correction_prompt = (
                f"Your previous response failed because of a system/runtime issue: {last_failure_reason}. "
                f"You MUST NOT return an empty response. "
                f"Please generate a new complete response in valid JSON following the mandatory structure."
            )

            local_history.append({"role": "assistant", "content": f"[SYSTEM DIAGNOSTIC] {last_failure_reason}"})
            local_history.append({"role": "user", "content": correction_prompt})
            continue

        print(f"[DEBUG SERVER] RAW REPLY TYPE: {type(reply_text).__name__}")
        print(f"[DEBUG SERVER] RAW REPLY LENGTH: {len(reply_text) if isinstance(reply_text, str) else 'N/A'}")

        is_valid, validation_result = validate_json_format(reply_text, agent_role)
        if is_valid:
            # validation_result is the cleaned python dictionary, we cnvert into a JSON string without `` characters
            clean_reply_text = json.dumps(validation_result)
            print(f"[DEBUG SERVER] VALID JSON RECEIVED | attempt={attempt}")

            return True, clean_reply_text, validation_result

        last_failure_reason = validation_result

        print(f"\n[DEBUG SERVER] VALIDATION FAILED | attempt={attempt} | reason={validation_result}")

        local_history.append({"role": "assistant", "content": reply_text if isinstance(reply_text, str) else str(reply_text)})
        
        correction_prompt = f"Your previous response failed validation: {validation_result}. Return ONLY one valid JSON object. Do not include markdown fences. Do not include explanations before or after the JSON. You MUST NOT return an empty response. Please generate a new complete response in valid JSON following the mandatory structure."
        
        local_history.append({"role": "user", "content": correction_prompt})

    print(f"[DEBUG SERVER] ALL RETRIES EXHAUSTED | last_failure_reason={last_failure_reason}")

    return False, None, {"error_type": "llm_validation_failure", "reason": last_failure_reason}


def handle_safety_loop(history, system_msg, latest_user_msg, reservation_id, agent_role, llm_model, is_manual_chat=False):
    reasoning_steps = []
    reply = {}

    if is_manual_chat:
        # retrieve first mesage in history for the context when every iteration is rejected and user send a manual message ---
        real_context = ""
        for msg in history:
            content = msg.get("content", "")
            if msg.get("role") == "user" and "<experiment_context>" in content and "<device_report>\nnull\n</device_report>" not in content:
                real_context = content
                break
                    
        # remove original <execution_plan> and <verification_commands> of the first context
        if real_context:
            real_context = re.sub(r'<execution_plan>.*?</execution_plan>', '', real_context, flags=re.DOTALL)
            real_context = re.sub(r'<verification_commands>.*?</verification_commands>', '', real_context, flags=re.DOTALL)
            # remove double spaces that remains after removal
            real_context = re.sub(r'\n{3,}', '\n\n', real_context).strip()
        
        # extract the last failed plan proposed by the agent
        last_failed_plan = ""
        for msg in reversed(history):
            if msg.get("role") == "assistant":
                try:
                    parsed = json.loads(msg.get("content", ""))
                    if "REJECTED" in str(parsed.get("status", "")).upper():
                        plan_arr = parsed.get("executable_plan", [])
                        last_failed_plan = "\n".join(plan_arr) if isinstance(plan_arr, list) else str(plan_arr)
                        break
                except:
                    pass
        
        # creation of the prompt with the user message and the experiment context
        manual_text = latest_user_msg["content"] if latest_user_msg else ""
        
        combined_content = (f"MANUAL INSTRUCTION FROM USER:\n{manual_text}\n\n" "--- REFERENCE DATA ---\n" f"{real_context}\n\n")
        
        if last_failed_plan:
            combined_content += ("--- IMPORTANT CONTEXT ---\n"
                "The auto-correction loop is finished. Below is the <last_failed_execution_plan>.\n"
                "Note that this plan ALREADY INCLUDES both the execution operations and the verification commands.\n"
                f"<last_failed_execution_plan>\n{last_failed_plan}\n</last_failed_execution_plan>\n"
            )
            
        combined_content += ("\nYou MUST treat <last_failed_execution_plan> as the target plan to be evaluated. "
            "Please apply the manual instruction to fix this failed plan, ensure there are no redundant commands, "
            "and generate a completely NEW, corrected JSON response.")
        
        # LLM will receive the system prompt and the combined prompt
        current_turn_safety_history = [system_msg, {"role": "user", "content": combined_content}]
    
    else:
    
        current_turn_safety_history = [system_msg]
        if latest_user_msg:
            current_turn_safety_history.append(latest_user_msg)
        
    if not is_manual_chat and latest_user_msg and "<device_report>\nnull\n</device_report>" in latest_user_msg["content"]:
        payload_length = sum(len(str(m.get("content", ""))) for m in current_turn_safety_history)
        print(f"[DEBUG SAFETY] messages={len(current_turn_safety_history)} | payload_chars~={payload_length}")

        is_valid, reply_text, reply = get_validated_llm_reply(current_turn_safety_history, agent_role, llm_model)

        status = str(reply.get("status", "")).strip().upper() if is_valid and reply else ""

        if "AWAITING_DEVICE_READ" in status:
            history.append({"role": "assistant", "content": reply_text})

            # show read request in the frontend
            reasoning_steps.append({"iteration": "Device Read Request", "role": "assistant", "content": reply_text})
            
            read_ops = reply.get("read_operations", [])
            base_dir = os.path.dirname(os.path.abspath(__file__))
            inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
                
            device_report = run_parallel_commands(inventory_path, read_ops, reservation_id, is_intent=True)

            print(f"[DEBUG SAFETY] read_operations_count={len(read_ops)}")
            print(f"[DEBUG SAFETY] device_report_chars={len(device_report)}")

            # create new user message with read real data, replace null with real data
            new_content = latest_user_msg["content"].replace("<device_report>\nnull\n</device_report>", f"<device_report>\n{device_report}\n</device_report>")
            new_user_msg = {"role": "user", "content": new_content}

            # add new user message to the global history
            history.append(new_user_msg)

            # show real data on frontend
            reasoning_steps.append({"iteration": "Device Read Data", "role": "user", "content": f"[System: read data successfully retrieved from devices]\n\n{new_content}"})
                
            # clean local history, send system message with real data and the latest user message
            current_turn_safety_history = [system_msg, new_user_msg]
           
    # autocorrection loop for Safety Check (max N iterations)
    for iteration in range(SAFETY_ITERATIONS):
        len_before = len(current_turn_safety_history)
        valid_output, reply_text, reply = get_validated_llm_reply(current_turn_safety_history, agent_role, llm_model)

        # synchronize failed validation tries in the main history
        for msg in current_turn_safety_history[len_before:]:
            history.append(msg)

        if not valid_output:
            print(f"[DEBUG SERVER] FINAL FAILURE DETAILS (safety): {reply}")
            return {"error": "LLM failed to produce valid JSON after retries", "details": reply}, 500

        reasoning_steps.append({"iteration": iteration + 1, "role": "assistant", "content": reply_text})
        history.append({"role": "assistant", "content": reply_text})

        # add LLM response in local memory of the loop
        current_turn_safety_history.append({"role": "assistant", "content": reply_text})
        
        status = str(reply.get("status", "")).upper()
        questions = reply.get("clarifying_questions", [])
        issues_found = reply.get("issues", [])
        issues_text = "\n".join([f"- {issue}" for issue in issues_found])

        is_approved = "APPROVED" in status
        is_awaiting_info = "AWAITING INFORMATION" in status

        has_questions = isinstance(questions, list) and len(questions) > 0
    
        # exit the loop if approved or has questions for the user
        if is_approved or is_awaiting_info or has_questions or iteration == SAFETY_ITERATIONS - 1:
            break 
        
        # if rejected, we instruct the LLM for the next iteration
        correction_prompt = (f"In your previous response, you identified the following issues:\n{issues_text}\n\n"
            "Please review the NEW `executable_plan` you just generated."
            "If your newly generated plan successfully fixes all the issues, is safe, matches the topology, and has NO redundant commands, "
            "you MUST now output 'status': 'APPROVED' and provide the final clean plan. "
            "If your newly generated plan still contains errors, output 'status': 'REJECTED', list the remaining issues, and fix the plan again."
            "You MUST respond EXCLUSIVELY with a valid JSON object. Do not output empty text."
        )

        reasoning_steps.append({"iteration": iteration + 1, "role": "user", "content": correction_prompt})
        
        # insert correction in the two arrays
        history.append({"role": "user", "content": correction_prompt})
        current_turn_safety_history.append({"role": "user", "content": correction_prompt})    

    return {"reply": reply, "reasoning_steps": reasoning_steps}, 200


def handle_chat_logic(username, reservation_id, chat_id, agent_role, message, llm_model, files=None, is_manual_chat=False):
    # if there is no chat_id, it means the user is starting a new chat. We generate one.
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"          # added timestamp to guarantee chronological order

    session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"

    # retrieve history from Redis
    history_str = redis_client.get(session_key)
    if history_str:
        history = json.loads(history_str)
    else:
        #prompt_key = "safety_compliance" if agent_role == "safety" else agent_role
        #system_prompt = AGENT_PROMPTS.get(prompt_key)
        system_prompt = AGENT_PROMPTS.get(agent_role)

        dynamic_rules = get_dynamic_device_rules(agent_role)
        if dynamic_rules:
            system_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

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

            result, status_code = handle_safety_loop(history, system_msg, latest_user_msg, reservation_id, agent_role, llm_model, is_manual_chat)
            if status_code != 200:
                return result, status_code
            
            # redis save data automatically
            reply = result["reply"]
            reasoning_steps = result["reasoning_steps"]

        else:

            # for planning and execution we use a minimal array. Negotiation use all the history.
            if agent_role in ["planning", "execution"]:
                llm_history = [system_msg]
                if latest_user_msg:
                    llm_history.append(latest_user_msg)
            else:
                llm_history = history 

            len_before = len(llm_history)

            valid_output, reply, _ = get_validated_llm_reply(llm_history, agent_role, llm_model)

            # update history
            if agent_role in ["planning", "execution"]:
                for msg in llm_history[len_before:]:
                    history.append(msg)
            
            if not valid_output:
                print(f"[DEBUG SERVER] FINAL FAILURE DETAILS (safety): {reply}")
                return {"error": "LLM failed to produce valid JSON after retries", "details": reply}, 500
           
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
                exec_report = run_parallel_commands(inventory_path, plan, reservation_id, is_intent=False)
                verif_report = run_parallel_commands(inventory_path, v_plan, reservation_id, is_intent=False)
                execution_report = f"--- CONFIGURATION REPORT ---\n{exec_report}\n\n--- VERIFICATION REPORT ---\n{verif_report}"
            else:
                complete_plan = plan + v_plan
                execution_report = run_agent_execution_plan(inventory_path, complete_plan, reservation_id)      

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
    
    return jsonify({"chat_ids": chat_ids, "phases_order": PHASES_ORDER, "available_models": AVAILABLE_MODELS, "default_model": LLM_MODEL})

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
    devices = {}
    try:
        with open(inventory_path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('[') or line.startswith('#'): continue
                parts = line.split()
                dev_name = parts[0]
                role = "host"
                res_iface = "eth0"
                for p in parts[1:]:
                    if p.startswith("role="): role = p.split("=")[1]
                    if p.startswith("res_iface="): res_iface = p.split("=")[1]
                devices[dev_name] = {'role': role, 'iface': res_iface}
    except Exception as e:
        return jsonify({"error": f"Error reading inventory: {str(e)}"}), 500

    base_cmd, extra_vars = setup_ansible_env(reservation_id)

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
                cmd_str += f"printf '%s\\n' '{safe_content}' > /etc/frr/frr.conf; service frr restart || true;"
            except FileNotFoundError:
                cmd_str += "> /etc/frr/frr.conf; service frr restart || systemctl restart frr || true;"

        return execute_single_ansible_command(device, cmd_str, inventory_path, base_cmd, extra_vars, timeout=60)
    
    # parallel execution with Worker
    report_lines = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(execute_rollback_for_device, dev, info) for dev, info in devices.items()]
        for future in as_completed(futures):
            report_lines.append(future.result())

    return jsonify({"status": "SUCCESS", "report": "\n".join(report_lines)}), 200

@app.route("/api/agent_server/troubleshooter/chat", methods=["POST"])
def troubleshooter_chat():
    username = request.form.get("username", "")
    reservation_id = request.form.get("reservation_id", "")
    chat_id = request.form.get("chat_id", "")
    message = request.form.get("message", "")
    llm_model = request.form.get("llm_model", LLM_MODEL)
    
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"

    session_key = f"agent_history:troubleshooter_chat:{username}:{reservation_id}:{chat_id}"
    history_str = redis_client.get(session_key)
    
    if history_str:
        history = json.loads(history_str)
    else:
        system_prompt = TROUBLESHOOTER_PROMPTS["diagnostic_intent"]
        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"
        history = [{"role": "system", "content": system_prompt}]


    history.append({"role": "user", "content": message})
    
    # Intent agent
    is_valid, _, intent_json = get_validated_llm_reply(history, "diagnostic_intent", llm_model)
    if not is_valid:
        return jsonify({"error": "Failed intent evaluation"}), 500

    print("\n" + "="*50)
    print(f"[TROUBLESHOOTER - INTENT AGENT] Result:")
    print(json.dumps(intent_json, indent=2))
    print("="*50 + "\n")

    status = intent_json.get("status", "").upper()
    response_msg = intent_json.get("response", "")
    context = intent_json.get("context", "")

    if status == "REJECTED":
        # if questions, save the chat and reply to user
        history.append({"role": "assistant", "content": response_msg})
        redis_client.set(session_key, json.dumps(history), ex=432000)
        return jsonify({"reply": response_msg, "chat_id": chat_id, "requires_approval": False}), 200

    # if status approved, save only user message, do not save intent agent response
    redis_client.set(session_key, json.dumps(history), ex=432000)

    planner_sys_prompt = TROUBLESHOOTER_PROMPTS["diagnostic_planner"]

    dynamic_rules = get_dynamic_device_rules("diagnostic_planner")

    if dynamic_rules:
        planner_sys_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

    planner_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

    # Planner agent
    planner_history = [
        {"role": "system", "content": planner_sys_prompt},
        {"role": "user", "content": f"<context>\n{context}\n</context>"}
    ]
    is_valid, _, planner_json = get_validated_llm_reply(planner_history, "diagnostic_planner", llm_model)
    if not is_valid:
        return jsonify({"error": "Failed planner evaluation"}), 500

    print("\n" + "="*50)
    print(f"[TROUBLESHOOTER - PLANNER AGENT] Result:")
    print(json.dumps(planner_json, indent=2))
    print("="*50 + "\n")

    diag_cmds = planner_json.get("diagnostic_commands", [])
    approve_cmds = planner_json.get("commands_to_approve", [])

    # check whitelist
    safe_cmds = []
    pending_cmds = approve_cmds.copy()

    for cmd_str in diag_cmds:
        if ":" in cmd_str:
            dev, cmd = cmd_str.split(":", 1)
            if is_command_whitelisted(cmd):
                safe_cmds.append(cmd_str)
            else:
                pending_cmds.append(cmd_str)

    if pending_cmds:
        # ask approval to the frontend
        # return context and chat_id so that the fontend resend this data
        return jsonify({"chat_id": chat_id, "requires_approval": True, "commands": pending_cmds, "safe_commands": safe_cmds, "context": context }), 200

    # if nothing to approve, execute
    base_dir = os.path.dirname(os.path.abspath(__file__))
    inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
    
    execution_report = run_parallel_commands(inventory_path, safe_cmds, reservation_id, is_intent=False)

    reporter_sys_prompt = TROUBLESHOOTER_PROMPTS["diagnostic_reporter"]
    reporter_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"
    
    # Reporter agent
    reporter_history = [
        {"role": "system", "content": reporter_sys_prompt},
        {"role": "user", "content": f"<context>\n{context}\n</context>\n<execution_report>\n{execution_report}\n</execution_report>"}
    ]
    
    is_valid, _, reporter_json = get_validated_llm_reply(reporter_history, "diagnostic_reporter", llm_model)
    if not is_valid:
            return jsonify({"error": "Failed reporter evaluation"}), 500

    print("\n" + "="*50)
    print(f"[TROUBLESHOOTER - REPORTER AGENT] Result:")
    print(json.dumps(reporter_json, indent=2))
    print("="*50 + "\n")

    final_response = reporter_json.get("response", "Error during report generation")

    # save only final message in the chat visible by user
    history.append({"role": "assistant", "content": final_response})
    redis_client.set(session_key, json.dumps(history), ex=432000)

    return jsonify({"reply": final_response, "chat_id": chat_id, "requires_approval": False}), 200


@app.route("/api/agent_server/troubleshooter/execute_approved", methods=["POST"])
def execute_approved_troubleshooter():
    data = request.get_json()
    approved_commands = data.get("approved_commands", [])
    context = data.get("context", "")
    username = data.get("username", "")
    reservation_id = data.get("reservation_id", "")
    chat_id = data.get("chat_id", "")
    llm_model = data.get("llm_model", LLM_MODEL)

    if not approved_commands:
        execution_report = "[SYSTEM LOG]: The user rejected all proposed commands, and there were no whitelisted commands available. No read operations were performed on the devices. Inform the user that you cannot complete the analysis without executing the commands, and ask them to try again or rephrase their request."
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        inventory_path = os.path.abspath(os.path.join(base_dir, "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
        
        # run commands (whitelist + approval)
        execution_report = run_parallel_commands(inventory_path, approved_commands, reservation_id, is_intent=False)

    reporter_sys_prompt = TROUBLESHOOTER_PROMPTS["diagnostic_reporter"]
    reporter_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

    # Reporter agent
    reporter_history = [
        {"role": "system", "content": reporter_sys_prompt},
        {"role": "user", "content": f"<context>\n{context}\n</context>\n<execution_report>\n{execution_report}\n</execution_report>"}
    ]

    is_valid, _, reporter_json = get_validated_llm_reply(reporter_history, "diagnostic_reporter", llm_model)
    if not is_valid:
                return jsonify({"error": "Failed reporter evaluation"}), 500

    print("\n" + "="*50)
    print(f"[TROUBLESHOOTER - REPORTER AGENT] Result:")
    print(json.dumps(reporter_json, indent=2))
    print("="*50 + "\n")

    final_response = reporter_json.get("response", "Error during report generation")

    # update history
    session_key = f"agent_history:troubleshooter_chat:{username}:{reservation_id}:{chat_id}"
    history_str = redis_client.get(session_key)
    history = json.loads(history_str) if history_str else []
    
    history.append({"role": "assistant", "content": final_response})
    redis_client.set(session_key, json.dumps(history), ex=432000)

    return jsonify({"reply": final_response}), 200

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5006, use_reloader=False)