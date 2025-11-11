from flask import Flask
from flask_cors import CORS
from database.db import db

DB_USER = 'root'
DB_PASSWORD = 'root'
DB_HOST = 'localhost'
DB_NAME = 'netexp_db'

def create_app():
    application = Flask(__name__)

    application.config['SQLALCHEMY_DATABASE_URI'] = f'postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:5432/{DB_NAME}'
    application.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
    # Aumenta timeout per connessioni lente in caso di avvio DB
    application.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'connect_args': {'connect_timeout': 10}}

    db.init_app(application)

    # enable CORS for development frontend, it is limited only for api endpoints
    # in this way, react app can call flask methods
    CORS(application, resources={r"/api/*": {"origins": "http://localhost:5173"}}) #address for local development

    return application

app = create_app()