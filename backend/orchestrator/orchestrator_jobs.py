import uuid
from ..database.db import db, Reservation, User
from .orchestrator_ws_server import socketio
from app import create_app

def reservation_start_job(reservation_id):
    app = create_app()
    with app.app_context():
        try:

            res = Reservation.query.get(reservation_id)                      # get the reservation
            if not res:
                print(f"Error: Reservation {reservation_id} not found.")
                return

            new_token = str(uuid.uuid4())
            res.token = new_token                                            # add token to the reservation

            db.session.commit()
            print(f"Start Job: Token '{new_token[:8]}...' assigned to Reservation {reservation_id} (User: {res.username})")

            # send websocket event to user:{user_id} room
            user = User.query.filter_by(username=res.username).first()
            if user:
                payload = {
                    "type": "granted",
                    "reservation_id": reservation_id,
                    "token": new_token,
                    "expires_at": f"{res.endDate.isoformat()}T{res.endTime.strftime('%H:%M:%S')}"
                }
                socketio.emit('reservation_event', payload, room=f"user:{user.id}")
                print(f"Emitted 'granted' event to user:{user.id}")
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

            # send websocket event to user:{user_id} room
            user = User.query.filter_by(username=res.username).first()
            if user:
                payload = {
                    "type": "revoked",
                    "reservation_id": reservation_id
                }
                socketio.emit('reservation_event', payload, room=f"user:{user.id}")
                print(f"Emitted 'revoked' event to user:{user.id}")

        except Exception as ex:
            db.session.rollback()
            print(f"Error during End job for Reservation {reservation_id}: {ex}")