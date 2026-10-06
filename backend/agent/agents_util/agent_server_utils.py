import json
import redis
import os
import re
import yaml
import paramiko
import socket
import threading
import traceback
import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from ..llm_client import chat_with_llm, chat_with_llm_stream
from .prompts import ALLOWED_DIAGNOSTIC_COMMANDS, DEVICE_KIND_RULES, READ_INTENTS, DIAGNOSTIC_ASSISTANT_PROMPTS
from ...config import REDIS_HOST, REDIS_PORT, REDIS_DB, CONTAINERLAB_HOST, CONTAINERLAB_HOST_USER, JSON_RETRIES, MAX_DIAGNOSTIC_ASSISTANT_MESSAGES, BACKEND_LLM_PREVENTION_MINUTES, PHASES_ORDER, DIAGNOSTIC_ASSISTANT_PHASES_ORDER
from ...utils import get_is_virtual_from_db, parse_complete_inventory_hosts, get_remaining_minutes

# redis store for conversation history, keyed by username and reservation_id
redis_client = redis.Redis(
    host=REDIS_HOST, 
    port=REDIS_PORT, 
    db=REDIS_DB, 
    decode_responses=True   # automatically decodes bytes in strings
)

def get_testbed_topology(reservation_id=None) -> str:
    base_dir = os.path.dirname(__file__)
    
    if reservation_id:
        is_virtual = get_is_virtual_from_db(reservation_id)
    else:
        # if reservation_id not exists use virtual topology
        is_virtual = True
        
    filename = "containerlab_topology_plain.yaml" if is_virtual else "physical_topology_plain.yaml"
    topology_file_path = os.path.join(base_dir, filename)
    
    try:
        with open(topology_file_path, "r") as topo_file:
            return topo_file.read()
    except FileNotFoundError:
        print(f"Warning: Could not find {topology_file_path}")
        return "# Topology file not found"

# lock for thread-safe logging and for mutually exclusive LLM printing for parallel agents
log_lock = threading.Lock()

def log_agent_reasoning(agent_role, reasoning):
    if not reasoning.strip():
        return
    
    # go from backend/agent/agents_util to execution_logs
    base_dir = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.abspath(os.path.join(base_dir, "..", "..", "..", "execution_logs"))
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "log_agents_reasoning.txt")

    log_entry = ""

    # check if the agent is the forst of the pipeline, in that case print the timestamp
    if agent_role == PHASES_ORDER[0] or agent_role == DIAGNOSTIC_ASSISTANT_PHASES_ORDER[0]:
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_entry += f"[{timestamp}]\n"
        log_entry += f"==================================================\n"

    # print always agent name and reasoning content
    log_entry += f"Agent: {agent_role}\n"
    log_entry += f"{reasoning.strip()}\n"
    log_entry += f"==================================================\n\n"
    
    # use log_lock to avoid race conditions
    with log_lock:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(log_entry)

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

def get_dynamic_device_rules(agent_role: str, reservation_id: str = None) -> str:
    
    testbed_topology = get_testbed_topology(reservation_id)
    # extracts device kinds from the topology and retrieve rules for the current agent
    kinds_in_topo = set()
    try:
        # topology parsing
        topo_dict = yaml.safe_load(testbed_topology) or {}
        nodes = topo_dict.get("topology", {}).get("nodes", {})
        
        # extract unique nodes
        for node_info in nodes.values():
            if isinstance(node_info, dict) and "kind" in node_info:
                # extract only the base kind before any spaces or parentheses
                raw_kind = str(node_info["kind"])
                base_kind = raw_kind.split()[0].strip()
                kinds_in_topo.add(base_kind)

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

def redis_stream_generator(chat_id):
    # generator that subscribes to redis and send SSE events to HTTP client 
    
    pubsub = redis_client.pubsub()
    channel = f"channel:chat_{chat_id}"
    pubsub.subscribe(channel)
    
    try:
        for msg in pubsub.listen():
            if msg['type'] == 'message':
                data = msg['data']
                # when worker signals EOF, close the HTTP connection
                if data == "EOF":
                    break
                # forward the raw string (already formatted as SSE) to the client
                yield data
    finally:
        # unsubscribe to channel 
        pubsub.unsubscribe(channel)
        pubsub.close()

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

    testbed_topology = get_testbed_topology(reservation_id)
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


def run_deterministic_safety_checks(exec_plan, verif_plan, topology_yaml, reserved_devices_xml):
    # executes deterministic safety checks on the proposed execution and verification plans
   
    issues = []
    
    # parse the YAML topology to map device names to their specific kinds (e.g., "sonic-vs", "linux")
    try:
        topo_dict = yaml.safe_load(topology_yaml) or {}
        nodes = topo_dict.get("topology", {}).get("nodes", {})
        node_kinds = {}
        for node, data in nodes.items():
            raw_kind = str(data.get("kind", "")).lower()
            base_kind = re.split(r'[\s\(]', raw_kind)[0].strip()
            node_kinds[str(node)] = base_kind
    except Exception as e:
        print(f"[ERROR] Failed to parse topology for deterministic checks: {e}")
        node_kinds = {}

    # extract the raw list of reserved devices from the formatted XML/YAML string
    try:
        # strip XML tags and markdown blocks to parse the raw YAML
        clean_yaml = re.sub(r'<[^>]+>|```yaml|```', '', reserved_devices_xml).strip()
        reserved_devs = yaml.safe_load(clean_yaml) or {}
        if isinstance(reserved_devs, dict):
            reserved_list = list(reserved_devs.keys())
        elif isinstance(reserved_devs, list):
            reserved_list = reserved_devs
        else:
            reserved_list = []
    except Exception as e:
        print(f"[ERROR] Failed to parse reserved devices: {e}")
        reserved_list = []

    # combine both plans, keeping track of whether a command is a verification command
    all_cmds = [(cmd, False) for cmd in exec_plan] + [(cmd, True) for cmd in verif_plan]
    
    has_routing_config = False
    has_sleep = False

    for item_str, is_verif in all_cmds:
        if ":" not in item_str:
            continue
        
        device, cmd = item_str.split(":", 1)
        device = device.strip()
        cmd = cmd.strip()
        kind = node_kinds.get(device, "")

        # RESERVATION BOUNDARY & TOPOLOGY MAPPING
        if device not in node_kinds:
            issues.append(f"[{device}]: Hallucinated device. This device does not exist in the topology.")
            continue
        if reserved_list and device not in reserved_list:
            issues.append(f"[{device}]: Target device is NOT in the reserved_devices list. Access is forbidden.")
            
        # BOUNDED PROCESSES CHECK (Time Limits & Counts)
        # check ping without -c flag
        if re.search(r'\bping\b', cmd) and not re.search(r'-c\s+\d+', cmd):
            issues.append(f"[{device}]: Command '{cmd}' runs indefinitely. Add '-c' flag to limit ping count.")
        #cCheck iperf without time (-t) or bytes (-n) limits
        if re.search(r'\biperf3?\b', cmd) and not re.search(r'-[tn]\s+\d+', cmd):
            issues.append(f"[{device}]: Command '{cmd}' runs indefinitely. Add '-t' or '-n' flag to iperf.")
        # check tcpdump without timeout wrapper or native limit flags (-G, -W, -c)
        if re.search(r'\btcpdump\b', cmd) and not (cmd.startswith('timeout') or re.search(r'-[GWc]', cmd)):
            issues.append(f"[{device}]: Command '{cmd}' runs indefinitely. Wrap the command with 'timeout X'.")
            
        # track routing protocols and sleep commands for Convergence Check
        if re.search(r'\brouter\s+(ospf|bgp)\b', cmd):
            has_routing_config = True
        if re.search(r'\bsleep\s+\d+', cmd):
            has_sleep = True

        # FORBIDDEN_RULES CHECK
        if re.search(r'\beth0\b', cmd):
            issues.append(f"[{device}]: Modifying the management interface (eth0) is strictly forbidden. Command: '{cmd}'.")
        if "erase startup-config" in cmd or "write erase" in cmd:
            issues.append(f"[{device}]: Factory reset commands are forbidden.")
        if re.search(r'\b(passwd|useradd|usermod|deluser)\b', cmd):
            issues.append(f"[{device}]: Modifying system users or passwords is forbidden.")
        if "docker exec" in cmd:
            issues.append(f"[{device}]: Host-level docker management commands are forbidden.")

        # DEVICE_KIND_RULES SPECIFIC (for sonic-vs)
        if kind == "sonic-vs":
            # forbid sonic-cli usage
            if re.search(r'\bsonic-cli\b', cmd):
                issues.append(f"[{device}]: The 'sonic-cli' command is forbidden in this container. Use native Linux or vtysh.")
            # forbid alias names like Ethernet0, Ethernet4
            if re.search(r'\bEthernet\d+\b', cmd, re.IGNORECASE):
                issues.append(f"[{device}]: Invalid interface name in '{cmd}'. Use native Linux names (e.g., eth1) exactly as in the topology.")
            # configuration split: forbid IP or Link state changes inside vtysh
            if "vtysh" in cmd and re.search(r"-c\s+['\"].*(ip\s+address|shutdown|no\s+shutdown)", cmd, re.IGNORECASE):
                issues.append(f"[{device}]: Critical violation. IP assignment and link state toggling MUST be done using native Linux bash commands, NOT inside vtysh.")
            # verification: prevent empty outputs by forcing address family in BGP show commands
            if is_verif and "vtysh" in cmd and re.search(r"show\s+(ip\s+)?bgp\b", cmd) and not re.search(r"ipv[46]", cmd):
                issues.append(f"[{device}]: Generic 'show bgp' is not allowed in verification. Use specific address family (e.g., 'show bgp ipv4 unicast').")

    # TIMING & CONVERGENCE CHECK (Global)
    if has_routing_config and not has_sleep:
        issues.append("[Global]: Routing protocols (BGP/OSPF) are being configured, but a 'sleep' command is missing before verification. Please inject a 'device: sleep X' command.")

    return issues

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
            if not all(k in data for k in ["summary", "topology_diagram", "clarifying_questions", "status", "context_for_planning", "execution_mode"]):
                return False, "Missing keys. Required: summary, topology_diagram, clarifying_questions, status, context_for_planning, execution_mode"
            
            if not isinstance(data.get("exit_conditions"), list):
                return False, "exit_conditions must be a JSON array"
        
        if agent_role == "planning":
            if not all(k in data for k in ["execution_plan", "verification", "status"]):
                return False, "Missing keys. Required: execution_plan, verification, status"

            for list_key in ["execution_plan", "verification"]:
                if not isinstance(data.get(list_key), list):
                    return False, f"{list_key} must be a JSON array"
        
        if agent_role == "safety":
            if not all(k in data for k in ["status", "issues", "topology_mapping_check", "executable_plan", "verification_plan", "clarifying_questions", "read_operations"]):
                return False, "Missing keys. Required: status, issues, topology_mapping_check, executable_plan, clarifying_questions, read_operations"
            
            for list_key in ["read_operations", "issues", "topology_mapping_check", "executable_plan", "verification_plan", "clarifying_questions"]:
                if not isinstance(data.get(list_key), list):
                    return False, f"{list_key} must be a JSON array"
        
        if agent_role == "safety_agent_1":
            if not all(k in data for k in ["status", "read_operations", "clarifying_questions", "additional_context"]):
                return False, "Missing keys. Required: status, read_operations, clarifying_questions, additional_context"
            
            for list_key in ["read_operations", "clarifying_questions"]:
                if not isinstance(data.get(list_key), list):
                    return False, f"{list_key} must be a JSON array"
                
        if agent_role in ["safety_agent_2", "safety_agent_3", "safety_agent_4"]:
            if not all(k in data for k in ["status", "issues"]):
                return False, "Missing keys. Required: status, issues"
            if not isinstance(data.get("issues"), list):
                return False, "issues must be a JSON array"

        if agent_role == "safety_agent_5":
            if not all(k in data for k in ["status", "executable_plan", "verification_plan", "clarifying_questions"]):
                return False, "Missing keys. Required: status, executable_plan, verification_plan, clarifying_questions"
            
            for list_key in ["executable_plan", "verification_plan", "clarifying_questions"]:
                if not isinstance(data.get(list_key), list):
                    return False, f"{list_key} must be a JSON array"
            
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

def get_validated_llm_reply(history, agent_role, llm_model, reservation_id):
    local_history = history.copy()
    last_failure_reason = None

    for attempt in range(1, JSON_RETRIES + 1):
        minutes_left = get_remaining_minutes(reservation_id)
        if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
            error_msg = f"Operation blocked: Less than {BACKEND_LLM_PREVENTION_MINUTES} minutes remaining before reservation ends."
            print(error_msg)
            return False, None, {"error_type": "timeout", "reason": error_msg}
            

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

def extract_xml_tag(text, tag):
    # helper to extract content from XML-like tags in the user message
    match = re.search(f'<{tag}>(.*?)</{tag}>', text, flags=re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else ""

def delete_agent_history_keys(username, reservation_id, chat_id=None, role_prefix="*"):
    # removes every Redis key matching the agent_history pattern
    user_part = username if username else "*"
    chat_part = chat_id if chat_id else "*"
    pattern = f"agent_history:{role_prefix}:{user_part}:{reservation_id}:{chat_part}"

    keys = redis_client.keys(pattern)
    if keys:
        redis_client.delete(*keys) # remove all keys matching the pattern
        
    return len(keys)

def drain_generator(gen):
    # generic adapter: fully drives ANY generator to completion, discarding every value it yields, and returns its final return value 
    try:
        while True:
            next(gen)
    except StopIteration as e:
        return e.value

# call client function to send request to the llm and receive the reasoning in stream mode and the real output
def consume_llm_stream_with_retries(llm_history, role, llm_model, reservation_id):
        print(f"[DEBUG SSE] Start stream for: {role} (Max Retries: {JSON_RETRIES})")

        local_history = llm_history.copy()

        # json output validation iterations
        for attempt in range(JSON_RETRIES):
            minutes_left = get_remaining_minutes(reservation_id)
            if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
                print ("Operation stopped in consume llm stream function")
                raise Exception(f"Operation blocked: Less than {BACKEND_LLM_PREVENTION_MINUTES} minutes remaining before reservation ends.")
            
            print(f"[DEBUG SSE] --- Attempt {attempt + 1}/{JSON_RETRIES} ---")
            full_json_str = ""
            full_thought_str = ""
            stream_error = None
        
            try:
                # until the request has been entirely processed call the stream function in the client
                for chunk in chat_with_llm_stream(local_history, llm_model):
                    
                    if chunk["type"] == "thought":
                        full_thought_str += chunk["content"]
                        # instantly send the reasoning to show in the user interface
                        yield f"data: {json.dumps({'type': 'thought', 'content': chunk['content']})}\n\n"
                    
                    elif chunk["type"] == "content":
                        # collect the real output without sending to the client
                        full_json_str += chunk["content"]

                    elif chunk["type"] == "error":
                        stream_error = chunk["content"]

                if full_thought_str.strip():
                    # write the entire reasoning in the log file
                    log_agent_reasoning(role, full_thought_str)

                with log_lock:
                    print("\n" + "=" * 70)
                    print(f"Agent: {role} (attempt {attempt + 1}/{JSON_RETRIES})")
                    print(f"\n[DEBUG LLM] RAW OUTPUT:\n{full_json_str}")

                    if stream_error:
                        print(f"[DEBUG LLM] STREAM ERROR: {stream_error}")

                    print("=" * 70 + "\n")

                # when the response is processed, get the entire json and remove possible characters like ```json between curly brackets
                clean_json_str = full_json_str
                json_match = re.search(r'```(?:json)?\s*(\{.*\})\s*```', full_json_str, re.DOTALL)

                # maintain only real json content
                if json_match:
                    clean_json_str = json_match.group(1)
                else:
                    # manually retried json content from the output if it does not match
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

                # check for length error
                is_length_error = bool(stream_error) and any(kw in str(stream_error).lower() for kw in ("length", "max_tokens", "max token"))
                
                if attempt < JSON_RETRIES - 1:
                    # inform the user that the model will think again for the same phase due to an error
                    yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: JSON validation failed. Autocorrection attempt {attempt+2}/{JSON_RETRIES} in progress...]\n\n'})}\n\n"

                    # update local history so that the LLM can autocorrect in the next loop iteration
                    local_history.append({"role": "assistant", "content": full_json_str})

                    if is_length_error:
                        # restart with the following context: system prompt + last user message
                        correction_content = "Your previous response ran out of tokens during reasoning before producing any JSON output. Answer directly and concisely: do not enumerate optional or already-covered checks, and output the required JSON object now."
                        
                    else:
                        correction_content = f"Your previous response failed because of an error: {parsed_data_or_error}. You MUST NOT return an empty or truncated response. Please generate a new complete response in valid JSON following the mandatory structure."
                        
                    local_history.append({"role": "user", "content": correction_content})

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

                # add every message after the last summary, except execution_log type messages (messages with the output of reading commands)
                for m in history[start_idx:]:
                    if m.get("role") != "execution_log":
                        summarizer_history.append(m)

                # add a temporary message to instruct summarizer to create the summary (the agent return with stop error if the last message is a system message)
                summarizer_history.append({"role": "user", "content": "Please generate the JSON summary of the conversation above based exactly on your system instructions."})
                
                is_valid_sum, _, summary_json = get_validated_llm_reply(summarizer_history, "diagnostic_summarizer", llm_model, reservation_id)

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
            is_valid, intent_json = yield from consume_llm_stream_with_retries(intent_history, "diagnostic_intent", llm_model, reservation_id)
            if not is_valid:
                print("[DEBUG SSE] Intent validation failed")
                yield f"data: {json.dumps({'type': 'result', 'data': {'error': 'Failed intent evaluation'}})}\n\n"
                return

            status = intent_json.get("status", "").upper()
            response_msg = intent_json.get("response", "")
            next_context = intent_json.get("context", "")
            print(f"[DEBUG SSE] Intent Status: {status}")

            if status in ["REJECTED", "PROMPT_GENERATED"]:
                history.append({"role": "assistant", "content": response_msg})
                redis_client.set(session_key, json.dumps(history), ex=432000)
                yield f"data: {json.dumps({'type': 'result', 'data': {'reply': response_msg, 'chat_id': chat_id, 'requires_approval': False, 'next_phase': None}})}\n\n"
            else:
                redis_client.set(session_key, json.dumps(history), ex=432000)
                yield f"data: {json.dumps({'type': 'result', 'data': {'chat_id': chat_id, 'requires_approval': False, 'context': next_context, 'next_phase': 'diagnostic_planner'}})}\n\n"

        elif current_phase == "diagnostic_planner":
            testbed_topology = get_testbed_topology(reservation_id)
            planner_sys_prompt = DIAGNOSTIC_ASSISTANT_PROMPTS["diagnostic_planner"]
            dynamic_rules = get_dynamic_device_rules("diagnostic_planner", reservation_id)

            if dynamic_rules: 
                planner_sys_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

            planner_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

            # add reserved devices constraint list
            planner_sys_prompt += get_reserved_devices(reservation_id)
            
            # Planner agent
            planner_history = [{"role": "system", "content": planner_sys_prompt}, {"role": "user", "content": f"<context>\n{context}\n</context>"}]

            is_valid, planner_json = yield from consume_llm_stream_with_retries(planner_history, "diagnostic_planner", llm_model, reservation_id)
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
            testbed_topology = get_testbed_topology(reservation_id)
            reporter_sys_prompt = DIAGNOSTIC_ASSISTANT_PROMPTS["diagnostic_reporter"]
            
            dynamic_rules = get_dynamic_device_rules("diagnostic_reporter", reservation_id)
            if dynamic_rules:
                reporter_sys_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

            reporter_sys_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"
            
            # Reporter agent
            reporter_history = [{"role": "system", "content": reporter_sys_prompt}, {"role": "user", "content": f"<context>\n{context}\n</context>\n<execution_report>\n{execution_report}\n</execution_report>"}]
        
            is_valid, reporter_json = yield from consume_llm_stream_with_retries(reporter_history, "diagnostic_reporter", llm_model, reservation_id)
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