import json
import redis
import uuid
import time
import os
from flask import request, jsonify
from ..app import app
from .llm_client import chat_with_llm
from ..config import REDIS_HOST, REDIS_PORT, REDIS_DB, SAFETY_ITERATIONS, PHASES_ORDER, JSON_RETRIES
from .agents_util.prompts import AGENT_PROMPTS, FORBIDDEN_RULES

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

def validate_json_format(reply_text, agent_role):
    # verigy the agent's output is a valid json
    try:
        data = json.loads(reply_text)
        if agent_role == "negotiation" and not all(k in data for k in ["summary", "topology_diagram", "clarifying_questions", "status", "context_for_planning"]):
            return False, "Missing keys. Required: summary, topology_diagram, clarifying_questions, status, context_for_planning"
        if agent_role == "planning":
            if not all(k in data for k in ["execution_plan", "verification", "status", "context_for_safety"]):
                return False, "Missing keys. Required: execution_plan, verification, status, context_for_safety"
            if not isinstance(data.get("execution_plan"), list):
                return False, "execution_plan must be a JSON array"
            if not isinstance(data.get("verification"), list):
                return False, "verification must be a JSON array"  
        if agent_role == "safety":
            if not all(k in data for k in ["status", "issues", "executable_plan", "clarifying_questions"]):
                return False, "Missing keys. Required: status, issues, executable_plan, clarifying_questions"
            if not isinstance(data.get("issues"), list):
                return False, "issues must be a JSON array"
            if not isinstance(data.get("executable_plan"), list):
                return False, "executable_plan must be a JSON array"
            if not isinstance(data.get("clarifying_questions"), list):
                return False, "clarifying_questions must be a JSON array"
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
        system_prompt += f"\n\nTESTBED PHYSICAL TOPOLOGY:\n```yaml\n{testbed_topology}\n```\n"

        if agent_role == "safety":
            rules_formatted = "\n".join([f"- {rule}" for rule in FORBIDDEN_RULES])
            system_prompt += f"\n\nFORBIDDEN RULES FOR THIS TESTBED:\n{rules_formatted}"
        
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
                    user_content += f"\n\n--- Start attached file content: {f.filename} ---\n"
                    user_content += file_content
                    user_content += f"\n--- End attached file content: {f.filename} ---\n"
                except UnicodeDecodeError:
                    # message if the file is not a text file or cannot be decoded
                    user_content += f"\n\n[Note: The file {f.filename} was ignored because it is not a readable text file.]\n"

    # add user message, if present, advancement send an empty message
    if user_content.strip():
        history.append({"role": "user", "content": user_content})

    try:
        reasoning_steps = []
        reply = ""
        
        if agent_role == "safety":
            # autocorrection loop for Safety Check (max N iterations)
            for iteration in range(SAFETY_ITERATIONS):
                valid_output, reply_text, reply = get_validated_llm_reply(history, agent_role)
                if not valid_output:
                    return {"error": "LLM failed to produce valid JSON after retries"}, 500

                reasoning_steps.append({"iteration": iteration + 1, "content": reply_text})
                history.append({"role": "assistant", "content": reply_text})
                
                status = str(reply.get("status", "")).upper()
                questions = reply.get("clarifying_questions", [])

                is_approved = "APPROVED" in status
                is_awaiting_info = "AWAITING INFORMATION" in status

                has_questions = isinstance(questions, list) and len(questions) > 0
            
                # exit the loop if approved or has questions for the user
                if is_approved or is_awaiting_info or has_questions:
                    break 
               
                # if rejected, we instruct the LLM for the next iteration
                correction_prompt = "The plan you generated above still contains safety violations or logical errors. Please analyze the 'executable_plan' you just proposed, fix the remaining issues and generate a new complete response."
                history.append({"role": "user", "content": correction_prompt})

        else:
            valid_output, reply, _ = get_validated_llm_reply(history, agent_role)
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
    if current_role == "negotiation":
        context_payload = format_as_string(parsed.get("context_for_planning", ""))
    elif current_role == "planning":
        plan = format_as_string(parsed.get("execution_plan", ""))
        verification = format_as_string(parsed.get("verification", []))
        ctx = format_as_string(parsed.get("context_for_safety", ""))
        context_payload = f"EXECUTION PLAN:\n{plan}\n\nVERIFICATION COMMANDS:\n{verification}\n\nCONTEXT:\n{ctx}"
    elif current_role == "safety":
        plan = parsed.get("executable_plan", "[]")
        if isinstance(plan, list) and len(plan) > 0:
            context_payload = format_as_string(plan)
        elif isinstance(plan, str) and plan.strip().upper() not in ["", "N/A", "NONE", "[]"]:
            context_payload = plan
        # se context_payload è vuoto, l'execution agent riceve una stringa vuota
        # aggiungiamo un fallback esplicito:
        if not context_payload.strip():
            context_payload = "No execution plan was provided. Report that the safety check passed with no commands to execute."

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
    
    return jsonify({"chat_ids": chat_ids, "phases_order": PHASES_ORDER})

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