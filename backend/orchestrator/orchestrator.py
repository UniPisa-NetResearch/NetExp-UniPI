from flask import Flask, jsonify, request
from flask_cors import CORS
from ..database.db import db, Reservation
from datetime import datetime
from sqlalchemy import tuple_, and_, text
app = Flask(__name__)

DB_USER = 'root'
DB_PASSWORD = 'root'
DB_HOST = 'localhost'
DB_NAME = 'netexp_db'

MAX_HOURS = 72

app.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:5432/{DB_NAME}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'connect_timeout': 10}}

db.init_app(app)

# enable CORS for development frontend
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}}) #address for local development


def serialize_reservation(reservation):

    start_dt = datetime.combine(reservation.startDate, reservation.startTime)
    end_dt = datetime.combine(reservation.endDate, reservation.endTime)

    return {
        'id': reservation.id,
        #  ISO format 2025-10-30T10:00:00
        'startDate': start_dt.isoformat(),
        'endDate': end_dt.isoformat(),
    }

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

    # valid durations: >0 e <= MAX_HOURS
    delta_seconds = (end_dt - start_dt).total_seconds()
    if delta_seconds <= 0 or delta_seconds > MAX_HOURS * 3600:
        return jsonify({"ok": False, "message": f"Invalid duration (must be >0 and <={MAX_HOURS}h)"}), 400

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
        ).all() #take all conflicts

        if conflict and len(conflict) > 0:
            # conflict found
            conflicts = []
            for r in conflict:
                conflicts.append({
                    "startDate": r.startDate.isoformat(),
                    "startTime": (r.startTime.strftime("%H:%M") if r.startTime else None),
                    "endDate": r.endDate.isoformat(),
                    "endTime": (r.endTime.strftime("%H:%M") if r.endTime else None)
                })

            return jsonify({
                "ok": False,
                "message": "Requested slot overlaps an existing reservations",
                "conflicts": conflicts
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

@app.route('/api/orchestrator/userResList', methods=['POST'])
def user_reservation_list():
    data = request.get_json()
    current_username = data.get('username')

    try:
        reservations = Reservation.query.filter_by(username=current_username).all()

        # order by start date/hour asc
        reservations.sort(key=lambda r: datetime.combine(r.startDate, r.startTime))

        return jsonify([serialize_reservation(res) for res in reservations])
    except Exception as e:
        app.logger.error(f"Error fetching user reservations: {e}")
        return jsonify({"message": "Error fetching reservations"}), 500


@app.route('/api/orchestrator/deleteReservation', methods=['POST'])
def delete_reservation():
    data = request.get_json()
    reservation_id = data.get('reservationId')

    if not reservation_id:
        return jsonify({"message": "Missing reservationId"}), 400

    try:
        reservation_to_delete = Reservation.query.get(reservation_id)

        if not reservation_to_delete:
            return jsonify({"message": "Reservation not found"}), 404

        reservation_start_dt = datetime.combine(
            reservation_to_delete.startDate,
            reservation_to_delete.startTime
        )
        current_dt = datetime.now()
        if current_dt >= reservation_start_dt:
            return jsonify({
                "message": "Cannot delete: reservation is already in progress or has finished."
            }), 403  # HTTP 403 Forbidden

        db.session.delete(reservation_to_delete)
        db.session.commit()

        # reset sequence so the next inserted id is coherent
        reset_sql = text("""
                    SELECT setval(
                        pg_get_serial_sequence('reservation', 'id'),
                        COALESCE((SELECT MAX(id) FROM reservation), 0),
                        true
                    );
                """)
        db.session.execute(reset_sql)
        db.session.commit()
        return jsonify({"message": "Reservation deleted successfully"}), 200

    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error deleting reservation {reservation_id}: {e}")
        return jsonify({"message": "Internal server error"}), 500



if __name__ == '__main__':

    # host 0.0.0.0 often necessary in virtual environments or containers.
    app.run(debug=True, host='0.0.0.0', port=5001)