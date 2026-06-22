import json
import redis
import uuid
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
        chat_id = str(uuid.uuid4())

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
                    "You are a network automation agent. "
                    "You help the user plan and execute experiments "
                    "on a testbed with SONiC switches and Linux miniPCs managed via Containerlab."
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
        # save updated history to Redis (expiration set to 24 hours to avoid filling up memory)
        redis_client.set(session_key, json.dumps(history), ex=86400)
        
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