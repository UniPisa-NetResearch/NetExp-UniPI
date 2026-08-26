import json
import redis
import uuid
import time
import os
import re
import yaml
import paramiko
import socket
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from ...app import app
from ..llm_client import chat_with_llm, chat_with_llm_stream
from .prompts import ALLOWED_DIAGNOSTIC_COMMANDS, DEVICE_KIND_RULES, READ_INTENTS, AGENT_PROMPTS, FORBIDDEN_RULES, DIAGNOSTIC_ASSISTANT_PROMPTS
from ...config import REDIS_HOST, REDIS_PORT, REDIS_DB, CONTAINERLAB_HOST, CONTAINERLAB_HOST_USER, JSON_RETRIES, SAFETY_ITERATIONS, MAX_DIAGNOSTIC_ASSISTANT_MESSAGES
from ...utils import get_is_virtual_from_db, parse_complete_inventory_hosts

# redis store for conversation history, keyed by username and reservation_id
redis_client = redis.Redis(
    host=REDIS_HOST, 
    port=REDIS_PORT, 
    db=REDIS_DB, 
    decode_responses=True   # automatically decodes bytes in strings
)

topology_file_path = os.path.join(os.path.dirname(__file__), "topology_plain.yaml")
try:
    with open(topology_file_path, "r") as topo_file:
        testbed_topology = topo_file.read()
except FileNotFoundError:
    testbed_topology = "# Topology file not found"
    print(f"Warning: Could not find {topology_file_path}")

# lock for thread-safe logging
log_lock = threading.Lock()

# convert json lists in formatted text
def format_as_string(val):
    if isinstance(val, list):
        return "\n".join([str(item) for item in val])
    return str(val)

# parse the experiment plan
def parse_plan(plan):
    if isinstance(plan, str):
        if plan.strip().upper() in ["", "N/A", "NONE", "[]"]:
            return []
        else:
            # if the plan is a string, we parse as a list of commands
            return [line.strip() for line in plan.strip().split('\n') if line.strip()]
    return plan if isinstance(plan, list) else []

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

# open a pool of connections, one per device, and return a dict {device_name: (ssh_client, device_info)}
def open_ssh_connections(devices, inventory_path, reservation_id, hosts=None):
    if hosts is None:
        hosts = parse_complete_inventory_hosts(inventory_path)
        
    is_virtual = get_is_virtual_from_db(reservation_id)
    connections = {}
    for device in devices:
        info = hosts.get(device)
        if not info or not info.get("host"):
            continue
        try:
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            sock = None

            # for virtual reservation add proxy command
            if is_virtual:
                proxy_cmd = f"ssh -W {info['host']}:22 -o StrictHostKeyChecking=no {CONTAINERLAB_HOST_USER}@{CONTAINERLAB_HOST}"
                sock = paramiko.ProxyCommand(proxy_cmd)

            client.connect(hostname=info["host"], username=info["user"], password=info["password"], sock=sock, timeout=15, look_for_keys=False, allow_agent=False)

            connections[device] = (client, info)

        except Exception as e:
            print(f"[DEBUG] Connection failed to {device}: {e}")
    return connections


# close a pool of connections
def close_ssh_connections(connections):
    for client, _ in connections.values():
        try:
            client.close()
        except Exception:
            pass

# execute a single command on a device and return the output, error, and status
def execute_single_ssh_command(device, command, client, info, timeout=60):
    try:
        if info.get("become"):
            # escaping single quotes to avoid shell issues
            safe_cmd = command.replace("'", "'\\''")
            # add sudo to read the password from standard input and avoid to show the password prompt, -c ask bash to interpret the command string as unique script
            full_cmd = f"sudo -S -p '' bash -c '{safe_cmd}'"
        else:
            full_cmd = command

        # execute command in the SSH session
        stdin, stdout, stderr = client.exec_command(full_cmd, timeout=timeout)
        if info.get("become") and info.get("become_pass"):
            # send password only if requested, \n correspond to Enter key, perform flush to ensure the password is sent immediately
            stdin.write(info["become_pass"] + "\n")
            stdin.flush()

        exit_status = stdout.channel.recv_exit_status()
        raw_out = stdout.read().decode(errors="replace").strip()
        error_out = stderr.read().decode(errors="replace").strip()

        debug_msg = (
            f"[DEBUG] Device: {device} | Command: {command}\n"
            f"[DEBUG] Return code: {exit_status}\n"
            f"[DEBUG] STDOUT:\n{raw_out}\n"
        )

        if error_out:
            debug_msg += f"[DEBUG] STDERR:\n{error_out}\n"
        debug_msg += "-" * 60

        # print message in a separate thread-safe block to avoid interleaving outputs
        with log_lock:
            print(debug_msg)

        is_success = exit_status == 0
        clean_out = raw_out

        final_message = ""
        if is_success:
            if error_out:
                final_message = f"[WARNING: Command succeeded but generated stderr]:\n{error_out}"
            if clean_out:
                final_message = f"[SUCCESS]:\n{clean_out}"
            elif not final_message:
                final_message = "[SUCCESS: Command applied successfully]"
        else:
            final_message = f"[FAILED: Return code {exit_status}]"
            if error_out:
                final_message += f"\n[STDERR]:\n{error_out}"
            if clean_out:
                final_message += f"\n[STDOUT]:\n{clean_out}"
            if not error_out and not clean_out:
                final_message += "\n[No output or error message returned]"

        return f"{device}: {command} ===\n{final_message}\n"

    except socket.timeout:
        msg = f"{device}: {command} ===\n[EXECUTION ERROR: Timeout expired ({timeout}s)]\n"

        with log_lock:
            print(msg)
        return msg
    
    except (paramiko.SSHException, OSError):
        msg = f"{device}: {command} ===\n[FAILED: Device UNREACHABLE (SSH/Network issue)]\n"

        with log_lock:
            print(msg)
        return msg
    
    except Exception as e:
        msg = f"{device}: {command} ===\n[SYSTEM ERROR]: {str(e)}\n"

        with log_lock:
            print(msg)
        return msg

# run the entire execution plan in serial mode, return a report string with the output of each command
def run_agent_execution_plan(inventory_path: str, execution_plan: list, reservation_id):
    steps = []
    devices_needed = set()
    for step in execution_plan:
        if ":" not in step:
            continue
        device, command = step.split(":", 1)
        device = device.strip()
        command = command.strip()
        steps.append((device, command))
        devices_needed.add(device)

    # open an ssh connection for every device
    connections = open_ssh_connections(devices_needed, inventory_path, reservation_id)
    try:
        report_lines = []
        for device, command in steps:
            entry = connections.get(device)
            if not entry:
                report_lines.append(f"{device}: {command} ===\n[FAILED: Device UNREACHABLE (SSH/Network issue)]\n")
                continue
            # get device name and information from the connection pool
            client, info = entry
            # execute the command and append the result in the report
            report_lines.append(execute_single_ssh_command(device, command, client, info, timeout=60))
        return "\n-------------------------\n".join(report_lines)
    finally:
        close_ssh_connections(connections)

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

# get the last message generated by the agent passed as parameter
def get_last_agent_message(username, reservation_id, chat_id, agent_role):
    agent_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"
    history_str = redis_client.get(agent_key)

    if history_str:
        agent_history = json.loads(history_str)
        last_agent_msg = agent_history[-1]["content"]
        return validate_json_format(last_agent_msg, {agent_role})

    return False, {}

# execute commands on every device in parallel, return the final report
def run_parallel_commands(inventory_path: str, ops_list: list, reservation_id: str, is_intent=False, connections=None):
    if not ops_list:
        return "No commands to run"

    topo_dict = yaml.safe_load(testbed_topology) or {}
    nodes = topo_dict.get("topology", {}).get("nodes", {})

    tasks_by_device = {}
    for op in ops_list:
        if ":" not in op:
            continue
        device, intent = op.split(":", 1)
        # for every device, add the list of commandds to run and strip device and intent to avoid spaces issues
        tasks_by_device.setdefault(device.strip(), []).append(intent.strip())

    # check if a device has an active connection, if not open a new one (running plan commands), otherwise use the existing connections (running read commands)
    owns_connections = connections is None
    if owns_connections:
        connections = open_ssh_connections(tasks_by_device.keys(), inventory_path, reservation_id)
    else:
        # if there are opened connections, open other connections if there are missing devices in the pool
        missing = [d for d in tasks_by_device if d not in connections]
        if missing:
            connections.update(open_ssh_connections(missing, inventory_path, reservation_id))
    
    def execute_for_device(device, intents):
        entry = connections.get(device)
        if not entry:
            return f"{device}: [ERROR] No SSH connection available\n"
        client, info = entry
        kind = nodes.get(device, {}).get("kind", "") if is_intent else None

        dev_report = []
        for intent in intents:
            cmd_str = intent
            # in case of intent specified, run the command mapped in the intent map for the device kind, case of read operations
            if is_intent:
                cmd_str = get_device_command(intent, kind)
                if not cmd_str:
                    dev_report.append(f"{device} [{intent}]: [ERROR] Intent '{intent}' not mapped for kind '{kind}'")
                    continue
            # run single command and append result in the report
            dev_report.append(execute_single_ssh_command(device, cmd_str, client, info, timeout=60))
        return "\n-------------------------\n".join(dev_report) if dev_report else ""

    try:
        report_lines = []
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(execute_for_device, dev, intents) for dev, intents in tasks_by_device.items()]
            for future in as_completed(futures):
                res = future.result()
                if res:
                    report_lines.append(res)
        return "\n-------------------------\n".join(report_lines)
    finally:
        if owns_connections:
            close_ssh_connections(connections)

# validate response from LLM, check if it is a valid json and contains required fields of the current agent role
def validate_json_format(reply_text, agent_role):
    # remove characters added by some models
    if reply_text is None:
        return False, "LLM reply is None before JSON parsing."

    if not isinstance(reply_text, str):
        return False, f"LLM reply is not a string before JSON parsing. Type={type(reply_text).__name__}"

    if not reply_text.strip():
        return False, "LLM reply is an empty or blank string before JSON parsing."
    
    reply_text = reply_text.strip()

    # remove thinking tags and content inside them
    reply_text = re.sub(r'<think>.*?</think>', '', reply_text, flags=re.DOTALL).strip()

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

        if agent_role == "diagnostic_summarizer":
            if not all(k in data for k in ["summary"]):
                return False, "Missing keys. Required: summary"
            
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
        
        correction_prompt = f"Your previous response failed validation: {validation_result}. Return ONLY one valid JSON object matching the mandatory structure. Do not include explanations before or after the JSON. You MUST NOT return an empty response."
        
        local_history.append({"role": "user", "content": correction_prompt})

    print(f"[DEBUG SERVER] ALL RETRIES EXHAUSTED | last_failure_reason={last_failure_reason}")

    return False, None, {"error_type": "llm_validation_failure", "reason": last_failure_reason}


def handle_safety_loop(history, system_msg, latest_user_msg, reservation_id, agent_role, llm_model, is_manual_chat=False):
    reasoning_steps = []
    reply = {}

    if is_manual_chat:
        # retrieve first message in history for the context when every iteration is rejected and user send a manual message
        real_context = ""
        for msg in history:
            content = msg.get("content", "")
            if msg.get("role") == "user" and "<experiment_context>" in content and not re.search(r'<device_report>\s*null\s*</device_report>', content, flags=re.IGNORECASE):
                real_context = content
                break
                    
        # remove original <execution_plan> and <verification_commands> of the first context
        if real_context:
            real_context = re.sub(r'<execution_plan>.*?</execution_plan>', '', real_context, flags=re.DOTALL)
            real_context = re.sub(r'<verification_commands>.*?</verification_commands>', '', real_context, flags=re.DOTALL)
            # remove double spaces that remains after removal
            real_context = re.sub(r'\n{3,}', '\n\n', real_context).strip()
        
        # extract the last failed plan proposed by the agent and its issues
        last_failed_plan = ""
        last_issues = ""
        for msg in reversed(history):
            if msg.get("role") == "assistant":
                try:
                    parsed = json.loads(msg.get("content", ""))
                    if "REJECTED" in str(parsed.get("status", "")).upper():
                        plan_arr = parsed.get("executable_plan", [])
                        last_failed_plan = "\n".join(plan_arr) if isinstance(plan_arr, list) else str(plan_arr)
                        issues_arr = parsed.get("issues", [])
                        last_issues = "\n".join(issues_arr) if isinstance(issues_arr, list) else str(issues_arr)
                        break
                except:
                    pass
        
        # creation of the prompt with the user message and the experiment context
        manual_text = latest_user_msg["content"] if latest_user_msg else ""
        
        combined_content = (f"MANUAL INSTRUCTION FROM USER:\n{manual_text}\n\n" "--- REFERENCE DATA ---\n" f"{real_context}\n\n")

        # create a combined prompt which includes the last failed plan and the issues of the failed plan
        if last_failed_plan:
            combined_content += ("--- IMPORTANT CONTEXT ---\n"
                "The auto-correction loop is finished. Below is the <last_failed_execution_plan>.\n"
                "Note that this plan ALREADY INCLUDES both the execution operations and the verification commands.\n"
                f"<last_failed_execution_plan>\n{last_failed_plan}\n</last_failed_execution_plan>\n"
                f"<last_identified_issues>\n{last_issues}\n</last_identified_issues>\n"
            )
            
        combined_content += ("\nYou MUST treat <last_failed_execution_plan> as the target plan to be evaluated. "
            "Please apply the manual instruction to fix this failed plan, ensure there are no redundant commands, "
            "and generate a completely NEW, corrected JSON response.")
        
        # LLM will receive the system prompt and the combined prompt
        current_turn_safety_history = [system_msg, {"role": "user", "content": combined_content}]
    
    else:
        # if we arrive here, is_manual is false but we are outside the loop due to AWAIT_CLARIFICATIONS message and the user has answered to the questions or it is the first time in this phase we enter in safety phase
        # find last user message with <device_report>
        last_context_idx = -1
        for i in range(len(history) - 1, -1, -1):
            if history[i].get("role") == "user" and "<experiment_context>" in history[i].get("content", ""):
                last_context_idx = i
                break
        
        if last_context_idx != -1:
            raw_turn_history = history[last_context_idx:]
            clean_turn_history = []
            skip_next_user = False

            # management of consecutive agent messages with status respectively REJECTED - REJECTED - AWAITING_CLARIFICATIONS (REJECTED messages must be removed, the agent will receive only AWAITING_CLARIFICATIONS message and user response)
            for msg in raw_turn_history:
                # if previous message was REJECTED, drop the current automatic user message
                if skip_next_user and msg.get("role") == "user":
                    skip_next_user = False
                    continue
                
                # reset the safety flag if the message was not user
                skip_next_user = False

                # if the assistant message is REJECTED, we drop it and set the flag for indicating to drop the next user message (the automatic message sent after a REJECTED message)
                if msg.get("role") == "assistant":
                    try:
                        parsed = json.loads(msg.get("content", ""))
                        if "REJECTED" in str(parsed.get("status", "")).upper():
                            skip_next_user = True
                            continue 
                    except Exception:
                        pass

                # all other messages are preserved
                clean_turn_history.append(msg)

            # merge system prompt (history[0]) with filtered current turn messages
            current_turn_safety_history = [system_msg] + clean_turn_history

    last_msg_content = current_turn_safety_history[-1]["content"] if current_turn_safety_history else ""    

    # if the device report contains null, we start the readings on devices
    if re.search(r'<device_report>\s*null\s*</device_report>', last_msg_content, flags=re.IGNORECASE):
        payload_length = sum(len(str(m.get("content", ""))) for m in current_turn_safety_history)
        print(f"[DEBUG SAFETY] messages={len(current_turn_safety_history)} | payload_chars~={payload_length}")

        # send first request to the LLM, with <device_report> that contains null
        is_valid, reply = yield from consume_llm_stream_with_retries(current_turn_safety_history, agent_role, llm_model)
        reply_text = json.dumps(reply) if is_valid else str(reply)

        status = str(reply.get("status", "")).strip().upper() if is_valid and reply else ""

        # the repsonse contains AWAITING_DEVICE_READ, in this case start readings
        if "AWAITING_DEVICE_READ" in status:
            history.append({"role": "assistant", "content": reply_text})
            current_turn_safety_history.append({"role": "assistant", "content": reply_text})

            # update real time streaming message to inform about the reading phase
            read_ops = reply.get("read_operations", [])
            yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Reading data from testbed devices...]\n\n'})}\n\n"

            base_dir = os.path.dirname(os.path.abspath(__file__))
            inventory_path = os.path.abspath(os.path.join(base_dir, "..", "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
                
            device_report = run_parallel_commands(inventory_path, read_ops, reservation_id, is_intent=True)

            print(f"[DEBUG SAFETY] read_operations_count={len(read_ops)}")
            print(f"[DEBUG SAFETY] device_report_chars={len(device_report)}")

            # create new user message with read real data, replace null with real data
            new_content = re.sub(r'<device_report>\s*null\s*</device_report>', f"<device_report>\n{device_report}\n</device_report>", latest_user_msg["content"], flags=re.IGNORECASE)
            new_user_msg = {"role": "user", "content": new_content}

            # add new user message to the global history
            history.append(new_user_msg)
                
            # update local history, send system message with real data and the latest user message
            current_turn_safety_history = [system_msg, new_user_msg]
           
    # autocorrection loop for Safety Check (max N iterations)
    for iteration in range(SAFETY_ITERATIONS):
        len_before = len(current_turn_safety_history)
        valid_output, reply = yield from consume_llm_stream_with_retries(current_turn_safety_history, agent_role, llm_model)
        reply_text = json.dumps(reply) if valid_output else str(reply)

        # synchronize failed validation tries in the main history
        for msg in current_turn_safety_history[len_before:]:
            if msg not in history:
                history.append(msg)

        if not valid_output:
            print(f"[DEBUG SERVER] FINAL FAILURE DETAILS (safety): {reply}")
            raise Exception("LLM failed to produce valid JSON after retries")

        history.append({"role": "assistant", "content": reply_text})

        # add LLM response in local memory of the loop
        current_turn_safety_history.append({"role": "assistant", "content": reply_text})

        # check if there are questions or if the plan is aproved o rejected
        status = str(reply.get("status", "")).upper()
        questions = reply.get("clarifying_questions", [])
        issues_found = reply.get("issues", [])
        issues_text = "\n".join([f"- {issue}" for issue in issues_found])

        is_approved = "APPROVED" in status
        is_awaiting_info = "AWAITING_CLARIFICATIONS" in status

        has_questions = isinstance(questions, list) and len(questions) > 0
    
        # exit the loop if approved or has questions for the user or iterations are completed
        if is_approved or is_awaiting_info or has_questions or iteration == SAFETY_ITERATIONS - 1:
            return reply

        # if the plan is not approved and the iterations are not ended, send an update of the current iteration to show in the frontend
        yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Auto-correcting plan, iteration {iteration+1}...]\n\n'})}\n\n"
        
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

    return reply


def handle_chat_logic(username, reservation_id, chat_id, agent_role, message, llm_model, files=None, is_manual_chat=False):
    # if there is no chat_id, it means the user is starting a new chat. We generate one.
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"          # added timestamp to guarantee chronological order of messages

    session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"

    # retrieve history from Redis
    history_str = redis_client.get(session_key)
    if history_str:
        history = json.loads(history_str)
    else:
        # create first message that includes the system prompt, dynamic rules for device kinds if present and the topology
        system_prompt = AGENT_PROMPTS.get(agent_role)

        dynamic_rules = get_dynamic_device_rules(agent_role)
        if dynamic_rules:
            system_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

        # add reserved devices constraint list to the system prompt
        system_prompt += get_reserved_devices(reservation_id)

        # add fobidden rules instructions for safety agent
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

    # add user message if present
    if user_content.strip():
        history.append({"role": "user", "content": user_content})

    try:
        
        # extract system prompt (index 0) from the history and last user message
        system_msg = history[0] 
        latest_user_msg = {"role": "user", "content": user_content} if user_content.strip() else None

        if agent_role == "safety":
            # for safety start the autocorrection loop
            reply = yield from handle_safety_loop(history, system_msg, latest_user_msg, reservation_id, agent_role, llm_model, is_manual_chat)
            
        else:
            # for planning and execution we use a minimal array. Negotiation use all the history.
            if agent_role in ["planning", "execution"]:
                llm_history = [system_msg]
                if latest_user_msg:
                    llm_history.append(latest_user_msg)
            else:
                llm_history = history 

            # send request to the LLM
            valid_output, reply = yield from consume_llm_stream_with_retries(llm_history, agent_role, llm_model)
            
            if not valid_output:
                print(f"[DEBUG SERVER] FINAL FAILURE DETAILS (safety): {reply}")
                raise Exception("LLM failed to produce valid JSON after retries")
           
            # add response to history and save it back to Redis
            history.append({"role": "assistant", "content": json.dumps(reply)})    

        current_time = time.time()
        for msg in history:
            # assign timestamp to a message
            if "timestamp" not in msg:
                msg["timestamp"] = current_time
                # add a millisecond to guarantee that messages created in the same time are sequentially ordered
                current_time += 0.001       

        # save updated history to Redis (expiration set to 5 days as security, when the reservation ends, the key is automatically removed)
        redis_client.set(session_key, json.dumps(history), ex=432000)
        
        return reply, chat_id
    except Exception as e:
        raise e

# call client function to send request to the llm and receive the reasoning in stream mode and the real output
def consume_llm_stream_with_retries(llm_history, role, llm_model):
        print(f"[DEBUG SSE] Start stream for: {role} (Max Retries: {JSON_RETRIES})")

        local_history = llm_history.copy()

        # json output validation iterations
        for attempt in range(JSON_RETRIES):
            print(f"[DEBUG SSE] --- Attempt {attempt + 1}/{JSON_RETRIES} ---")
            full_json_str = ""
            stream_error = None
        
            try:
                # until the request has been entirely processed call the stream function in the client
                for chunk in chat_with_llm_stream(local_history, llm_model):
                    
                    if chunk["type"] == "thought":
                        # instantly send the reasoning to show in the user interface
                        yield f"data: {json.dumps({'type': 'thought', 'content': chunk['content']})}\n\n"
                    
                    elif chunk["type"] == "content":
                        # collect the real output without sending to the client
                        full_json_str += chunk["content"]

                    elif chunk["type"] == "error":
                        stream_error = chunk["content"]

                # when the response is processed, get the entire json and remove possible characters like ```json between curly brackets
                clean_json_str = full_json_str
                json_match = re.search(r'```(?:json)?\s*(\{.*\})\s*```', full_json_str, re.DOTALL)

                # maintain only real json content
                if json_match:
                    clean_json_str = json_match.group(1)
                else:
                    # manually retried json content frmnthe output if it does not match
                    start = full_json_str.find('{')
                    end = full_json_str.rfind('}')
                    if start != -1 and end != -1 and end > start:
                        clean_json_str = full_json_str[start:end+1]

                print(f"[DEBUG SSE] Stream completed. Start JSON validation.")

                is_valid = False
                parsed_data_or_error = None

                if stream_error:
                    is_valid = False
                    parsed_data_or_error = f"System/API issue: {stream_error}"
                else:
                    # validate the entire json
                    is_valid, parsed_data_or_error = validate_json_format(clean_json_str, role)

                if is_valid:
                    print(f"[DEBUG SSE] Valid json at attempt {attempt + 1}.")
                    return (True, parsed_data_or_error)

                print(f"[DEBUG SSE] Failed validation at attempt {attempt + 1}. Error: {parsed_data_or_error}")
                
                if attempt < JSON_RETRIES - 1:
                    # inform the user that the model will think again for the same phase due to an error
                    yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: JSON validation faled. Autocorrection attempt {attempt+2}/{JSON_RETRIES} in progress...]\n\n'})}\n\n"
                    
                    # update local history so that the LLM can autocorrect in the next loop iteration
                    local_history.append({"role": "assistant", "content": full_json_str})
                    local_history.append({
                        "role": "user", 
                        "content": f"Your previous response failed because of an error: {parsed_data_or_error}. You MUST NOT return an empty or truncated response. Please generate a new complete response in valid JSON following the mandatory structure."
                    })

            except Exception as stream_err:
                print(f"[DEBUG SSE] Error during stream process: {stream_err}")
                return (False, {"error": str(stream_err)})

        print(f"[DEBUG SSE] Maximum number of attempts reached.")
        return (False, {"error": "Max JSON retries reached."})

# manage troubleshooter flow with streaming of reasoning
def generate_diagnostic_assistant_sse(history, request_data):
    print("[DEBUG SSE] Start SSE generator...")

    reservation_id = request_data['reservation_id']
    chat_id = request_data['chat_id']
    message = request_data['message']
    llm_model = request_data['llm_model']
    current_phase = request_data['current_phase']
    context = request_data['context']
    execution_report = request_data['execution_report']
    safe_commands = request_data['safe_commands']
    approved_commands = request_data['approved_commands']
    session_key = request_data['session_key']    

    # context to call the database
    with app.app_context():
        
        try:
            if current_phase == "diagnostic_intent":
                # find the index of the last generated summary
                last_summary_idx = -1
                for i in range(len(history) - 1, -1, -1):
                    if history[i].get("role") == "summary":
                        last_summary_idx = i
                        break

                # first message after last summary
                start_idx = last_summary_idx + 1 if last_summary_idx != -1 else 1
                # number of user messages since last summary
                user_msg_count = sum(1 for m in history[start_idx:] if m.get("role") == "user")

                # if the limit is surpassed, generate a new summary
                if user_msg_count >= MAX_DIAGNOSTIC_ASSISTANT_MESSAGES:
                    summarizer_sys_prompt = DIAGNOSTIC_ASSISTANT_PROMPTS["diagnostic_summarizer"]
                    summarizer_history = [{"role": "system", "content": summarizer_sys_prompt}]

                    # send to summarizer the last generated summary if exists
                    if last_summary_idx != -1:
                        summarizer_history.append({"role": "system", "content": f"<previous_chat_summary>\n{history[last_summary_idx]['content']}\n</previous_chat_summary>"})

                        # add every message after the last summary, except execution_log type messages
                    for m in history[start_idx:]:
                        if m.get("role") != "execution_log":
                            summarizer_history.append(m)

                    # add a temporary message to instruct summarizer to create the summary (the agent return with stop error if the last message is a system message)
                    summarizer_history.append({"role": "user", "content": "Please generate the JSON summary of the conversation above based exactly on your system instructions."})
                    
                    is_valid_sum, _, summary_json = get_validated_llm_reply(summarizer_history, "diagnostic_summarizer", llm_model)

                    if is_valid_sum:
                        # append summary in the history
                        history.append({"role": "summary", "content": summary_json.get("summary", "")})
                        print("[DEBUG] Chat limit reached. New summary appended to global history.")

                        # update indexes
                        last_summary_idx = len(history) - 1
                        start_idx = last_summary_idx + 1

                # append user message
                history.append({"role": "user", "content": message})

                # create active window to send to the intent agent, send the summary as temporary system message, in redis is saved as summary message to retrieve easily the last summary
                active_window = [history[0]]
                if last_summary_idx != -1:
                    active_window.append({"role": "system", "content": f"<previous_chat_summary>\n{history[last_summary_idx]['content']}\n</previous_chat_summary>"})

                # add messages from the last summary to the end of the history
                active_window.extend(history[start_idx:])

                # filter execution_log messages
                intent_history = [m for m in active_window if m.get("role") != "execution_log"]

                # Intent agent
                is_valid, intent_json = yield from consume_llm_stream_with_retries(intent_history, "diagnostic_intent", llm_model)
                if not is_valid:
                    print("[DEBUG SSE] Intent validation failed")
                    yield f"data: {json.dumps({'type': 'result', 'data': {'error': 'Failed intent evaluation'}})}\n\n"
                    return

                status = intent_json.get("status", "").upper()
                response_msg = intent_json.get("response", "")
                next_context = intent_json.get("context", "")
                print(f"[DEBUG SSE] Intent Status: {status}")

                if status == "REJECTED":
                    history.append({"role": "assistant", "content": response_msg})
                    redis_client.set(session_key, json.dumps(history), ex=432000)
                    yield f"data: {json.dumps({'type': 'result', 'data': {'reply': response_msg, 'chat_id': chat_id, 'requires_approval': False, 'next_phase': None}})}\n\n"
                else:
                    redis_client.set(session_key, json.dumps(history), ex=432000)
                    yield f"data: {json.dumps({'type': 'result', 'data': {'chat_id': chat_id, 'requires_approval': False, 'context': next_context, 'next_phase': 'diagnostic_planner'}})}\n\n"


            elif current_phase == "diagnostic_planner":
                planner_sys_prompt = DIAGNOSTIC_ASSISTANT_PROMPTS["diagnostic_planner"]
                dynamic_rules = get_dynamic_device_rules("diagnostic_planner")

                if dynamic_rules: 
                    planner_sys_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

                planner_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

                # add reserved devices constraint list
                planner_sys_prompt += get_reserved_devices(reservation_id)
                
                # Planner agent
                planner_history = [{"role": "system", "content": planner_sys_prompt}, {"role": "user", "content": f"<context>\n{context}\n</context>"}]

                is_valid, planner_json = yield from consume_llm_stream_with_retries(planner_history, "diagnostic_planner", llm_model)
                if not is_valid:
                    yield f"data: {json.dumps({'type': 'result', 'data': {'error': 'Failed planner evaluation'}})}\n\n"
                    return

                diag_cmds = planner_json.get("diagnostic_commands", [])
                approve_cmds = planner_json.get("commands_to_approve", [])
                safe_cmds = []
                pending_cmds = approve_cmds.copy()
                
                print(f"[DEBUG SSE] Planner ended. Safe commands: {len(diag_cmds)}, Commands to approve: {len(approve_cmds)}")

                for cmd_str in diag_cmds:
                    if ":" in cmd_str:
                        dev, cmd = cmd_str.split(":", 1)
                        if is_command_whitelisted(cmd): safe_cmds.append(cmd_str)
                        else: pending_cmds.append(cmd_str)

                if pending_cmds:
                    # ask approval to the frontend
                    # return context and chat_id so that the fontend resend this data
                    yield f"data: {json.dumps({'type': 'result', 'data': {'chat_id': chat_id, 'requires_approval': True, 'commands': pending_cmds, 'safe_commands': safe_cmds, 'context': context, 'next_phase': 'execution'}})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'result', 'data': {'chat_id': chat_id, 'requires_approval': False, 'safe_commands': safe_cmds, 'context': context, 'next_phase': 'execution'}})}\n\n"


            elif current_phase == "execution":
                raw_commands_to_run = safe_commands + approved_commands
                commands_to_run = []

                # add count or timeout to possible infinite read commands, read only last 50 raws of log files
                for cmd_str in raw_commands_to_run:
                    if ":" in cmd_str:
                        dev, cmd = cmd_str.split(":", 1)
                        cmd = cmd.strip()
                        if cmd.startswith("ping ") and "-c" not in cmd:
                            cmd = cmd.replace("ping ", "ping -c 4 ", 1)
                        elif (cmd.startswith("iperf ") or cmd.startswith("iperf3 ")) and "-t" not in cmd:
                            cmd = cmd.replace("iperf", "iperf -t 10", 1)
                        elif "tcpdump" in cmd and "timeout" not in cmd:
                            cmd = f"timeout 10 {cmd}"
                        elif cmd.startswith("cat /var/log/"):
                            cmd = cmd.replace("cat ", "tail -n 50 ", 1)
                        commands_to_run.append(f"{dev}: {cmd}")
                    else:
                        commands_to_run.append(cmd_str)
                
                if not commands_to_run:
                    exec_report = "[SYSTEM LOG]: The user rejected all proposed commands. No read operations were performed. Inform the user that you cannot complete the analysis without executing the commands, and ask them to try again or rephrase their request."
                else:
                    base_dir = os.path.dirname(os.path.abspath(__file__))
                    inventory_path = os.path.abspath(os.path.join(base_dir, "..", "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
                    
                    exec_report = run_parallel_commands(inventory_path, commands_to_run, reservation_id, is_intent=False)

                yield f"data: {json.dumps({'type': 'result', 'data': {'chat_id': chat_id, 'requires_approval': False, 'execution_report': exec_report, 'context': context, 'next_phase': 'diagnostic_reporter'}})}\n\n"


            elif current_phase == "diagnostic_reporter":
                reporter_sys_prompt = DIAGNOSTIC_ASSISTANT_PROMPTS["diagnostic_reporter"]
                reporter_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"
                
                # Reporter agent
                reporter_history = [{"role": "system", "content": reporter_sys_prompt}, {"role": "user", "content": f"<context>\n{context}\n</context>\n<execution_report>\n{execution_report}\n</execution_report>"}]
            
                is_valid, reporter_json = yield from consume_llm_stream_with_retries(reporter_history, "diagnostic_reporter", llm_model)
                if not is_valid:
                    yield f"data: {json.dumps({'type': 'result', 'data': {'error': 'Failed reporter evaluation'}})}\n\n"
                    return

                final_response = reporter_json.get("response", "Error during report generation")

                # save execution log (hidden from the user) and final message in the chat visible by user
                history.append({"role": "execution_log", "content": execution_report})
                history.append({"role": "assistant", "content": final_response})
                redis_client.set(session_key, json.dumps(history), ex=432000)

                yield f"data: {json.dumps({'type': 'result', 'data': {'reply': final_response, 'chat_id': chat_id, 'requires_approval': False, 'execution_log': execution_report, 'next_phase': None}})}\n\n"

        except Exception as e:
            print(f"\n[DEBUG SSE] Exception in SSE generator: {str(e)}")
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'result', 'data': {'error': str(e)}})}\n\n"
        
        print("[DEBUG SSE] SSE generator ended \n" + "="*50)


# reads the reserved devices YAML file and formats it for the LLM prompt
def get_reserved_devices(reservation_id: str) -> str:
  
    base_dir = os.path.dirname(os.path.abspath(__file__))
    yaml_path = os.path.join(base_dir, "reservation_devices", f"res_{reservation_id}_devices.yaml")
    
    try:
        with open(yaml_path, "r", encoding="utf-8") as f:
            content = f.read()
        return f"\n<reserved_devices>\n```yaml\n{content}```\n</reserved_devices>\n"
    except FileNotFoundError:
        print(f"[WARNING] Reserved devices file not found at {yaml_path}")
        return "\n<reserved_devices>\n# No reserved devices info found\n</reserved_devices>\n"
    except Exception as e:
        print(f"[ERROR] Failed to read reserved devices file: {e}")
        return ""