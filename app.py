from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
app = Flask(__name__)

DB_USER = 'root'
DB_PASSWORD = 'root'
DB_HOST = 'gabri_db_1'
DB_NAME = 'netexp_db'

app.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:5432/{DB_NAME}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Aumenta timeout per connessioni lente in caso di avvio DB
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'connect_timeout': 10}}

db = SQLAlchemy(app)

# enable CORS for development frontend, it is limited only for api endpoints
# in this way, react app can call flask methods
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}}) #address for local development

# User table
class User(db.Model):
    # La tabella sarà creata automaticamente con il tipo di dati corretto da SQLAlchemy per PostgreSQL
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(255), nullable=False)
    ssh_key = db.Column(db.Text, nullable=False)  # Text è preferito per chiavi lunghe

    # ... (metodi set_password, check_password e __repr__ rimangono invariati)
    def set_password(self, plain_password):
        self.password = generate_password_hash(plain_password)

    def check_password(self, plain_password):
        return check_password_hash(self.password, plain_password)

    def __repr__(self):
        return '<User %r>' % self.username

@app.route('/')
def serve_frontend_proxy():
    # can be used for testing, it is not the route used by the browser to load React.
    return 'Flask Backend Running. React is expected on port 5173.'

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')

    # Retrieve user and credentials check
    user = User.query.filter_by(username=username).first()

    if user and user.check_password(password):
        return jsonify({"message": "Login successful", "username": user.username}), 200
    else:
        return jsonify({"message": "Invalid username or password"}), 401

@app.route('/api/signup', methods=['POST'])
def signup():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    ssh_key = data.get('sshKey')

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

    # User creation
    new_user = User(username=username, ssh_key=ssh_key)
    new_user.set_password(password)

    db.session.add(new_user)
    try:
        db.session.commit()
        return jsonify({"message": "Registration successful. You can now log in."}), 201
    except Exception as ex:
        db.session.rollback()
        # DB error
        app.logger.error(f"DB Error during signup: {ex}")
        return jsonify({"message": "An internal error occurred during registration."}), 500

if __name__ == '__main__':
    with app.app_context():
        # create tables on the DB, if they don't exist
        try:
            db.create_all()
            print("PostgreSQL Database tables created/checked.")
        except Exception as e:
            print(f"ERROR: Could not connect to PostgreSQL. Ensure the DB server is running and accessible: {e}")

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5000)