from flask import Flask
from flask_cors import CORS
from backend.database.db import db
from .config import DB_USER, DB_PASSWORD, DB_HOST, DB_NAME, DB_PORT, FRONTEND_URL

def create_app():
    application = Flask(__name__)

    application.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}'
    application.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    # Aumenta timeout per connessioni lente in caso di avvio DB
    application.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
        'connect_args': {'connect_timeout': 5},
        'pool_pre_ping': True,                              # check connection is active before querying
        'pool_recycle': 300                                 # recycle connections after 5 minutes to avoid stale connections
    }

    db.init_app(application)

    # enable CORS for development frontend, it is limited only for api endpoints
    # in this way, react app can call flask methods
    CORS(application, resources={r"/api/*": {"origins": FRONTEND_URL}}) #address for local development

    return application

app = create_app()