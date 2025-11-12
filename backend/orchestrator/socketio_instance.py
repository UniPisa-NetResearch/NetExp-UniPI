from flask_socketio import SocketIO
# shared orchestrator socket instance
socketio = SocketIO(
    #logger=True,
    cors_allowed_origins="http://localhost:5173",
    message_queue='redis://localhost:6379',
    async_mode='eventlet'
)
