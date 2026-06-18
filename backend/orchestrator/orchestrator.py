from gevent import monkey
monkey.patch_all()          
import gevent
from flask import jsonify, request
from backend.orchestrator.socketio_instance import socketio
from backend.orchestrator.orchestrator_jobs import reservation_start_job, reservation_end_job
from ..database.db import db, User, Reservation, ReservationDevice
from ..utils import get_next_available_id, resolve_netbox_device
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import tuple_, and_
from sqlalchemy.exc import SQLAlchemyError
import pynetbox
from redis import Redis
from redis.lock import Lock
from rq import Queue
from concurrent.futures import ThreadPoolExecutor
import json
import requests
import subprocess
import ipaddress
from ..app import app
from ..config import (
    NETBOX_URL, NETBOX_TOKEN, NETBOX_SITE_PHYSICAL, NETBOX_SITE_VIRTUAL, 
    REDIS_URL, REDIS_QUEUE_NAME, CONTROLLER_URL, FRONTEND_URL, LOCAL_TEST, 
    CONTAINERLAB_HOST, CONTAINERLAB_HOST_USER, TEST_MODE, TEST_DOUBLE_RES, EXPERIMENT_DURATION, MAX_HOURS
)

nb = pynetbox.api(NETBOX_URL, token=NETBOX_TOKEN)

redis = Redis.from_url(REDIS_URL)

# return the correct netbox site
def get_netbox_site(is_virtual: bool) -> str:
    return NETBOX_SITE_VIRTUAL if is_virtual else NETBOX_SITE_PHYSICAL

#function to send reservation data to the controller
def send_to_controller(msg_type, user_id, reservation_id, job_data):
    lock_key = "controller_playbook_execution_lock"
    lock_timeout = 600  # 10 minuti max per playbook execution (revoke + rollback può durare)
    blocking_timeout = 720  # 12 minuti max di attesa per acquisire il lock

    with app.app_context():
        try:
            # Acquire lock to serialize playbook execution
            lock = Lock(
                redis,
                lock_key,
                timeout=lock_timeout,
                blocking=True,
                blocking_timeout=blocking_timeout
            )

            acquired = lock.acquire(blocking=True, blocking_timeout=blocking_timeout)

            if not acquired:
                print(f"Failed to acquire lock for {msg_type} reservation {reservation_id} after {blocking_timeout}s")
                return

            try:
                # fetch username and ssh_key
                user = db.session.get(User, user_id)
                if not user:
                    print(f"User id {user_id} not found in DB; skipping controller call.")
                    return
                username = getattr(user, "username", None)
                ssh_key = getattr(user, "ssh_key", None)
                full_user = getattr(user, "full_user", None)

                res = db.session.get(Reservation, reservation_id)
                if not res:
                    print(f"Reservation {reservation_id} not found in DB.")
                    return

                # retrieve netbox site
                is_virtual = getattr(res, 'is_virtual', False)
                netbox_site = get_netbox_site(is_virtual)

                if msg_type == "granted":
                    # assign token to the reservation
                    res.token = job_data.get("token")
                    db.session.commit()
                    print(f"Token saved to DB for reservation {reservation_id}")

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
                        info = {"ip": None, "role": None, "interface": None}
                        try:
                            # try to fetch device by asset_tag first
                            dev = nb.dcim.devices.get(site=netbox_site, asset_tag=at)
                            if not dev:
                                # fallback: try by name
                                devs = nb.dcim.devices.filter(site=netbox_site, name=at)
                                dev = devs[0] if devs else None

                            if dev:
                                info = resolve_netbox_device(dev, nb=nb, fetch_interface=True)
                        except Exception as e:
                            print(f"NetBox lookup error for asset_tag {at}: {e}")

                        devices_list.append({
                            "id_device": at,
                            "ip_device": info["ip"],
                            "role": info["role"],
                            "interface": info.get("interface")
                        })

                    # prepare payload for controller
                    grant_payload = {
                        "ssh_key": ssh_key,
                        "user_id": user_id,
                        "username": username,
                        "full_user": full_user,
                        "reservation_id": reservation_id,
                        "devices": devices_list,
                        "is_virtual": is_virtual
                    }

                    # send to controller
                    try:
                        resp = requests.post(f"{CONTROLLER_URL}/api/controller/grantAccess", json=grant_payload, timeout=420)
                        if resp.status_code == 200:
                            print(f"grantAccess successful for user {user_id} reservation {reservation_id}: {resp.status_code}")
                        else:
                            print(f"grantAccess returned {resp.status_code} for user {user_id} reservation {reservation_id}: {resp.text}")
                    except Exception as e:
                        print(f"Error calling grantAccess for reservation {reservation_id}: {e}")

                elif msg_type == "revoked":

                    revoke_payload = {
                        "ssh_key": ssh_key,
                        "username": username,
                        "reservation_id": reservation_id,
                        "rollback": True                      # always run rollback when reservation expires (if the admin revoke the reservation, can choose to run rollback or not)
                    }

                    try:
                        resp = requests.post(f"{CONTROLLER_URL}/api/controller/revokeAccess", json=revoke_payload, timeout=420)
                        if resp.status_code == 200:
                            print(f"revokeAccess successful for user {user_id} reservation {reservation_id}: {resp.status_code}")
                        else:
                            print(
                                f"revokeAccess returned {resp.status_code} for user {user_id} reservation {reservation_id}: {resp.text}")
                    except Exception as e:
                        print(f"Error calling revokeAccess for reservation {reservation_id}: {e}")

                print(f"Lock releasing for {msg_type} reservation {reservation_id}")

            finally:
                # always release the lock
                lock.release()
                print(f"Lock released for {msg_type} reservation {reservation_id}")
                      
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
        send_to_controller(msg_type, user_id, reservation_id, data)

socketio.init_app(app, cors_allowed_origins=FRONTEND_URL)
import backend.orchestrator.orchestrator_ws_server                   # necessary to import socket handler after socketio initialization
gevent.spawn(_redis_listener)

# to create a new queue with a specific name use: Queue(name='high', connection=Redis())
redis_connection = Redis.from_url(REDIS_URL)
queue = Queue(REDIS_QUEUE_NAME, connection=redis_connection)

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
        'username': reservation.username,
        #  ISO format 2025-10-30T10:00:00
        'startDate': start_dt.isoformat(),
        'endDate': end_dt.isoformat(),
        'devices': devices
    }

def ping_host(ip, count=1, per_ping_timeout=1, overall_timeout=2, is_virtual=False):
    # perform a ping to 'ip' to verify reachability
    try:
        # address validation
        ipaddress.ip_address(ip)
    except ValueError:
        return False
    if LOCAL_TEST:
        cmd = ["wsl", "ping", "-c", str(count), "-W", str(per_ping_timeout), str(ip)]
    elif is_virtual:
        cmd = ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes", f"{CONTAINERLAB_HOST_USER}@{CONTAINERLAB_HOST}", "ping", "-c", str(count), "-W", str(per_ping_timeout), str(ip)]
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
    
    virtual_param = request.args.get("virtual", "false").strip().lower()
    is_virtual = virtual_param == "true"

    reachable = ping_host(ip, is_virtual=is_virtual)
    return jsonify({"ip": ip, "reachable": reachable}), 200

@app.route("/api/orchestrator/showDevices", methods=["GET"])
def show_devices():

    #Return JSON array of devices for testbed site
    try:
        virtual_param = request.args.get("virtual", "false").strip().lower()
        is_virtual = virtual_param == "true"
        netbox_site = get_netbox_site(is_virtual)
        # retrieve devices from testbed site
        devices = nb.dcim.devices.filter(site=netbox_site)
        
        # helper function to process each device and check reachability
        def process_device(d):
            info = resolve_netbox_device(d)

            # check if the host is reachable
            reachable = ping_host(info["ip"], is_virtual=is_virtual) if info["ip"] else False

            print(f"ip address: {info['ip']} - reachable: {reachable}")

            return {
                "name": info["name"],
                "asset_tag": info["asset_tag"],
                "primary_ip": info["ip"],
                "role": info["role"],
                "reachable": reachable
            }

        # execute ping in parallel (up to 15 simultaneous threads)
        with ThreadPoolExecutor(max_workers=15) as executor:
            out = list(executor.map(process_device, devices))
           
        return jsonify(out), 200

    except Exception as exc:
        app.logger.exception("Error in show devices: %s", exc)
        return jsonify({"ok": False, "message": "Unable to fetch devices from NetBox"}), 500

@app.route('/api/orchestrator/allReservations', methods=['GET'])
def all_reservations():
    # return all reservations for calendar view
    try:
        # get all reservations (or filter by end date > now if you want only active ones)
        reservations = Reservation.query.all()

        return jsonify([serialize_reservation(res) for res in reservations]), 200

    except Exception as e:
        app.logger.error(f"Error fetching all reservations: {e}")
        return jsonify({"message": "Error fetching reservations"}), 500

def create_reservation(reservation, next_id, username, start_dt, end_dt, is_virtual=False):

    res = reservation(
        id=next_id,
        username=username,
        startDate=start_dt.date(),
        endDate=end_dt.date(),
        startTime=start_dt.time().replace(second=0, microsecond=0),
        endTime=end_dt.time().replace(second=0, microsecond=0),
        token=None,
        is_virtual=is_virtual
    )
    return res

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
    is_virtual = bool(data.get("isVirtual", False))
    print("is_virtual= ", is_virtual)
    # basic validations
    if not all([username, start_date, start_time, end_date, end_time]):
        return jsonify({"ok": False, "message": "Missing fields"}), 400

    if TEST_DOUBLE_RES:
        rome_tz = ZoneInfo("Europe/Rome")
        now_local = datetime.now(rome_tz).replace(second=0, microsecond=0)

        # first reservation: starts now, duration specified
        first_start_dt = now_local + timedelta(minutes=2)
        first_end_dt = first_start_dt + timedelta(minutes=EXPERIMENT_DURATION)

        # second reservation: starts when first ends, same duration
        second_start_dt = first_end_dt
        second_end_dt = second_start_dt + timedelta(minutes=25)

        first_start_dt_utc = first_start_dt.astimezone(timezone.utc)
        first_end_dt_utc = (first_end_dt - timedelta(seconds=1)).astimezone(timezone.utc)

        second_start_dt_utc = second_start_dt.astimezone(timezone.utc)
        second_end_dt_utc = (second_end_dt - timedelta(seconds=1)).astimezone(timezone.utc)

        # create first reservation
        next_id_1 = get_next_available_id(Reservation)
        res1 = create_reservation(Reservation, next_id_1, username, first_start_dt, first_end_dt, is_virtual)

        db.session.add(res1)
        reservation_id = res1.id
        db.session.flush()

        for at in devices:
            rd = ReservationDevice(reservation_id=res1.id, asset_tag=at)
            db.session.add(rd)

        # create second reservation for verstappen
        next_id_2 = get_next_available_id(Reservation)
        res2 = create_reservation(Reservation, next_id_2, "verstappen", second_start_dt, second_end_dt, is_virtual)

        db.session.add(res2)
        db.session.flush()

        for at in devices:
            rd = ReservationDevice(reservation_id=res2.id, asset_tag=at)
            db.session.add(rd)

        db.session.commit()

        # reset sequence
        db.session.execute(db.text("""
                SELECT setval(pg_get_serial_sequence('reservation', 'id'), 
                             (SELECT MAX(id) FROM reservation), true);
            """))
        db.session.commit()

        # schedule jobs for first reservation
        start_job_id_1 = f"res-{res1.id}-start"
        queue.enqueue_at(first_start_dt_utc, reservation_start_job, res1.id, job_id=start_job_id_1)
        end_job_id_1 = f"res-{res1.id}-end"
        queue.enqueue_at(first_end_dt_utc, reservation_end_job, res1.id, job_id=end_job_id_1)

        # schedule jobs for second reservation
        start_job_id_2 = f"res-{res2.id}-start"
        queue.enqueue_at(second_start_dt_utc, reservation_start_job, res2.id, job_id=start_job_id_2)
        end_job_id_2 = f"res-{res2.id}-end"
        queue.enqueue_at(second_end_dt_utc, reservation_end_job, res2.id, job_id=end_job_id_2)

        print(f"TEST2: Created two reservations - ID {res1.id} ({username}) and ID {res2.id} (verstappen)")

        return jsonify({
            "ok": True,
            "message": "Reservation created",
            "id": reservation_id,
            "start": f"{first_start_dt.date()} {first_start_dt.time()}",
            "end": f"{first_end_dt.date()} {first_end_dt.time()}"
        }), 201

    # if true, create a reservation from now + 2 minutes (start) to start + EXPERIMENT_DURATION
    if TEST_MODE:
        # necessary for date mismatch between server and redis
        rome_tz = ZoneInfo("Europe/Rome")
        now_local = datetime.now(rome_tz).replace(second=0, microsecond=0)

        start_dt = now_local + timedelta(minutes=2)
        end_dt = start_dt + timedelta(minutes=EXPERIMENT_DURATION)

        start_dt_utc = start_dt.astimezone(timezone.utc)
        end_dt_utc = (end_dt - timedelta(seconds=1)).astimezone(timezone.utc)        # -1 second to execute an end job before a start job scheduled at the same hour

        print("start_date = ", start_dt.strftime("%Y-%m-%d"))
        print("start_time = ", start_dt.strftime("%H:%M"))
        print("end_date = ", end_dt.strftime("%Y-%m-%d"))
        print("end_time = ", end_dt.strftime("%H:%M"))

    else:
        try:
            temp_start_dt = datetime.strptime(f"{start_date} {start_time}", "%Y-%m-%d %H:%M")
            temp_end_dt = datetime.strptime(f"{end_date} {end_time}", "%Y-%m-%d %H:%M")

            # format date for RQ
            rome_tz = ZoneInfo("Europe/Rome")
            start_dt = temp_start_dt.replace(tzinfo=rome_tz)
            end_dt = temp_end_dt.replace(tzinfo=rome_tz)

            start_dt_utc = start_dt.astimezone(timezone.utc)
            end_dt_utc = (end_dt - timedelta(seconds=1)).astimezone(timezone.utc)        # -1 second to execute an end job before a start job scheduled at the same hour

        except ValueError:
            return jsonify({"ok": False, "message": "Invalid date/time format"}), 400

    # valid durations: >0 e <= MAX_HOURS
    delta_seconds = (end_dt - start_dt).total_seconds()
    if delta_seconds <= 0 or delta_seconds > MAX_HOURS * 3600:
        return jsonify({"ok": False, "message": f"Invalid duration (must be >0 and <={MAX_HOURS}h)"}), 400

    rome_tz = ZoneInfo("Europe/Rome")
    now = datetime.now(rome_tz)
    print(f"Current time: {now.isoformat()}, start_dt: {start_dt.isoformat()}, end_dt: {end_dt.isoformat()}")

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

    # Get next available ID (fills gaps)
    next_id = get_next_available_id(Reservation)
    # no conflict found, reservation creation
    new_res = create_reservation(Reservation, next_id, username, start_dt, end_dt, is_virtual)

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

        # Reset sequence to avoid conflicts
        db.session.execute(db.text("""
                   SELECT setval(pg_get_serial_sequence('reservation', 'id'), 
                                (SELECT MAX(id) FROM reservation), true);
               """))
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

        return jsonify({
            "reservations": [serialize_reservation(res) for res in reservations],
            "max_hours": MAX_HOURS
        }), 200
    
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
        
        rome_tz = ZoneInfo("Europe/Rome")
        current_dt = datetime.now(rome_tz).replace(tzinfo=None)
        print(f"Current time: {current_dt.isoformat()}, reservation_start_dt: {reservation_start_dt.isoformat()}")
        
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

    rome_tz = ZoneInfo("Europe/Rome")
    now = datetime.now(rome_tz)
    now_tuple = (now.date(), now.time().replace(second=0, microsecond=0))
    print(f"Checking active reservation for user {username} at {now.isoformat()}")

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
            #"is_virtual": active_reservation.is_virtual,
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