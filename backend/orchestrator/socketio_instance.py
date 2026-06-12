from flask_socketio import SocketIO
from ..config import REDIS_URL, FRONTEND_URL
# shared orchestrator socket instance
socketio = SocketIO(
    #logger=True,
    cors_allowed_origins=FRONTEND_URL,
    message_queue=REDIS_URL,
    async_mode='eventlet'
)
