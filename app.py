from flask import Flask, render_template, jsonify
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
app = Flask(__name__)

DB_USER = 'netexp_user'
DB_PASSWORD = 'your_strong_password' # **CAMBIA QUESTA PASSWORD**
DB_HOST = 'localhost' # Se Flask è nel suo container, sarà il nome del servizio DB ('db')
DB_NAME = 'netexp_db'

app.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:5432/{DB_NAME}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
# Aumenta timeout per connessioni lente in caso di avvio DB
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'connect_timeout': 10}}

db = SQLAlchemy(app)

# enable CORS for development frontend, it is limited only for api endpoints
# in this way, react app can call flask methods
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}}) #address for local development


# --- Modello del Database ---
class User(db.Model):
    # La tabella sarà creata automaticamente con il tipo di dati corretto da SQLAlchemy per PostgreSQL
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    ssh_key = db.Column(db.Text, nullable=True)  # Text è preferito per chiavi lunghe

    # ... (metodi set_password, check_password e __repr__ rimangono invariati)
    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

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

    # Recupero Utente e Verifica Credenziali (logica invariata)
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

    # Controlli sui valori (omessi per brevità, sono gli stessi della versione SQLite)
    if not username or not password or not ssh_key:
        return jsonify({"message": "Missing username, password, or SSH key"}), 400
    if len(password) < 8:
        return jsonify({"message": "Password must be at least 8 characters"}), 400

    # Verifica se l'utente esiste
    if User.query.filter_by(username=username).first():
        return jsonify({"message": "Username already exists"}), 409

    # Creazione Utente
    new_user = User(username=username, ssh_key=ssh_key)
    new_user.set_password(password)

    db.session.add(new_user)
    try:
        db.session.commit()
        return jsonify({"message": "Registration successful. You can now log in."}), 201
    except Exception as e:
        db.session.rollback()
        # In caso di errore DB (es. connessione persa)
        app.logger.error(f"DB Error during signup: {e}")
        return jsonify({"message": "An internal error occurred during registration."}), 500

if __name__ == '__main__':
    with app.app_context():
        # Questo comando crea le tabelle nel DB PostgreSQL se non esistono
        try:
            db.create_all()
            print("PostgreSQL Database tables created/checked.")
        except Exception as e:
            print(f"ERROR: Could not connect to PostgreSQL. Ensure the DB server is running and accessible: {e}")

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5000)