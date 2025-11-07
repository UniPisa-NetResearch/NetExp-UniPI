from flask_socketio import SocketIO
from flask import request
from flask_socketio import emit, join_room, leave_room, disconnect
from ..database.db import User

socketio = SocketIO(
    logger=True,
    engineio_logger=True,
    cors_allowed_origins="http://localhost:5173",
    message_queue='redis://localhost:6379',
    async_mode='eventlet'
)

@socketio.on('connect')
def handle_connect():
    sid = getattr(request, 'sid', None)
    print(f"[socket] connect sid={sid} from {request.remote_addr}")
    # ask client to identify
    emit('connected', {"ok": True, "message": "connected, please send 'identify' with {user_id, username}"})

@socketio.on('identify')
def handle_identify(data):

    sid = getattr(request, 'sid', None)
    try:
        user_id = data.get('user_id')
        username = data.get('username')

        if not user_id and username:
            u = User.query.filter_by(username=username).first()
            if u:
                user_id = u.id
            else:
                emit('identify_ack', {"ok": False, "message": "username not found"})
                return

        if not user_id:
            emit('identify_ack', {"ok": False, "message": "user_id required"})
            return
        # connect to the user room
        room = f"user:{user_id}"
        join_room(room)
        print(f"[socket] sid={sid} joined room {room} (username={username})")
        emit('identify_ack', {"ok": True, "user_id": user_id})

    except Exception as e:
        print("Error in identify handler:", e)
        emit('identify_ack', {"ok": False, "message": "internal error"})

@socketio.on('logout')
def handle_logout(data):
    try:
        user_id = data.get('user_id')
        sid = getattr(request, 'sid', None)
        if user_id:
            room = f"user:{user_id}"
            leave_room(room)
            print(f"[socket] sid={sid} left room {room} on logout")

        disconnect()
    except Exception as e:
        print("Error in logout handler:", e)

@socketio.on('disconnect')
def handle_disconnect():
    sid = getattr(request, 'sid', None)
    print(f"[socket] disconnect sid={sid}")