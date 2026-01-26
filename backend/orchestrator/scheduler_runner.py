import time
import sys
from redis import Redis
from rq import Queue
from datetime import datetime
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [SCHEDULER] %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)

REDIS_URL = "redis://localhost:6379"
POLL_INTERVAL = 1  # seconds
QUEUE_NAME = "default"

def move_scheduled_jobs_to_queue():
    # move ready jobs in main queue
    redis_connection = Redis.from_url(REDIS_URL)
    queue = Queue(QUEUE_NAME, connection=redis_connection)

    current_timestamp = time.time()
    moved_count = 0

    # access to the Redis sorted set
    key_scheduled = f"rq:scheduled:{QUEUE_NAME}"

    # get every job with score <= current_timestamp
    # ZRANGEBYSCORE returns: [(job_id, score), ...]
    ready_jobs = redis_connection.zrangebyscore(
        key_scheduled,
        '-inf',
        current_timestamp,
        withscores=True
    )

    if not ready_jobs:
        return 0

    logging.info(f"Found {len(ready_jobs)} job(s) ready to execute")

    for job_id_bytes, scheduled_timestamp in ready_jobs:
        job_id = job_id_bytes.decode('utf-8') if isinstance(job_id_bytes, bytes) else job_id_bytes

        try:
            # fetch job object
            job = queue.fetch_job(job_id)

            if not job:
                logging.warning(f"Job {job_id} not found, removing from schedule")
                redis_connection.zrem(key_scheduled, job_id)
                continue

            # log
            scheduled_dt = datetime.fromtimestamp(scheduled_timestamp)
            logging.info(f"Moving job {job_id} to queue (scheduled: {scheduled_dt})")

            # remove from scheduled sorted set
            redis_connection.zrem(key_scheduled, job_id)

            # add to main queue
            queue.enqueue_job(job)
            moved_count += 1

        except Exception as e:
            logging.error(f"Error processing job {job_id}: {e}")
            # remove from schedule to avoid infinite loop
            redis_connection.zrem(key_scheduled, job_id)

    return moved_count

if __name__ == '__main__':
    logging.info("Starting custom RQ scheduler...")
    logging.info(f"Polling interval: {POLL_INTERVAL} second(s)")
    logging.info("Press Ctrl+C to stop")

    try:
        redis_conn = Redis.from_url(REDIS_URL)
        redis_conn.ping()
        logging.info("Redis connection succeeded")

        scheduled_key = f"rq:scheduled:{QUEUE_NAME}"
        count = redis_conn.zcard(scheduled_key)
        logging.info(f"Scheduled jobs: {count}")

        while True:
            try:
                moved = move_scheduled_jobs_to_queue()
                if moved > 0:
                    logging.info(f"Moved {moved} job in the queue")

            except Exception as e:
                logging.error(f"Error in loop scheduler: {e}")

            time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        logging.info("Scheduler stopped by user")
    except Exception as e:
        logging.error(f"Error: {e}")
        raise