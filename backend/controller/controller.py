from flask import jsonify, request
from ..app import app

@app.route('/api/controller/grantAccess', methods=['POST'])
def grant_access():
    print("Create ssh account for the user")
    data = request.get_json(silent=True)
    if not data:
        print("grantAccess: missing or invalid JSON")
        return jsonify({"ok": False, "message": "Missing or invalid JSON body"}), 400

    ssh_key = data.get("ssh_key")
    user_id = data.get("user_id")
    username = data.get("username")
    devices = data.get("devices")

    if ssh_key is None or user_id is None or username is None or devices is None:
        print("grantAccess: missing required fields")
        return jsonify({"ok": False, "message": "Missing required fields (ssh_key, user_id, username, devices)"}), 400

    print("GRANT ACCESS RECEIVED", data)

    return jsonify({"ok": True, "message": "Grant request received"}), 200

@app.route('/api/controller/revokeAccess', methods=['POST'])
def revoke_access():
    print("Remove ssh account for the user")
    data = request.get_json(silent=True)
    if not data:
        print("revokeAccess: missing or invalid JSON")
        return jsonify({"ok": False, "message": "Missing or invalid JSON body"}), 400

    ssh_key = data.get("ssh_key")
    user_id = data.get("user_id")
    username = data.get("username")
    reservation_id = data.get("reservation_id")

    if ssh_key is None or user_id is None or username is None or reservation_id is None:
        print("revokeAccess: missing required fields")
        return jsonify({"ok": False, "message": "Missing required fields (ssh_key, user_id, username, reservation_id)"}), 400

    print("REVOKE ACCESS RECEIVED", data)

    return jsonify({"ok": True, "message": "Revoke request received"}), 200



if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5002)