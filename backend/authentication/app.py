from flask import Flask, jsonify, request
from flask_cors import CORS
from ..database.db import db, User
import base64
app = Flask(__name__)

DB_USER = 'root'
DB_PASSWORD = 'root'
DB_HOST = 'localhost'
DB_NAME = 'netexp_db'

SUPPORTED_KEY_TYPES = ['ssh-ed25519', 'ssh-rsa']

app.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:5432/{DB_NAME}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Aumenta timeout per connessioni lente in caso di avvio DB
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'connect_timeout': 10}}

with app.app_context():
    db.init_app(app)

# enable CORS for development frontend, it is limited only for api endpoints
# in this way, react app can call flask methods
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}}) #address for local development

def check_ssh_key(ssh_key):
    # separate the key elements
    key_parts = ssh_key.split()
    # the kay has two or three parts (omission of comment)
    if len(key_parts) < 2 or len(key_parts) > 3 or len(ssh_key) <50:
        return jsonify({"message": "Invalid SSH Key format. Please ensure you copied the entire key."}), 400

    # key type verification
    key_type = key_parts[0]

    if key_type not in SUPPORTED_KEY_TYPES:
        return jsonify({"message": f"Unsupported SSH Key type: {key_type}. Supported types are: {', '.join(SUPPORTED_KEY_TYPES)}"}), 400

    # key body verification
    key_body_base64 = key_parts[1]
    try:
        # try to decode key body in Base64
        base64.b64decode(key_body_base64)
    except Exception as ex:
        app.logger.error(f"Key decoding error: {ex}")
        return jsonify({"message": "SSH Key body is corrupted or not valid Base64."}), 400

    return None
@app.route('/')
def serve_frontend_proxy():
    # can be used for testing, it is not the route used by the browser to load React.
    return 'Flask Backend Running. React is expected on port 5173.'

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    # Retrieve user and credentials check
    user = User.query.filter_by(username=username).first()

    if user and user.check_password(password):
        return jsonify({"message": "Login successful", "user_id": user.id, "username": user.username}), 200
    else:
        return jsonify({"message": "Invalid username or password"}), 401

@app.route('/api/auth/signup', methods=['POST'])
def signup():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    # remove initial/final spaces
    ssh_key = data.get('sshKey', '').strip()

    # Check values
    if not username or not password or not ssh_key:
        return jsonify({"message": "Missing username, password, or SSH key"}), 400
    if len(password) < 8:
        return jsonify({"message": "Password must be at least 8 characters"}), 400
    if len(username) < 5:
        return jsonify({"message": "Username must be at least 5 characters"}), 400

    # User existence verification
    if User.query.filter_by(username=username).first():
        return jsonify({"message": "Username already exists"}), 409

    error = check_ssh_key(ssh_key)
    if error:
        return error

    # User creation
    new_user = User(username=username, ssh_key=ssh_key)
    new_user.set_password(password)

    db.session.add(new_user)
    try:
        db.session.commit()
        return jsonify({"message": "Registration successful. You can now log in.", "user_id": new_user.id, "username": new_user.username}), 201
    except Exception as ex:
        db.session.rollback()
        # DB error
        app.logger.error(f"DB Error during signup: {ex}")
        return jsonify({"message": "An internal error occurred during registration."}), 500

@app.route('/api/auth/user/show_user', methods=['POST'])
def show_user():
    # shows username and the public key of the user
    data = request.get_json()
    username = data.get('username')

    if not username:
        return jsonify({"message": "Username required"}), 400

    user = User.query.filter_by(username=username).first()

    if user:
        return jsonify({
            "username": user.username,
            "ssh_key": user.ssh_key,
            "message": "User data retrieved successfully"
        }), 200
    else:
        return jsonify({"message": "User not found"}), 404


@app.route('/api/auth/user/change_key', methods=['POST'])
def change_key():
    # allows user to change the public key
    data = request.get_json()
    username = data.get('username')
    new_ssh_key = data.get('newSshKey', '').strip()

    if not username or not new_ssh_key:
        return jsonify({"message": "Missing username or new SSH key"}), 400

    error = check_ssh_key(new_ssh_key)

    if error:
        return error

    # 2. Aggiornamento nel DB
    user = User.query.filter_by(username=username).first()

    if user:
        user.ssh_key = new_ssh_key
        try:
            db.session.commit()
            return jsonify({"message": "SSH Key updated successfully"}), 200
        except Exception as ex:
            db.session.rollback()
            app.logger.error(f"DB Error during key change: {ex}")
            return jsonify({"message": "An internal error occurred."}), 500
    else:
        return jsonify({"message": "User not found"}), 404

if __name__ == '__main__':
    with app.app_context():
        # create tables on the DB, if they don't exist
        try:
            db.create_all()
            print("PostgresSQL Database tables created/checked.")
        except Exception as e:
            print(f"ERROR: Could not connect to PostgresSQL. Ensure the DB server is running and accessible: {e}")

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5000)