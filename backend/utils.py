from .database.db import db

def get_next_available_id(model_class):
    # Find the first available ID (fills gaps)
    try:
        # Find first gap in IDs
        result = db.session.execute(
            db.text(f"""
                SELECT COALESCE(
                    (SELECT MIN(t1.id + 1)
                     FROM "{model_class.__tablename__}" t1
                     WHERE NOT EXISTS (
                         SELECT 1 FROM "{model_class.__tablename__}" t2
                         WHERE t2.id = t1.id + 1
                     )),
                    COALESCE((SELECT MAX(id) + 1 FROM "{model_class.__tablename__}"), 1)
                ) AS next_id
            """)
        ).scalar()

        return result if result else 1
    except Exception as e:
        print(f"Error finding next available ID: {e}")
        # Fallback: use max + 1
        max_id = db.session.query(db.func.max(model_class.id)).scalar()
        return (max_id or 0) + 1