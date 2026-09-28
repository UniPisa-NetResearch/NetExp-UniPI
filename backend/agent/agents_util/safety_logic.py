import json
import re
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from ...config import SAFETY_ITERATIONS, BACKEND_LLM_PREVENTION_MINUTES, SAFETY_EXECUTION_MODE
from ...utils import get_remaining_minutes
from .prompts import AGENT_PROMPTS, FORBIDDEN_RULES
from ...app import app

from .agent_server_utils import (
    redis_client, log_lock, get_testbed_topology, get_dynamic_device_rules,
    get_reserved_devices, consume_llm_stream_with_retries, drain_generator, run_parallel_commands, 
    extract_xml_tag, run_deterministic_safety_checks
)

def execute_safety_phase(username, chat_id, latest_user_msg, reservation_id, llm_model, is_manual_chat=False):
    # dispatcher for different safety modes
    if SAFETY_EXECUTION_MODE == 1:
        reply = yield from handle_unified_safety_loop(username, chat_id, latest_user_msg, reservation_id, llm_model, is_manual_chat)
        return reply
    
    elif SAFETY_EXECUTION_MODE in [2, 3, 4, 5]:
        is_stateful = (SAFETY_EXECUTION_MODE in [3, 5])
        is_hybrid = (SAFETY_EXECUTION_MODE in [4, 5])
        reply = yield from handle_decomposed_safety_loop(username, chat_id, latest_user_msg, reservation_id, llm_model, is_manual_chat, is_stateful_agent_5=is_stateful, is_hybrid_mode=is_hybrid)

        # we save a fake entry for the main 'safety' key to maintain compatibility  with the React frontend history parser (so it shows the approved plan seamlessly)
        session_key_main = f"agent_history:safety:{username}:{reservation_id}:{chat_id}"
        hist_main_str = redis_client.get(session_key_main)
        hist_main = json.loads(hist_main_str) if hist_main_str else []
        
        if latest_user_msg: 
            hist_main.append(latest_user_msg)
        hist_main.append({"role": "assistant", "content": json.dumps(reply)})
    
        # add timestamps to safety messages to guarantee correct sorting in the frontend history
        current_time = time.time()
        for msg in hist_main:
            if "timestamp" not in msg:
                msg["timestamp"] = current_time
                current_time += 0.001
        
        redis_client.set(session_key_main, json.dumps(hist_main), ex=432000)

        return reply
    else:
        raise ValueError(f"Safety mode {SAFETY_EXECUTION_MODE} not valid")

def handle_decomposed_safety_loop(username, chat_id, latest_user_msg, reservation_id, llm_model, is_manual_chat=False, is_stateful_agent_5=False, is_hybrid_mode=False):
    # orchestrates the 5 specialized safety sub-agents
    user_content = latest_user_msg["content"] if latest_user_msg else ""
    
    # state of the current turn of safety persisted in redis
    turn_state_key = f"agent_history:safety_turn_state:{username}:{reservation_id}:{chat_id}"
    turn_state_str = redis_client.get(turn_state_key)

    # if there is a saved state, we use the saved fields
    if turn_state_str:
        turn_state = json.loads(turn_state_str)
        exp_context = turn_state["exp_context"]
        exit_conds = turn_state["exit_conds"]
        current_exec_plan = turn_state["exec_plan"]
        current_verif_cmds = turn_state["verif_cmds"]
        device_report = turn_state["device_report"]
    else:
        # if there is not saved state, parse the incoming context from the orchestrator string, first time we enter in safety phase from planning
        exp_context = extract_xml_tag(user_content, "experiment_context")
        exit_conds = extract_xml_tag(user_content, "exit_conditions")
        current_exec_plan = extract_xml_tag(user_content, "execution_plan")
        current_verif_cmds = extract_xml_tag(user_content, "verification_commands")
        device_report = extract_xml_tag(user_content, "device_report")
    
    def save_turn_state():
        # called every time any of the turn's fields legitimately changes to save the state in redis
        redis_client.set(turn_state_key, json.dumps({"exp_context": exp_context, "exit_conds": exit_conds, "exec_plan": current_exec_plan, "verif_cmds": current_verif_cmds, "device_report": device_report}), ex=432000)

    save_turn_state()

    testbed_topology = get_testbed_topology(reservation_id)

    # base context shared among agents
    base_prompt = (
        f"<experiment_context>\n{exp_context}\n</experiment_context>\n\n"
        f"<exit_conditions>\n{exit_conds}\n</exit_conditions>\n\n"
    )
    
    # Redis keys for agents that interact directly with user queries
    key_agent1 = f"agent_history:safety_agent_1:{username}:{reservation_id}:{chat_id}"
    key_agent5 = f"agent_history:safety_agent_5:{username}:{reservation_id}:{chat_id}"

    # manual instruction flow
    if is_manual_chat:
        manual_instruction = f"The user has provided this priority correction instruction: {user_content}. Modify the plan by applying this request."
        
        if is_hybrid_mode:
            sys_prompt_5 = AGENT_PROMPTS["safety_agent_5"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_dynamic_device_rules("safety_hybrid", reservation_id)
        else:
            sys_prompt_5 = AGENT_PROMPTS["safety_agent_5"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_dynamic_device_rules("safety", reservation_id)
        
        agent5_prompt = base_prompt + (
            f"<execution_plan>\n{current_exec_plan}\n</execution_plan>\n\n"
            f"<verification_commands>\n{current_verif_cmds}\n</verification_commands>\n\n"
            f"<device_report>\n{device_report}\n</device_report>\n\n"
            f"<issues>\n{manual_instruction}\n</issues>"
        )
        
        # stateless call for the current correction attempt, the request does not include previous iterations data
        call_history = [{"role": "system", "content": sys_prompt_5}, {"role": "user", "content": agent5_prompt}]
        
        yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Agent 5 applying manual instruction...]\n\n'})}\n\n"
        
        valid_output, reply5 = yield from consume_llm_stream_with_retries(call_history, "safety_agent_5", llm_model, reservation_id)
        if not valid_output: raise Exception("Agent 5 failed.")
        
        # update plans with agent 5 output before entering the validation loop
        current_exec_plan = "\n".join(reply5.get("executable_plan", []))
        current_verif_cmds = "\n".join(reply5.get("verification_plan", []))
        save_turn_state()
        
        # save agent 5 history
        prior_hist5_str = redis_client.get(key_agent5)
        # get previous history of agent 5 if exists
        prior_hist5 = json.loads(prior_hist5_str) if prior_hist5_str else []
        # append to the existing history the current call messages and the response from agent file, then save in redis
        debug_hist5 = prior_hist5 + call_history + [{"role": "assistant", "content": json.dumps(reply5)}]
        redis_client.set(key_agent5, json.dumps(debug_hist5), ex=432000)

    else:
        # agent 1: context and state reader
        hist1_str = redis_client.get(key_agent1)
        hist1 = json.loads(hist1_str) if hist1_str else []

        # look only at the very last message to see if we are answering a clarification
        is_answering_agent1 = False
        if hist1 and hist1[-1].get("role") == "assistant":
            try:
                last_parsed = json.loads(hist1[-1]["content"])
                if "AWAITING_CLARIFICATIONS" in str(last_parsed.get("status", "")).upper():
                    is_answering_agent1 = True
            except Exception: pass

        if is_answering_agent1:
            # continue agent 1's short local exchange with the user's answer, add the latest user message to the history
            hist1.append(latest_user_msg)
        else:
            # create a new conversation for agent 1
            sys_prompt_1 = AGENT_PROMPTS["safety_agent_1"] + f"\n<topology>\n{testbed_topology}\n</topology>\n"
            agent1_prompt = base_prompt + f"<execution_plan>\n{current_exec_plan}\n</execution_plan>\n\n<verification_commands>\n{current_verif_cmds}\n</verification_commands>"
            hist1 = [{"role": "system", "content": sys_prompt_1}, {"role": "user", "content": agent1_prompt}]

        valid_output, reply1 = yield from consume_llm_stream_with_retries(hist1, "safety_agent_1", llm_model, reservation_id)
        if not valid_output: raise Exception("Agent 1 failed.")
        
        # add agent 1 response to the history
        hist1.append({"role": "assistant", "content": json.dumps(reply1)})
        redis_client.set(key_agent1, json.dumps(hist1), ex=432000)

        if "AWAITING_CLARIFICATIONS" in str(reply1.get("status", "")).upper():
            return reply1 # pause and ask user if the agent ask for clarifications
            
        # update experiment context if agent 1 derived new insights from user's answers
        add_ctx = reply1.get("additional_context", "").strip()
        if add_ctx:
            exp_context += f"\n\n[Additional Context]: {add_ctx}"
            base_prompt = f"<experiment_context>\n{exp_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conds}\n</exit_conditions>\n\n"
            save_turn_state()

        # if coming from planning, report is null and we execute agent 1's read operations
        if device_report.strip().lower() == "null":
            read_ops = reply1.get("read_operations", [])
            yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Reading data from testbed devices...]\n\n'})}\n\n"
            
            base_dir = os.path.dirname(os.path.abspath(__file__))
            inventory_path = os.path.abspath(os.path.join(base_dir, "..", "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))
            
            # run commands on devices and replace the local "null" with actual live data for agents 2-5
            device_report = run_parallel_commands(inventory_path, read_ops, reservation_id, is_intent=True)
            save_turn_state()

    # validation loop (AGENTS 2, 3, 4 -> 5)
    all_issues = []
    for iteration in range(SAFETY_ITERATIONS):
        minutes_left = get_remaining_minutes(reservation_id)
        if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
            raise Exception(f"Operation stopped: Less than {BACKEND_LLM_PREVENTION_MINUTES} minutes remaining.")

        yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Agents 2, 3 and 4 are parallelly evaluating the plan (Iteration {iteration+1})...]\n\n'})}\n\n"

        python_issues = []
        if is_hybrid_mode:
            exec_list = [line.strip() for line in current_exec_plan.split('\n') if line.strip()]
            verif_list = [line.strip() for line in current_verif_cmds.split('\n') if line.strip()]
            print("Run deterministic checks\n")
            python_issues = run_deterministic_safety_checks(exec_list, verif_list, testbed_topology, get_reserved_devices(reservation_id))

        common_plan_prompt = base_prompt + f"<execution_plan>\n{current_exec_plan}\n</execution_plan>\n\n<verification_commands>\n{current_verif_cmds}\n</verification_commands>\n\n"

        if is_hybrid_mode:
            
            # create system prompt for the three agents
            sys2 = AGENT_PROMPTS["safety_agent_2_hybrid"] + f"\n<topology>\n{testbed_topology}\n</topology>\n"
            sys3 = AGENT_PROMPTS["safety_agent_3_hybrid"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_dynamic_device_rules("safety_agent_3_hybrid", reservation_id)
            sys4 = AGENT_PROMPTS["safety_agent_4_hybrid"] + f"\n<topology>\n{testbed_topology}\n</topology>\n"
    
            user_prompt2 = common_plan_prompt

            role2, role3, role4 = "safety_agent_2_hybrid", "safety_agent_3_hybrid", "safety_agent_4_hybrid"

        else:
            # format forbidden rules
            rules_formatted = "\n".join([f"- {rule}" for rule in FORBIDDEN_RULES])

            # create system prompt for the three agents
            sys2 = AGENT_PROMPTS["safety_agent_2"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_reserved_devices(reservation_id) + "\n" + get_dynamic_device_rules("safety_agent_2", reservation_id)
            sys3 = AGENT_PROMPTS["safety_agent_3"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_dynamic_device_rules("safety_agent_3", reservation_id)
            sys4 = AGENT_PROMPTS["safety_agent_4"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + f"\n<forbidden_rules>\n{rules_formatted}\n</forbidden_rules>"

            # add reserved devices to the prompt of agent 2 and device report to the prompt of agent 3
            user_prompt2 = common_plan_prompt + f"<reserved_devices>\n{get_reserved_devices(reservation_id)}\n</reserved_devices>"

            role2, role3, role4 = "safety_agent_2", "safety_agent_3", "safety_agent_4"

        user_prompt3 = common_plan_prompt + f"<device_report>\n{device_report}\n</device_report>"
        user_prompt4 = common_plan_prompt + f"<device_report>\n{device_report}\n</device_report>"

        def run_auditor(role, sys_prompt, user_content_str):
            # runs an auditor sequentially in its thread to avoid SSE/log mixing 
            # the actual call sent to the LLM is a 2-message array (system + user): agents 2/3/4 must never see previous iterations' attempts, to stay stateless and small 
            # the redis debug log keeps growing across iterations for admin visibility, and is written under a lock so parallel agents never interleave their reasoning in the shared log output
            with app.app_context():
                call_history = [{"role": "system", "content": sys_prompt}, {"role": "user", "content": user_content_str}]
                is_valid, parsed = drain_generator(consume_llm_stream_with_retries(call_history, role, llm_model, reservation_id))

                with log_lock:
                    print(f"\n[DEBUG SAFETY] Starting {role} reasoning...")
                    
                    # fetch history for admin debugger continuity
                    redis_key = f"agent_history:{role}:{username}:{reservation_id}:{chat_id}"
                    # get history of agents 2, 3, 4, if it does not exist, create a new one
                    hist_str = redis_client.get(redis_key)
                    debug_hist = json.loads(hist_str) if hist_str else []
                    # append current iteration prompt
                    debug_hist += call_history
                    # append current iteration agent response and save in redis
                    debug_hist.append({"role": "assistant", "content": json.dumps(parsed) if is_valid else str(parsed)})
                    redis_client.set(redis_key, json.dumps(debug_hist), ex=432000)
                
                # return found issues if present
                return parsed.get("issues", []) if is_valid and parsed else []

        # execute Agents 2, 3, 4 in parallel
        iteration_issues = []
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(run_auditor, role2, sys2, user_prompt2): role2,
                executor.submit(run_auditor, role3, sys3, user_prompt3): role3,
                executor.submit(run_auditor, role4, sys4, user_prompt4): role4,
            }
            # AGGREGA GLI ISSUES TROVATI CON GLI ISSUES 
            for future in as_completed(futures):
                issues = future.result()
                if isinstance(issues, list):
                    iteration_issues.extend(issues)

        # get all unified issues from agent 2, 3, 4 and code issues if present
        all_issues = python_issues + iteration_issues

        # if no issues found by any auditor, the plan is perfectly safe
        if len(all_issues) == 0:
            # remove redis key for the current turn state
            redis_client.delete(turn_state_key)
            # return APPROVED status
            return {
                "status": "APPROVED",
                "issues": [],
                "clarifying_questions": [],
                "executable_plan": [line.strip() for line in current_exec_plan.split('\n') if line.strip()],
                "verification_plan": [line.strip() for line in current_verif_cmds.split('\n') if line.strip()]
            }

        # if there are issues proceed with agent 5: plan modificator
        yield f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Issues found. Agent 5 is fixing the plan...]\n\n'})}\n\n"

        issues_formatted = "\n".join([f"- {issue}" for issue in all_issues])
        # get history of agent 5
        prior_hist5_str = redis_client.get(key_agent5)
        prior_hist5 = json.loads(prior_hist5_str) if prior_hist5_str else []

        # look only at the very last message for clarifications
        is_answering_agent5 = False
        if prior_hist5 and prior_hist5[-1].get("role") == "assistant":
            try:
                last_parsed = json.loads(prior_hist5[-1]["content"])
                if "AWAITING_CLARIFICATIONS" in str(last_parsed.get("status", "")).upper():
                    is_answering_agent5 = True
            except Exception: pass

        if is_hybrid_mode:
            sys_prompt_5 = AGENT_PROMPTS["safety_agent_5"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_dynamic_device_rules("safety_hybrid", reservation_id)
        else:
            # create system prompt and user prompt for agent 5 (use "safety" key to get all the rules)
            sys_prompt_5 = AGENT_PROMPTS["safety_agent_5"] + f"\n<topology>\n{testbed_topology}\n</topology>\n" + get_dynamic_device_rules("safety", reservation_id)
        
        agent5_prompt = common_plan_prompt + f"<device_report>\n{device_report}\n</device_report>\n\n<issues>\n{issues_formatted}\n</issues>"
        
        if is_answering_agent5:
            # continue agent 5 local exchange with user answer
            call_history = prior_hist5 + [latest_user_msg]
        else:
            if is_stateful_agent_5 and prior_hist5:
                # new correction attempt with previous iteration messages
                call_history = prior_hist5 + [{"role": "user", "content": agent5_prompt}]
            else:
                # new correction attempt without previous iteration messages, every correction attempt is stateless
                call_history = [{"role": "system", "content": sys_prompt_5}, {"role": "user", "content": agent5_prompt}]

        valid_output, reply5 = yield from consume_llm_stream_with_retries(call_history, "safety_agent_5", llm_model, reservation_id)
        if not valid_output: raise Exception("Agent 5 failed.")
        
        # update the debug log with the saved history + the user response if is_answering_agent5 is true, otherwise add current call history to the previous history
        debug_hist5 = call_history if is_answering_agent5 else (prior_hist5 + call_history)

        # save the agent 5 response in redis
        debug_hist5.append({"role": "assistant", "content": json.dumps(reply5)})
        redis_client.set(key_agent5, json.dumps(debug_hist5), ex=432000)

        status5 = str(reply5.get("status", "")).upper()
        
        if "AWAITING_CLARIFICATIONS" in status5:
            return reply5 # pause and ask user
            
        # update current plans with agent 5's fixes and loop back to Agents 2, 3, 4
        current_exec_plan = "\n".join(reply5.get("executable_plan", []))
        current_verif_cmds = "\n".join(reply5.get("verification_plan", []))
        save_turn_state()

    
    # if loop ends without approval
    return {
        "status": "REJECTED",
        "issues": all_issues,
        "clarifying_questions": [],
        "executable_plan": [line.strip() for line in current_exec_plan.split('\n') if line.strip()],
        "verification_plan": [line.strip() for line in current_verif_cmds.split('\n') if line.strip()]
    }

def handle_unified_safety_loop(username, chat_id, latest_user_msg, reservation_id, llm_model, is_manual_chat=False):
    
    agent_role = "safety"
    session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"
    history_str = redis_client.get(session_key)

    # get context from history or create if does not exist
    if history_str:
        history = json.loads(history_str)
    else:
        testbed_topology = get_testbed_topology(reservation_id)
        system_prompt = AGENT_PROMPTS.get(agent_role)
        dynamic_rules = get_dynamic_device_rules(agent_role, reservation_id)
        if dynamic_rules: system_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"
        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"
        system_prompt += get_reserved_devices(reservation_id)
        
        # add fobidden rules instructions for safety agent
        rules_formatted = "\n".join([f"- {rule}" for rule in FORBIDDEN_RULES])
        system_prompt += f"\n\n<forbidden_rules>\n{rules_formatted}\n</forbidden_rules>\n"
        history = [{"role": "system", "content": system_prompt}]

    if latest_user_msg:
        history.append(latest_user_msg)
        
    system_msg = history[0]
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
        is_valid, reply = yield from consume_llm_stream_with_retries(current_turn_safety_history, agent_role, llm_model, reservation_id)
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
        minutes_left = get_remaining_minutes(reservation_id)
        if minutes_left < BACKEND_LLM_PREVENTION_MINUTES:
            print("Operation stopped in safety loop")
            raise Exception(f"Operation stopped: during the safety loop, the remaining time dropped below {BACKEND_LLM_PREVENTION_MINUTES} minutes")

        len_before = len(current_turn_safety_history)
        valid_output, reply = yield from consume_llm_stream_with_retries(current_turn_safety_history, agent_role, llm_model, reservation_id)
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
            current_time = time.time()
            for msg in history:
                if "timestamp" not in msg:
                    msg["timestamp"] = current_time
                    current_time += 0.001
            
            redis_client.set(session_key, json.dumps(history), ex=432000)
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

        # insert correction in the two arrays
        history.append({"role": "user", "content": correction_prompt})
        current_turn_safety_history.append({"role": "user", "content": correction_prompt})

    # save the history in redis
    redis_client.set(session_key, json.dumps(history), ex=432000)

    return reply
