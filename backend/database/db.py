from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()

# User table
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(255), nullable=False)
    ssh_key = db.Column(db.Text, nullable=False)        # text preferred for long keys

    def set_password(self, plain_password):
        self.password = generate_password_hash(plain_password)

    def check_password(self, plain_password):
        return check_password_hash(self.password, plain_password)

    def __repr__(self):
        return '<User %r>' % self.username

# Reservation table
class Reservation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), nullable=False)
    # startDate/endDate = "YYYY-MM-DD"  => length 10
    # startTime/endTime = "HH:MM"       => length 5 (es. "08:00")
    startDate = db.Column(db.Date, nullable=False)
    endDate = db.Column(db.Date, nullable=False)
    startTime = db.Column(db.Time, nullable=False)
    endTime = db.Column(db.Time, nullable=False)


    def __repr__(self):
        return f'<Reservation id={self.id} user={self.username} start={self.start_date} {self.start_time} end={self.end_date} {self.end_time}>'