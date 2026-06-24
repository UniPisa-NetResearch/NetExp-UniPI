import json
import redis
import uuid
import time
from flask import request, jsonify
from ..app import app
from .llm_client import chat_with_llm
from ..config import REDIS_HOST, REDIS_PORT, REDIS_DB

# redis store for conversation history, keyed by username and reservation_id
redis_client = redis.Redis(
    host=REDIS_HOST, 
    port=REDIS_PORT, 
    db=REDIS_DB, 
    decode_responses=True   # automatically decodes bytes in strings
)

@app.route("/api/agent_server/chat", methods=["POST"])
def chat():
    message = request.form.get("message", "")
    username = request.form.get("username", "")
    reservation_id = request.form.get("reservation_id", "")
    chat_id = request.form.get("chat_id", "")
    files = request.files.getlist("files")

    if not username or not reservation_id:
        return jsonify({"error": "Missing username or reservation_id"}), 400

    # if there is no chat_id, it means the user is starting a new chat. We generate one.
    if not chat_id:
        chat_id = f"{int(time.time())}_{uuid.uuid4().hex[:8]}"          # added timestamp to guarantee chronological order

    session_key = f"agent_history:{username}:{reservation_id}:{chat_id}"

    # retrieve history from Redis
    history_str = redis_client.get(session_key)
    if history_str:
        history = json.loads(history_str)
    else:
        # initialize history if it doesn't exist
        history = [
            {
                "role": "system",
                "content": (
                    "You are an Experiment Planner & Intent Interface for a network testbed (SONiC and Linux via Containerlab). "
                    "Your goal is to understand the user's experiment and generate an execution plan. "
                    "You MUST strictly follow the following rules:\n"
                    "1. NO CHITCHAT: Do not use polite formulas, do not say 'I understand', 'Great question' or 'Here is the plan'. Get straight to the point.\n"
                    "2. NO ASSUMPTIONS (CRITICAL): If the user does NOT explicitly specify the routing protocol (e.g., Static, BGP, OSPF), the IP subnetting scheme OR other essential information, DO NOT INVENT THEM. You MUST stop, leave the Execution Plan as 'Awaiting clarifications', and ask the user specific questions to gather this missing information.\n"
                    "3. EXHAUSTIVE EXECUTION (ANTI-LAZINESS): When you have all the information and generate the EXECUTION PLAN, you MUST provide the FULL, EXACT commands for EVERY SINGLE DEVICE required for the experiment. "
                    "The use of phrases like 'Example for sw1', 'Repeat logic for...', or 'etc are absolutely FORBIDDEN'. If N switches need BGP, write the full `vtysh` command block for ALL N switches explicitly.\n"
                    "4. MINIMAL SCOPE: Configure ONLY the specific devices and interfaces strictly necessary to achieve the user's explicitly stated goal. Do not over-provision or configure the entire topology if only a subset of nodes is involved in the experiment.\n"
                    "5. MANDATORY STRUCTURE: Your response MUST be formatted EXACTLY into four sections using Markdown:\n\n"
                    "### EXPERIMENT SUMMARY\n"
                    "[Write here a concise and technical summary of what you understood]\n\n"
                    "### CLARIFYING QUESTIONS\n"
                    "[Select and write here the questions for the user, otherwise write 'None']\n\n"
                    "### EXECUTION PLAN\n"
                    "[Provide the complete, exhaustive commands. You may use an Ansible YAML code block, or a list of bash commands in the exact format: `device_name: <command>`]\n\n"
                    "If you are not yet ready for the Execution Plan because you need information, fill the Summary, write the Questions, and under 'Execution Plan' write 'Awaiting clarifications'."
                    "### VERIFICATION\n"
                    "[Provide the specific commands or steps to execute in order to verify the objective and the final outcome of the experiment. If you are still awaiting clarifications, write ONLY 'Awaiting clarifications'.]"
                )
            }
        ]

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
        reply = chat_with_llm(history)
        # add response to history and save it back to Redis
        history.append({"role": "assistant", "content": reply})
        # save updated history to Redis (expiration set to 5 days as security, when the reservation ends, the key is automatically removed)
        redis_client.set(session_key, json.dumps(history), ex=432000)
        
        return jsonify({"reply": reply, "chat_id": chat_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    
@app.route("/api/agent_server/sessions", methods=["GET"])
def get_sessions():
   # return every chat_id for a user and a specific reservation
    username = request.args.get("username", "")
    reservation_id = request.args.get("reservation_id", "")
    
    if not username or not reservation_id:
        return jsonify({"error": "Missing parameters"}), 400

    # find all chats relative to thie current reservation
    pattern = f"agent_history:{username}:{reservation_id}:*"
    keys = redis_client.keys(pattern)

    # extract last part (chat_id)
    chat_ids = [key.split(":")[-1] for key in keys]
    
    # order chat_ids in descendent order
    chat_ids.sort(reverse=True)
    
    # extract the last part (the chat_id)
    chat_ids = [key.split(":")[-1] for key in keys]
    
    return jsonify({"chat_ids": chat_ids})

@app.route("/api/agent_server/history", methods=["GET"])
def get_history():
    username = request.args.get("username", "")
    reservation_id = request.args.get("reservation_id", "")
    chat_id = request.args.get("chat_id", "")

    if not username or not reservation_id or not chat_id:
        return jsonify({"error": "Missing parameters"}), 400

    session_key = f"agent_history:{username}:{reservation_id}:{chat_id}"
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

    if not username or not reservation_id:
        return jsonify({"error": "Missing parameters"}), 400

    pattern = f"agent_history:{username}:{reservation_id}:*"
    keys = redis_client.keys(pattern)
    if keys:
        redis_client.delete(*keys) # remove all keys matching the pattern
    
    return jsonify({"status": "success", "message": f"Deleted {len(keys)} chats"})

if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5006, use_reloader=False)