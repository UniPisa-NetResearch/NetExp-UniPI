from flask import Flask, jsonify, request
from flask_cors import CORS
from ..database.db import db, Reservation
from datetime import datetime
from sqlalchemy import tuple_, and_

app = Flask(__name__)

DB_USER = 'root'
DB_PASSWORD = 'root'
DB_HOST = 'localhost'
DB_NAME = 'netexp_db'

app.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:5432/{DB_NAME}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'connect_timeout': 10}}

db.init_app(app)

# enable CORS for development frontend
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}}) #address for local development

@app.route('/api/orchestrator/checkReservation', methods=['POST'])
def check_reservation():
    """
    Receive JSON:
    {"username": "...",
      "startDate": "YYYY-MM-DD",
      "startTime": "HH:MM",
      "endDate": "YYYY-MM-DD",
      "endTime": "HH:MM",
      "devices": [...]}

    verifies if the reservation can be done for the selected time slot
    """
    data = request.get_json() or {}
    username = data.get('username')
    start_date = data.get('startDate')
    start_time = data.get('startTime')
    end_date = data.get('endDate')
    end_time = data.get('endTime')
    devices = data.get('devices', [])

    # basic validations
    if not all([username, start_date, start_time, end_date, end_time]):
        return jsonify({"ok": False, "message": "Missing fields"}), 400

    # parsing in datetime
    try:
        start_dt = datetime.strptime(f"{start_date} {start_time}", "%Y-%m-%d %H:%M")
        end_dt = datetime.strptime(f"{end_date} {end_time}", "%Y-%m-%d %H:%M")
    except ValueError:
        return jsonify({"ok": False, "message": "Invalid date/time format"}), 400

    # valid durations: >0 e <= 24h
    delta_seconds = (end_dt - start_dt).total_seconds()
    if delta_seconds <= 0 or delta_seconds > 24 * 3600:
        return jsonify({"ok": False, "message": "Invalid duration (must be >0 and <=24h)"}), 400

    now = datetime.now()

    # overlap test: res.start < requested_end  AND  res.end > requested_start
    # reservation terminated are ignored (res_end <= now)
    requested_start_tuple = (start_dt.date(), start_dt.time().replace(second=0, microsecond=0))
    requested_end_tuple = (end_dt.date(), end_dt.time().replace(second=0, microsecond=0))
    now_tuple = (now.date(), now.time())

    # if reservation table is not empty, check dates, otherwise create the reservation immediately
    first_row = db.session.query(Reservation.id).first()
    if first_row:
        # conditions for conflict
        conflict = Reservation.query.filter(
            and_(
                # res_start < requested_end
                tuple_(Reservation.startDate, Reservation.startTime) < requested_end_tuple,
                # res_end > requested_start
                tuple_(Reservation.endDate, Reservation.endTime) > requested_start_tuple,
                # res_end > now  (ignor terminated reservations)
                tuple_(Reservation.endDate, Reservation.endTime) > now_tuple
            )
        ).first() #take only the first one

        if conflict:
            # conflict found
            return jsonify({
                "ok": False,
                "message": "Requested slot overlaps an existing reservation",
                "conflict": {
                    "id": conflict.id,
                    "username": conflict.username,
                    "startDate": conflict.startDate.isoformat(),
                    "startTime": (conflict.startTime.strftime("%H:%M") if conflict.startTime else None),
                    "endDate": conflict.endDate.isoformat(),
                    "endTime": (conflict.endTime.strftime("%H:%M") if conflict.endTime else None)
                }
            }), 409

    # no conflict found, reservation creation
    new_res = Reservation(
        username=username,
        startDate=start_dt.date(),
        endDate=end_dt.date(),
        startTime=start_dt.time().replace(second=0, microsecond=0),
        endTime=end_dt.time().replace(second=0, microsecond=0)
    )

    db.session.add(new_res)
    try:
        db.session.commit()
        print("Reservation created id=%s user=%s devices=%s", new_res.id, username, devices)
        return jsonify({
            "ok": True,
            "message": "Reservation created",
            "id": new_res.id,
            "start": f"{start_date} {start_time}",
            "end": f"{end_date} {end_time}"
        }), 201

    except Exception as ex:
        db.session.rollback()
        # DB error
        app.logger.error(f"DB Error on adding registration: {ex}")
        return jsonify({"message": "An internal error occurred during registration."}), 500

if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5001)