import eventlet
eventlet.monkey_patch()
from flask import jsonify, request
from backend.orchestrator.socketio_instance import socketio
from backend.orchestrator.orchestrator_jobs import reservation_start_job, reservation_end_job
from ..database.db import db, User, Reservation, ReservationDevice
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import tuple_, and_, text
from sqlalchemy.exc import SQLAlchemyError
import os
import pynetbox
from redis import Redis
from rq import Queue
import json
import requests
import subprocess
import ipaddress
from ..app import app

NETBOX_URL = os.getenv("NETBOX_URL", "http://localhost:8080")
NETBOX_TOKEN = os.getenv("NETBOX_TOKEN", "6152fbb91529522c72307b194a690c4ca5253e93")

MAX_HOURS = 72
TEST = True                    #test mode, each reservation starts at current date + 2 min
EXPERIMENT_DURATION = 7        #expressed in minutes
NETBOX_SITE = "testbed"        # useful to change site of netbox
#NETBOX_SITE = "containerlab"
nb = pynetbox.api(NETBOX_URL, token=NETBOX_TOKEN)

REDIS_URL = "redis://localhost:6379"
redis = Redis.from_url(REDIS_URL)

#function to send reservation data to the controller
def send_to_controller(msg_type, user_id, reservation_id):
    with app.app_context():
        try:
            # fetch username and ssh_key
            user = db.session.get(User, user_id)
            if not user:
                print(f"User id {user_id} not found in DB; skipping controller call.")
                return
            username = getattr(user, "username", None)
            ssh_key = getattr(user, "ssh_key", None)
            full_user = getattr(user, "full_user", None)

            if msg_type == "granted":
                # read reservation devices
                try:
                    res_devs = ReservationDevice.query.filter_by(reservation_id=reservation_id).all()
                    asset_tags = [rd.asset_tag for rd in res_devs]
                except Exception as e:
                    print(f"Error reading ReservationDevice for reservation {reservation_id}: {e}")
                    asset_tags = []

                # build list of { "id_device": <asset_tag>, "ip_device": <ip>, "role": <role> }
                devices_list = []
                for at in asset_tags:
                    ip_addr = None
                    role = None
                    interface = None
                    try:
                        # try to fetch device by asset_tag first
                        dev = nb.dcim.devices.get(site=NETBOX_SITE, asset_tag=at)
                        if not dev:
                            # fallback: try by name
                            devs = nb.dcim.devices.filter(site=NETBOX_SITE, name=at)
                            dev = devs[0] if devs else None

                        if dev:
                            # primary_ip can be object-like or dict depending on pynetbox version
                            primary_ip = getattr(dev, "primary_ip", None)
                            if primary_ip:
                                ip = getattr(primary_ip, "address", None) or (
                                    primary_ip.get("address") if isinstance(primary_ip, dict) else None)
                                if ip:
                                    ip_addr = str(ip).split("/")[0]

                            role_obj = getattr(dev, "role", None)
                            # when it is an object with attributes
                            role = getattr(role_obj, "slug", None) or getattr(role_obj, "name", None)

                            role = role.lower() if role else None

                        if ip_addr:
                            try:
                                ip_objs = None

                                if ip:
                                    ip_objs = nb.ipam.ip_addresses.filter(address=ip)
                                # normalize ip_obj extraction
                                ip_obj = None
                                if ip_objs:
                                    if hasattr(ip_objs, "first"):
                                        ip_obj = ip_objs.first()
                                    else:
                                        ip_list = list(ip_objs)
                                        ip_obj = ip_list[0] if ip_list else None

                                if ip_obj:
                                    assigned = getattr(ip_obj, "assigned_object", None) or (
                                        ip_obj.get("assigned_object") if isinstance(ip_obj, dict) else None)
                                    if assigned:
                                        if isinstance(assigned, dict):
                                            interface = assigned.get("name") or assigned.get("display")
                                        else:
                                            interface = getattr(assigned, "name", None) or getattr(assigned, "display",
                                                                                                   None)
                            except Exception as e:
                                print(f"NetBox ip lookup error for ip {ip_addr}: {e}")
                    except Exception as e:
                        print(f"NetBox lookup error for asset_tag {at}: {e}")

                    devices_list.append({
                        "id_device": at,
                        "ip_device": ip_addr,
                        "role": role,
                        "interface": interface
                    })

                # prepare payload for controller
                grant_payload = {
                    "ssh_key": ssh_key,
                    "user_id": user_id,
                    "username": username,
                    "full_user": full_user,
                    "reservation_id": reservation_id,
                    "devices": devices_list
                }

                # send to controller
                try:
                    resp = requests.post("http://localhost:5002/api/controller/grantAccess", json=grant_payload, timeout=10)
                    if resp.status_code == 200:
                        print(f"grantAccess successful for user {user_id} reservation {reservation_id}: {resp.status_code}")
                    else:
                        print(f"grantAccess returned {resp.status_code} for user {user_id} reservation {reservation_id}: {resp.text}")
                except Exception as e:
                    print(f"Error calling grantAccess for reservation {reservation_id}: {e}")

            elif msg_type == "revoked":
                revoke_payload = {
                    "ssh_key": ssh_key,
                    "user_id": user_id,
                    "username": username,
                    "reservation_id": reservation_id
                }
                try:
                    resp = requests.post("http://localhost:5002/api/controller/revokeAccess", json=revoke_payload, timeout=10)
                    if resp.status_code == 200:
                        print(f"revokeAccess successful for user {user_id} reservation {reservation_id}: {resp.status_code}")
                    else:
                        print(
                            f"revokeAccess returned {resp.status_code} for user {user_id} reservation {reservation_id}: {resp.text}")
                except Exception as e:
                    print(f"Error calling revokeAccess for reservation {reservation_id}: {e}")
        except Exception as e:
            print("Unexpected error processing reservation event:", e)
            return

# listener function for messages published by start and end reservation jobs
def _redis_listener():
    pubsub = redis.pubsub(ignore_subscribe_messages=True)
    pubsub.subscribe("reservation_events")
    print("Subscribed to reservation_events channel")
    for message in pubsub.listen():
        try:
            data = json.loads(message['data'])           #read data sent from jobs
        except Exception as e:
            print("Bad message from redis:", e, message)
            continue

        # message validation
        msg_type = data.get("type")
        reservation_id = data.get("reservation_id")
        user_id = data.get("user_id")
        # ignore messages that are not referred to grant or revoke reservation
        if msg_type not in ("granted", "revoked"):
            print("Ignored message with unknown type:", msg_type, data)
            continue
        # ignore messages that do not contain user id and reservation id
        if reservation_id is None or user_id is None:
            print("Ignored message missing reservation_id or user_id:", data)
            continue
        # validation for type granted
        if msg_type == "granted":
            # required fields: token, expires_at
            if data.get("token") is None or data.get("expires_at") is None:
                print("Ignored 'granted' message missing token/expires_at:", data)
                continue

        # dispatch to room (es. 'user:2')
        user_room = f"user:{data.get('user_id')}"
        print("Redis -> emit to", user_room, data)
        # emit reservation event to the client in the connected user room
        socketio.emit("reservation_event", data, room=user_room)
        # send data to controller
        send_to_controller(msg_type, user_id, reservation_id)

socketio.init_app(app, cors_allowed_origins="http://localhost:5173")
import backend.orchestrator.orchestrator_ws_server                   # necessary to import socket handler after socketio initialization
eventlet.spawn(_redis_listener)

# to create a new queue with a specific name use: Queue(name='high', connection=Redis())
queue = Queue(connection=Redis())

def serialize_reservation(reservation):

    start_dt = datetime.combine(reservation.startDate, reservation.startTime)
    end_dt = datetime.combine(reservation.endDate, reservation.endTime)

    try:
        res_dev = ReservationDevice.query.filter_by(reservation_id=reservation.id).all()
        devices = [rd.asset_tag for rd in res_dev]
    except SQLAlchemyError:
        devices = []

    return {
        'id': reservation.id,
        #  ISO format 2025-10-30T10:00:00
        'startDate': start_dt.isoformat(),
        'endDate': end_dt.isoformat(),
        'devices': devices
    }

def ping_host(ip, count=2, per_ping_timeout=2, overall_timeout=5):
    # perform a ping to 'ip' to verify reachability
    try:
        # address validation
        ipaddress.ip_address(ip)
    except ValueError:
        return False
    if TEST:
        cmd = ["wsl", "ping", "-c", str(count), "-W", str(per_ping_timeout), str(ip)]
    else:
        cmd = ["ping", "-c", str(count), "-W", str(per_ping_timeout), str(ip)]

    try:
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=overall_timeout, check=False,)
        return proc.returncode == 0
    except subprocess.TimeoutExpired:
        return False

# endpoint to directly check connectivity
@app.route("/api/orchestrator/verifyHostAvailability", methods=["GET"])
def verify_host_availability_endpoint():
    ip = request.args.get("ip", None)
    if not ip:
        return jsonify({"ok": False, "message": "Missing 'ip' parameter"}), 400

    reachable = ping_host(ip)
    return jsonify({"ip": ip, "reachable": reachable}), 200

@app.route("/api/orchestrator/showDevices", methods=["GET"])
def show_devices():

    #Return JSON array of devices for testbed site
    try:

        # retrieve devices from testbed site
        devices = nb.dcim.devices.filter(site=NETBOX_SITE)

        out = []
        for d in devices:
            asset_tag = getattr(d, "asset_tag", None) or getattr(d, "name", None)

            primary_ip = getattr(d.primary_ip, "address", None) or (
                d.primary_ip.get("address") if isinstance(d.primary_ip, dict) else None
            )

            primary_ip = str(primary_ip).split("/")[0] if primary_ip else None

            role_obj = getattr(d, "role", None)
            # when it is an object with attributes
            role = getattr(role_obj, "slug", None) or getattr(role_obj, "name", None)

            role = role.lower() if role else None
            if primary_ip:
                # check if the host is reachable
                reachable = ping_host(primary_ip)
            else:
                reachable = False
            print(f"ip address: {primary_ip} - reachable: {reachable}")
            out.append({
                "name": getattr(d, "name", None),
                "asset_tag": asset_tag,
                "primary_ip": primary_ip,
                "role": role,
                "reachable": reachable
            })

        return jsonify(out), 200

    except Exception as exc:
        app.logger.exception("Error in show devices: %s", exc)
        return jsonify({"ok": False, "message": "Unable to fetch devices from NetBox"}), 500

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

    # if true, create a reservation from now + 2 minutes (start) to start + EXPERIMENT_DURATION
    if TEST:

        now = datetime.now()
        start_dt = now.replace(second=0, microsecond=0) + timedelta(minutes=2)
        end_dt = start_dt + timedelta(minutes=EXPERIMENT_DURATION)
        # necessary for date mismatch between server and redis
        now = datetime.now().astimezone(ZoneInfo("Europe/Rome"))
        future_start_dt = (now.replace(second=0, microsecond=0) + timedelta(minutes=2))
        start_dt_utc = future_start_dt.astimezone(timezone.utc)
        end_dt_utc = start_dt_utc + timedelta(minutes=EXPERIMENT_DURATION) - timedelta(seconds=1)   # -1 second to execute an end job before a start job scheduled at the same hour

        print("start_date = ", start_dt.strftime("%Y-%m-%d"))
        print("start_time = ", start_dt.strftime("%H:%M"))
        print("end_date = ", end_dt.strftime("%Y-%m-%d"))
        print("end_time = ", end_dt.strftime("%H:%M"))

    else:
        try:
            start_dt = datetime.strptime(f"{start_date} {start_time}", "%Y-%m-%d %H:%M")
            end_dt = datetime.strptime(f"{end_date} {end_time}", "%Y-%m-%d %H:%M")
            # format date for RQ
            rome_tz = ZoneInfo("Europe/Rome")
            temp_start_dt = start_dt
            temp_end_dt = end_dt

            start_dt_utc = temp_start_dt.replace(tzinfo=rome_tz).astimezone(timezone.utc)
            end_dt_utc = temp_end_dt.replace(tzinfo=rome_tz).astimezone(timezone.utc)
            end_dt_utc = end_dt_utc - timedelta(seconds=1)     # -1 second to execute an end job before a start job scheduled at the same hour

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
        endTime=end_dt.time().replace(second=0, microsecond=0),
        token=None
    )

    db.session.add(new_res)
    try:
        # flush to assign new_res.id to create child rows (commit not already done)
        db.session.flush()
        # take new reservation id
        reservation_id = new_res.id

        # create ReservationDevice rows
        for at in devices:
            rd = ReservationDevice(
                reservation_id=reservation_id,
                asset_tag=at
            )
            db.session.add(rd)

        db.session.commit()

        # job scheduling
        # each start job has an id like: res-12-start
        start_job_id = f"res-{reservation_id}-start"
        # start_dt_utc to avoid date mismatch
        queue.enqueue_at(start_dt_utc, reservation_start_job,reservation_id, job_id=start_job_id)
        print(f"Start job {start_job_id} scheduled for {start_dt}")

        # each end job has an id like: res-12-end
        end_job_id = f"res-{reservation_id}-end"
        # end_dt_utc to avoid date mismatch
        queue.enqueue_at(end_dt_utc, reservation_end_job,reservation_id, job_id=end_job_id)
        print(f"End job {end_job_id} scheduled for {end_dt}")

        print("Reservation created id=%s user=%s devices=%s",  reservation_id, username, devices)
        return jsonify({
            "ok": True,
            "message": "Reservation created",
            "id": reservation_id,
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
        reservation_to_delete = db.session.get(Reservation, reservation_id)

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

        start_job_id = f"res-{reservation_id}-start"
        end_job_id = f"res-{reservation_id}-end"
        # retrieve job from the queue
        start_job = queue.fetch_job(start_job_id)
        # check if job is scheduled
        if start_job and start_job.is_scheduled:
            start_job.cancel()
            print(f"job start {start_job_id} cancelled.")
        # retrieve job from the queue
        end_job = queue.fetch_job(end_job_id)
        if end_job and end_job.is_scheduled:
            end_job.cancel()
            app.logger.info(f"job end {end_job_id} cancelled.")

        db.session.delete(reservation_to_delete)
        db.session.commit()

        # reset sequence so the next inserted id is coherent
        # if the table is empty, lst attribute os setval is false, otherwise true
        reset_sql = text("""
                    WITH max_ids AS (
                        SELECT
                            (SELECT MAX(id) FROM reservation) AS max_res_id,
                            (SELECT MAX(id) FROM reservation_device) AS max_dev_id
                    )
                    SELECT setval(
                        pg_get_serial_sequence('reservation', 'id'),
                        COALESCE(t1.max_res_id, 1),
                        CASE 
                            WHEN t1.max_res_id IS NULL THEN FALSE  
                            ELSE TRUE
                        END
                    ) AS res_reset_value,
            
                   setval(
                        pg_get_serial_sequence('reservation_device', 'id'),
                        COALESCE(t1.max_dev_id, 1),
                        CASE 
                            WHEN t1.max_dev_id IS NULL THEN FALSE
                            ELSE TRUE
                        END
                    ) AS dev_reset_value
                    FROM max_ids AS t1;
                """)
        db.session.execute(reset_sql)
        db.session.commit()
        return jsonify({"message": "Reservation deleted successfully"}), 200

    except Exception as e:
        db.session.rollback()
        app.logger.error(f"Error deleting reservation {reservation_id}: {e}")
        return jsonify({"message": "Internal server error"}), 500

@app.route('/api/orchestrator/activeReservationStatus', methods=['POST'])
def get_active_reservation_status():
    # Check if the user has an active reservation token.

    data = request.get_json() or {}
    username = data.get('username')

    if not username:
        return jsonify({"ok": False, "message": "Missing username"}), 400

    now = datetime.now()
    now_tuple = (now.date(), now.time().replace(second=0, microsecond=0))

    # res_end > now & now > res_start (reservation is currently active)
    start_condition = tuple_(Reservation.startDate, Reservation.startTime) <= now_tuple
    end_condition = tuple_(Reservation.endDate, Reservation.endTime) >= now_tuple

    # check for an ACTIVE reservation (token assigned AND not ended yet)
    active_reservation = Reservation.query.filter(
        and_(
            Reservation.username == username,
            Reservation.token.isnot(None),
            start_condition,
            end_condition
        )
    ).order_by(Reservation.startDate.desc(), Reservation.startTime.desc()).first()

    if active_reservation:
        return jsonify({
            "ok": True,
            "isActive": True,
            "token": active_reservation.token,
            "reservation_id": active_reservation.id,
            # SO string: YYYY-MM-DDTHH:MM:SS
            "expires_at": f"{active_reservation.endDate.isoformat()}T{active_reservation.endTime.strftime('%H:%M:%S')}"
        }), 200

    # no active reservation
    return jsonify({
        "ok": True,
        "isActive": False
    }), 200

def remove_all_scheduled_jobs():

    # get all  scheduled job ID
    scheduled_job_ids = queue.scheduled_job_registry.get_job_ids()

    if not scheduled_job_ids:
        print("No scheduled job found")
        return 0

    jobs_removed = 0
    print(f"Found {len(scheduled_job_ids)} scheduled job. Removing...")

    for job_id in scheduled_job_ids:
        try:
            # retrieve job
            job = queue.fetch_job(job_id)
            if job:
                # remove job from Redis
                job.cancel()
                jobs_removed += 1

        except Exception as e:
            print(f"Error during job elimination{job_id}: {e}")

    print(f"Elimination completed. {jobs_removed}  scheduled job removed.")
    return jobs_removed

if __name__ == '__main__':
    #remove_all_scheduled_jobs()
    # host 0.0.0.0 often necessary in virtual environments or containers.
    #app.run(debug=True, host='0.0.0.0', port=5001)
    socketio.run(app, debug=True, host='0.0.0.0', port=5001, use_reloader=False)