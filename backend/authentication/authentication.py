from flask import jsonify, request
from ..database.db import db, User, Reservation, ReservationDevice
import base64
from redis import Redis
from rq import Queue
from rq.job import Job
from ..utils import get_next_available_id
from ..app import app

SUPPORTED_KEY_TYPES = ['ssh-ed25519', 'ssh-rsa']
REDIS_URL = "redis://localhost:6379"
redis = Redis.from_url(REDIS_URL)
queue = Queue(connection=redis)

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
        return jsonify({"message": "Login successful", "user_id": user.id, "username": user.username, "is_admin": user.is_admin}), 200
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

    # get next available ID (fills gaps)
    next_id = get_next_available_id(User)

    # User creation
    new_user = User(id=next_id, username=username, ssh_key=ssh_key)
    new_user.set_password(password)

    db.session.add(new_user)
    try:
        db.session.commit()
        # Reset sequence to avoid conflicts
        db.session.execute(db.text("""
                    SELECT setval(pg_get_serial_sequence('"user"', 'id'), 
                                 (SELECT MAX(id) FROM "user"), true);
                """))
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


# Get all users (admin only)
@app.route('/api/auth/admin/get_all_users', methods=['GET'])
def get_all_users():
    try:
        users = User.query.order_by(User.id).all()
        users_list = [{
            'id': user.id,
            'username': user.username,
            'full_user': user.full_user,
            'is_admin': user.is_admin
        } for user in users]
        return jsonify({"users": users_list}), 200
    except Exception as ex:
        app.logger.error(f"Error fetching users: {ex}")
        return jsonify({"message": "Failed to fetch users"}), 500

def cancel_jobs(reservation_id):
    job_ids = [
        f"res-{reservation_id}-start",
        f"res-{reservation_id}-end"
    ]

    for job_id in job_ids:
        try:
            job = Job.fetch(job_id, connection=redis)
            job.cancel()
            app.logger.info(f"Cancelled job: {job_id}")
        except Exception as job_ex:
            app.logger.warning(f"Could not cancel job {job_id}: {job_ex}")

# Delete user and their reservations (admin only)
@app.route('/api/auth/admin/delete_user', methods=['DELETE'])
def delete_user():
    data = request.get_json()
    user_id = data.get('user_id')

    if not user_id:
        return jsonify({"message": "User ID is required"}), 400

    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({"message": "User not found"}), 404

        # Delete all reservations for this user
        reservations = Reservation.query.filter_by(username=user.username).all()

        for reservation in reservations:
            cancel_jobs(reservation.id)

            db.session.delete(reservation)

        # Delete the user
        db.session.delete(user)
        db.session.commit()

        return jsonify({"message": "User and related reservations deleted successfully"}), 200
    except Exception as ex:
        db.session.rollback()
        app.logger.error(f"Error deleting user: {ex}")
        return jsonify({"message": "Failed to delete user"}), 500


# Update user permissions (admin only)
@app.route('/api/auth/admin/update_user', methods=['PUT'])
def update_user():
    data = request.get_json()
    user_id = data.get('user_id')
    full_user = data.get('full_user')
    is_admin = data.get('is_admin')
    current_user_id = data.get('current_user_id')

    if not user_id:
        return jsonify({"message": "User ID is required"}), 400

    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({"message": "User not found"}), 404

        # Update fields
        if full_user is not None:
            user.full_user = full_user

        # Only update is_admin if not modifying self
        if is_admin is not None and user_id != current_user_id:
            user.is_admin = is_admin

        db.session.commit()
        return jsonify({"message": "User updated successfully"}), 200
    except Exception as ex:
        db.session.rollback()
        app.logger.error(f"Error updating user: {ex}")
        return jsonify({"message": "Failed to update user"}), 500


# Get all reservations with devices (admin only)
@app.route('/api/auth/admin/get_all_reservations', methods=['GET'])
def get_all_reservations():
    try:
        reservations = Reservation.query.order_by(Reservation.startDate.desc(), Reservation.startTime.desc()).all()
        reservations_list = []

        for res in reservations:
            # Get devices for this reservation
            devices = ReservationDevice.query.filter_by(reservation_id=res.id).all()
            device_tags = [dev.asset_tag for dev in devices]

            reservations_list.append({
                'id': res.id,
                'username': res.username,
                'start_date': res.startDate.isoformat(),
                'end_date': res.endDate.isoformat(),
                'start_time': res.startTime.strftime('%H:%M'),
                'end_time': res.endTime.strftime('%H:%M'),
                'has_token': res.token is not None,
                'devices': device_tags
            })

        return jsonify({"reservations": reservations_list}), 200
    except Exception as ex:
        app.logger.error(f"Error fetching reservations: {ex}")
        return jsonify({"message": "Failed to fetch reservations"}), 500


# Delete reservation and cancel Redis jobs (admin only)
@app.route('/api/auth/admin/delete_reservation', methods=['DELETE'])
def delete_reservation():
    data = request.get_json()
    reservation_id = data.get('reservation_id')

    if not reservation_id:
        return jsonify({"message": "Reservation ID is required"}), 400

    try:
        reservation = Reservation.query.get(reservation_id)
        if not reservation:
            return jsonify({"message": "Reservation not found"}), 404

        # Cancel Redis jobs
        cancel_jobs(reservation_id)

        # Delete reservation (CASCADE will delete ReservationDevice entries)
        db.session.delete(reservation)
        db.session.commit()

        return jsonify({"message": "Reservation deleted successfully"}), 200
    except Exception as ex:
        db.session.rollback()
        app.logger.error(f"Error deleting reservation: {ex}")
        return jsonify({"message": "Failed to delete reservation"}), 500


if __name__ == '__main__':
    with app.app_context():
        # create tables on the DB, if they don't exist
        try:
            db.create_all()
            print("PostgresSQL Database tables created/checked.")
        except Exception as e:
            print(f"ERROR: Could not connect to PostgresSQL. Ensure the DB server is running and accessible: {e}")

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5000, use_reloader=False)