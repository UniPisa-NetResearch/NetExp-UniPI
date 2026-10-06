import json
import os
import time
import uuid
from ...app import app
from .prompts import AGENT_PROMPTS
from .safety_logic import execute_safety_phase
from .agent_server_utils import (redis_client, get_last_agent_message, format_as_string, parse_plan, 
                                open_ssh_connections, run_parallel_commands, close_ssh_connections, 
                                run_agent_execution_plan, generate_diagnostic_assistant_sse, delete_agent_history_keys, 
                                consume_llm_stream_with_retries, get_dynamic_device_rules, get_reserved_devices, get_testbed_topology, extract_xml_tag)


def handle_chat_logic(username, reservation_id, chat_id, agent_role, message, llm_model, files=None, is_manual_chat=False):
    # if there is no chat_id, it means the user is starting a new chat. We generate one.
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"          # added timestamp to guarantee chronological order of messages

    # route to the safety orchestrator
    if agent_role == "safety":
        latest_user_msg = {"role": "user", "content": message} if message.strip() else None
        
        # run the safety loop
        reply = yield from execute_safety_phase(username, chat_id, latest_user_msg, reservation_id, llm_model, is_manual_chat)
        
        return reply, chat_id

    session_key = f"agent_history:{agent_role}:{username}:{reservation_id}:{chat_id}"

    # retrieve history from Redis
    history_str = redis_client.get(session_key)
    if history_str:
        history = json.loads(history_str)
    else:
        # create first message that includes the system prompt, dynamic rules for device kinds if present and the topology
        testbed_topology = get_testbed_topology(reservation_id)
        system_prompt = AGENT_PROMPTS.get(agent_role)

        dynamic_rules = get_dynamic_device_rules(agent_role, reservation_id)
        if dynamic_rules:
            system_prompt += f"\n<device_specific_rules>\n{dynamic_rules}\n</device_specific_rules>\n"

        system_prompt += f"\n\n<topology>\n```yaml\n{testbed_topology}\n```\n</topology>\n"

        # add reserved devices constraint list to the system prompt
        system_prompt += get_reserved_devices(reservation_id)

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

        # for planning and execution we use a minimal array. Negotiation use all the history.
        if agent_role in ["planning", "execution"]:
            llm_history = [system_msg]
            if latest_user_msg:
                llm_history.append(latest_user_msg)
        else:
            llm_history = history 

        # send request to the LLM
        valid_output, reply = yield from consume_llm_stream_with_retries(llm_history, agent_role, llm_model, reservation_id)
        
        if not valid_output:
            print(f"[DEBUG SERVER] FINAL FAILURE DETAILS (safety): {reply}")
            raise Exception("LLM failed to produce valid JSON after retries")

        # add "MODE: DIRECT COMMAND EXECUTION" string to the context for the current configuration loop, if execution mode is DIRECT_COMMANDS
        if agent_role == "negotiation" and "APPROVED" in str(reply.get("status", "")).upper():
            if str(reply.get("execution_mode", "")).upper() == "DIRECT_COMMANDS":
                original_context = reply.get("context_for_planning", "")
                reply["context_for_planning"] = "MODE: DIRECT COMMAND EXECUTION\n\n" + str(original_context)
        
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

def run_experiment_pipeline_worker(username, reservation_id, chat_id, starting_phase, initial_message, llm_model, execution_mode, files, is_manual_chat, context_payload):
    # background worker that runs the while loop. Evaluates agents sequentially and publishes SSE strings to Redis
    channel = f"channel:chat_{chat_id}"
    current_phase = starting_phase
    message = initial_message
    
    # we must run inside app_context to allow database access
    with app.app_context():
        try:
            # retrieve negotiation experiment context if available, it is common for next agents, usefull also in execution when the experiment is not approved
            experiment_context = "No specific experiment context provided."
            exit_conditions = "No specific exit conditions provided."
            execution_report = "No report found."
            old_plan = "No previous plan found."

            # loop of the experiemnt pipeline
            while current_phase:
                
                # fetch history context if skipping negotiation
                if current_phase in ["planning", "safety", "testbed_execution", "execution"] and chat_id:

                    is_valid_negotiation, parsed_negotiation = get_last_agent_message(username, reservation_id, chat_id, "negotiation")

                    if is_valid_negotiation and parsed_negotiation.get("status") == "APPROVED":
                        experiment_context = format_as_string(parsed_negotiation.get("context_for_planning", ""))
                        exit_conditions = format_as_string(parsed_negotiation.get("exit_conditions", ""))

                if current_phase == "planning" and message.strip() == "RETRY_PLANNING":
                    # delete safety temporary context for the previous turn
                    delete_agent_history_keys(username=username, reservation_id=reservation_id, chat_id=chat_id, role_prefix="safety_turn_state")
                    # get the report generated by the execution agent
                    is_parsed_execution_valid, parsed_execution = get_last_agent_message(username, reservation_id, chat_id, "execution")

                    if is_parsed_execution_valid:
                        execution_report = format_as_string(parsed_execution.get("report", ""))

                    # retrieve the approved experiment plan from the safety agent
                    is_parsed_safety_valid, parsed_safety = get_last_agent_message(username, reservation_id, chat_id, "safety")

                    if is_parsed_safety_valid:
                        old_plan = format_as_string(parsed_safety.get("executable_plan", ""))

                    message = f"Please analyze the errors below and generate a NEW corrected execution plan. You MUST respond in a valid JSON object.\n\n<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<failed_execution_plan>\n{old_plan}\n</failed_execution_plan>\n\n<execution_report>\n{execution_report}\n</execution_report>"

                # add user message to the context returned by the client if the current phase is not negotiation and we are not in a retry in planning phase    
                elif current_phase != "negotiation" and context_payload:
                    message = context_payload + ("\n\n" + message if message.strip() else "")

                if current_phase == "testbed_execution":
                    # publish the message to show the experiemtn execution
                    redis_client.publish(channel, f"data: {json.dumps({'type': 'thought', 'content': f'\n\n[System: Executing verified plan on testbed...]\n\n'})}\n\n")

                    # retrieve the approved experiment plan and verification commands from the safety agent
                    plan_str = extract_xml_tag(context_payload, "approved_exec_plan")
                    v_plan_str = extract_xml_tag(context_payload, "approved_verif_plan")
                    
                    plan = [line.strip() for line in plan_str.split('\n') if line.strip()]
                    v_plan = [line.strip() for line in v_plan_str.split('\n') if line.strip()]

                    base_dir = os.path.dirname(os.path.abspath(__file__))
                    inventory_path = os.path.abspath(os.path.join(base_dir, "..", "..", "controller", "inventories", f"res-{reservation_id}-inventory.ini"))

                    plan = parse_plan(plan)
                    v_plan = parse_plan(v_plan)

                    # add message to show before starting execution of the plan on devices
                    if len(plan) > 0 and len(v_plan) > 0:

                        if execution_mode == "parallel":
                            # in parallel execution mode, commands are executed in parallel for differente devices, execution and verification are maintained separated and serial for consistency
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
                            # in serial mode, every command is executed following the rder of the execution and verification plans
                            complete_plan = plan + v_plan

                            start_time = time.time()

                            execution_report = run_agent_execution_plan(inventory_path, complete_plan, reservation_id)

                            elapsed_time = time.time() - start_time
                            print(f"\n[DEBUG EXECUTION] --- SERIAL PLAN EXECUTED IN {elapsed_time:.2f} SECONDS ---") 
                            
                        next_context = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<execution_results>\n{execution_report}\n</execution_results>\n"
                    else:
                        next_context = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<execution_results>\nNo execution plan was provided. Report that the safety check passed with no commands to execute.\n</execution_results>\n"
                        
                    result_data = {"chat_id": chat_id, "context": next_context, "next_phase": "execution"}

                    redis_client.publish(channel, f"data: {json.dumps({'type': 'result', 'data': result_data})}\n\n")
                    # update variables for the next iteration, and skip LLM call
                    current_phase = result_data.get("next_phase")
                    message = ""
                    context_payload = result_data.get("context", "")
                    files = []
                    continue

                # run LLM logic sending reasoning in streaming for current phase
                generator = handle_chat_logic(username, reservation_id, chat_id, current_phase, message, llm_model, files, is_manual_chat)
                final_reply = None
                chat_id_out = chat_id
                
                try:
                    while True:
                        # get reasoning tokens (already formatted as SSE string) and publish in the channel
                        chunk = next(generator)
                        redis_client.publish(channel, chunk)
                except StopIteration as e:
                    # when handle_chat_logic ends, an exception is raised and the final value of the function can be retrieved
                    final_reply, chat_id_out = e.value
                except Exception as e:
                    redis_client.publish(channel, f"data: {json.dumps({'type': 'result', 'data': {'error': str(e)}})}\n\n")
                    break
                
                if not final_reply:
                    redis_client.publish(channel, f"data: {json.dumps({'type': 'result', 'data': {'error': 'No reply generated'}})}\n\n")
                    break

                # get final reply of the agent after reasoning
                parsed = final_reply
                status = str(parsed.get("status", "")).upper()

                filtered_reply = None
                
                if current_phase == "negotiation" or current_phase == "execution":
                    # show complete negotiation message
                    filtered_reply = parsed

                # for planning, filtered_reply is None (we never show the planning message)    
                elif current_phase == "safety":
                    # show only some fields of safety message
                    filtered_reply = {"status": status, "executable_plan": parsed.get("executable_plan", []), "verification_plan": parsed.get("verification_plan", [])}
                    # add issues field only if the plan was rejected
                    if "REJECTED" in status: filtered_reply["issues"] = parsed.get("issues", [])
                    # add clarifying questions if present
                    if parsed.get("clarifying_questions"): filtered_reply["clarifying_questions"] = parsed.get("clarifying_questions")

                # update result_data only if there is reply that can be shown
                result_data = {"chat_id": chat_id_out}
                if filtered_reply:
                    result_data["reply"] = json.dumps(filtered_reply)

                # for every phase add to result_data the context for the next agent and the name of the next agent
                if current_phase == "negotiation":
                    if "APPROVED" in status:
                        raw_context = format_as_string(parsed.get("context_for_planning", ""))
                        raw_exit = format_as_string(parsed.get("exit_conditions", ""))
                        next_context = f"<experiment_context>\n{raw_context}\n</experiment_context>\n\n<exit_conditions>\n{raw_exit}\n</exit_conditions>"
                        result_data.update({"context": next_context, "next_phase": "planning"})
                    else:
                        result_data.update({"requires_answers": True, "questions": parsed.get("clarifying_questions", []), "next_phase": "negotiation"})

                elif current_phase == "planning":
                    if "APPROVED" in status:
                        plan = format_as_string(parsed.get("execution_plan", ""))
                        verification = format_as_string(parsed.get("verification", []))
                        next_context = f"<experiment_context>\n{experiment_context}\n</experiment_context>\n\n<exit_conditions>\n{exit_conditions}\n</exit_conditions>\n\n<execution_plan>\n{plan}\n</execution_plan>\n\n<verification_commands>\n{verification}\n</verification_commands>\n\n<device_report>\nnull\n</device_report>"
                        result_data.update({"context": next_context, "next_phase": "safety"})

                elif current_phase == "safety":
                    if "APPROVED" in status:
                        # extract plan and verification commands from safety final response
                        safe_exec_plan = format_as_string(parsed.get("executable_plan", []))
                        safe_verif_plan = format_as_string(parsed.get("verification_plan", []))
                        # send the extracted fields to the testbed execution phase
                        safe_context = f"<approved_exec_plan>\n{safe_exec_plan}\n</approved_exec_plan>\n\n<approved_verif_plan>\n{safe_verif_plan}\n</approved_verif_plan>"    
                        result_data.update({"context": safe_context, "next_phase": "testbed_execution"})
                    else:
                        result_data.update({"next_phase": "safety"})

                elif current_phase == "execution":
                    if "APPROVED" in status:
                        result_data.update({"next_phase": None})
                    else:
                        result_data.update({"execution_rejected": True, "next_phase": "planning"})

                # publish final result for the current phase
                redis_client.publish(channel, f"data: {json.dumps({'type': 'result', 'data': result_data})}\n\n")

                # get next phase from current phase data
                next_phase = result_data.get("next_phase")

                # check for stop conditions in the safety
                is_safety_stopped = (current_phase == "safety" and "APPROVED" not in status)

                # check if we need pause to let user decide to continue the loop (if the execution produced rejected results), pause for human (if there are questions), or end experiment (there is not a next phase, there are not questions and execution plan is not rejected)
                if not next_phase or result_data.get("requires_answers") or result_data.get("execution_rejected") or is_safety_stopped:
                    break # human intervention or end
                    
                # setup for next iteration
                current_phase = next_phase
                message = ""
                context_payload = result_data.get("context", "")
                files = [] # files are only sent on the very first phase

        except Exception as e:
            redis_client.publish(channel, f"data: {json.dumps({'type': 'result', 'data': {'error': str(e)}})}\n\n")
        finally:
            # tell the HTTP route that the stream is finished
            redis_client.publish(channel, "EOF")

def run_diagnostic_pipeline_worker(request_data, history):
    chat_id = request_data['chat_id']
    channel = f"channel:chat_{chat_id}"
    
    with app.app_context():
        try:
            while True:
                # we iterate the generator function to extract its yields and publish them to Redis
                generator = generate_diagnostic_assistant_sse(history=history, request_data=request_data)
                phase_transitioned = False
                should_stop = False
            
                for chunk in generator:
                    # the generator yields strings formatted like "data: {...}\n\n"
                    redis_client.publish(channel, chunk)
                
                    # check if the generated chunk is a "result" that requires approval or ends the phase
                    if chunk.startswith("data: "):
                        try:
                            data_payload = json.loads(chunk[6:])
                            if data_payload.get("type") == "result":
                                res_data = data_payload.get("data", {})
                                next_phase = res_data.get("next_phase")
                                requires_approval = res_data.get("requires_approval")
                            
                                # if we hit an approval or there is no next phase, stop the worker
                                if requires_approval or not next_phase:
                                    should_stop = True
                                    break
                                
                                # otherwise, prepare the payload for the next phase and loop internally
                                request_data['current_phase'] = next_phase
                                if "context" in res_data: request_data['context'] = res_data['context']
                                if "safe_commands" in res_data: request_data['safe_commands'] = res_data['safe_commands']
                                if "execution_report" in res_data: request_data['execution_report'] = res_data['execution_report']
                            
                                phase_transitioned = True
                                break

                        except json.JSONDecodeError:
                            pass
                # interrupt the loop if the phase is not changed or stop is necessary
                if should_stop or not phase_transitioned:
                    break

        except Exception as e:
            redis_client.publish(channel, f"data: {json.dumps({'type': 'result', 'data': {'error': str(e)}})}\n\n")
        finally:
            # advertise HTTP route to close connection
            redis_client.publish(channel, "EOF")