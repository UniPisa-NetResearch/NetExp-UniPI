import json
import redis
import uuid
import time
import os
from flask import request, jsonify
from ..app import app
from .llm_client import chat_with_llm
from ..config import REDIS_HOST, REDIS_PORT, REDIS_DB, SAFETY_ITERATIONS
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

    history.append({"role": "user", "content": user_content})

    try:
        reasoning_steps = []
        reply = ""
        
        # autocorrection loop for Safety Check (max N iterations)
        if agent_role == "safety":
            for iteration in range(SAFETY_ITERATIONS):
                reply = chat_with_llm(history)
                reasoning_steps.append({"iteration": iteration + 1, "content": reply})
                history.append({"role": "assistant", "content": reply})
                
                is_approved = "APPROVED" in reply
                is_awaiting_info = "AWAITING INFORMATION" in reply
                
                has_questions = False
                if "### CLARIFYING QUESTIONS" in reply:
                    questions_section = reply.split("### CLARIFYING QUESTIONS")[-1].strip()
        
                    if questions_section and "none" not in questions_section.lower():
                        has_questions = True
                
                # exit the loop if approved or has questions for the user
                if is_approved or is_awaiting_info or has_questions:
                    break 
            
                # if rejected, we instruct the LLM for the next iteration
                correction_prompt = "The plan you generated above still contains safety violations or logical errors. Please analyze the '### EXECUTABLE PLAN' you just proposed, fix the remaining issues and generate a new complete response."
                history.append({"role": "user", "content": correction_prompt})

        else:
            reply = chat_with_llm(history)
            # add response to history and save it back to Redis
            history.append({"role": "assistant", "content": reply})
        
        # save updated history to Redis (expiration set to 5 days as security, when the reservation ends, the key is automatically removed)
        redis_client.set(session_key, json.dumps(history), ex=432000)
        
        return jsonify({"reply": reply, "chat_id": chat_id, "reasoning_steps": reasoning_steps})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
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
    
    return jsonify({"chat_ids": chat_ids})

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