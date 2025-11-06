import uuid
from ..database.db import db, Reservation

def reservation_start_job(reservation_id):

    try:
        res = Reservation.query.get(reservation_id)
        if not res:
            print(f"Error: Reservation {reservation_id} not found.")
            return

        new_token = str(uuid.uuid4())
        res.token = new_token

        db.session.commit()
        print(f"Start Job: Token '{new_token[:8]}...' assigned to Reservation {reservation_id} (User: {res.username})")

        # ... Logica Controller ...

    except Exception as ex:
        db.session.rollback()
        print(f"Error during Start job for Reservation {reservation_id}: {ex}")

def reservation_end_job(reservation_id):

    try:
        res = Reservation.query.get(reservation_id)
        if not res:
            print(f"Error: Reservation {reservation_id} not found.")
            return

        res.token = None

        db.session.commit()
        print(f"End Job: Token removed from Reservation {reservation_id} (User: {res.username}). Testbed access revoked.")

        # 3. Chiamata al Controller per la pulizia (rollback allo snapshot0)
        # Esempio: call_controller_cleanup(res.username)

        # 4. Notifica il frontend via WebSocket (Logica omessa)

    except Exception as ex:
        db.session.rollback()
        print(f"Error during End job for Reservation {reservation_id}: {ex}")