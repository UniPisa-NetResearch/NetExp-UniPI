import uuid
from ..database.db import db, Reservation, User
from ..app import create_app
import json
from redis import Redis

REDIS_URL = "redis://localhost:6379"
r = Redis.from_url(REDIS_URL)

def reservation_start_job(reservation_id):
    app = create_app()
    with app.app_context():
        try:
            res = Reservation.query.get(reservation_id)                      # get the reservation
            if not res:
                print(f"Error: Reservation {reservation_id} not found.")
                return

            # publish start reservation event on redis
            user = User.query.filter_by(username=res.username).first()
            if user:
                new_token = str(uuid.uuid4())
                payload = {
                    "type": "granted",
                    "reservation_id": reservation_id,
                    "token": new_token,
                    "user_id": user.id,
                    "expires_at": f"{res.endDate.isoformat()}T{res.endTime.strftime('%H:%M:%S')}"
                }
                r.publish("reservation_events", json.dumps(payload))
                print("Published reservation start on Redis")
            else:
                print("Warning: user not found for reservation; no websocket emitted.")

        except Exception as ex:
                db.session.rollback()
                print(f"Error during Start job for Reservation {reservation_id}: {ex}")

def reservation_end_job(reservation_id):
    app = create_app()
    with app.app_context():
        try:
            res = Reservation.query.get(reservation_id)                          # get the reservation
            if not res:
                print(f"Error: Reservation {reservation_id} not found.")
                return

            res.token = None                                                    # remove token

            db.session.commit()
            print(f"End Job: Token removed from Reservation {reservation_id} (User: {res.username}). Testbed access revoked.")

            # 3. Chiamata al Controller per la pulizia (rollback allo snapshot0)
            # Esempio: call_controller_cleanup(res.username)

            # publish end reservation event on redis
            user = User.query.filter_by(username=res.username).first()
            if user:
                payload = {
                    "type": "revoked",
                    "reservation_id": reservation_id,
                    "user_id": user.id
                }
                r.publish("reservation_events", json.dumps(payload))
                print("Published reservation start on Redis")

        except Exception as ex:
            db.session.rollback()
            print(f"Error during End job for Reservation {reservation_id}: {ex}")