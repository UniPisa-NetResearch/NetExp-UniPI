import os
from dotenv import load_dotenv
from pathlib import Path

# load backend/.env
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# database connection parameters
DB_HOST = "172.16.4.77"
DB_PORT = 5432
DB_NAME = "netexp_db"
DB_USER = "root"
DB_PASSWORD = "root"

# redis connection parameters
REDIS_HOST = "172.16.4.77"
REDIS_PORT = 6379
REDIS_DB = 0
REDIS_URL = "redis://172.16.4.77:6379"
REDIS_QUEUE_NAME = "default"

# netbox connection parameters
NETBOX_HOST = "172.16.4.77"
NETBOX_PORT = 8080
NETBOX_URL = "http://172.16.4.77:8080"
NETBOX_TOKEN = "WpM1oQ5v5EJGbrsnMP8XUJPwBYOQCME80NwsGNYa"
NETBOX_SITE_PHYSICAL = "testbed"                            # netbox site for physical testbed
NETBOX_SITE_VIRTUAL = "containerlab"                        # netbox site for virtual testbed

# frontend and backend connection parameters
FRONTEND_PORT = 5173
CONTROLLER_URL = "http://172.16.2.21:5002"
FRONTEND_URL = "http://172.16.2.21:5173"
AGENT_SERVER_URL = "http://172.16.2.21:5006"

# VM with containerlab and sonic images
CONTAINERLAB_HOST = "172.16.6.55"
CONTAINERLAB_HOST_USER = "ubuntu"                   # user for ssh connection to the containerlab host

#local tet mode flag
LOCAL_TEST = False                                  # if true, the deployment is on a single windows host, if false, the deployment is on different linux virtual machines

# authentication public key types accepted
SUPPORTED_KEY_TYPES = ['ssh-ed25519', 'ssh-rsa']

# orchestrator parameters
TEST_MODE = True                                # test mode, each reservation starts at current date + 2 min
TEST_DOUBLE_RES = False                         # test two consecutive reservations mode
EXPERIMENT_DURATION = 420                       # expressed in minutes
MAX_HOURS = 72                                  # maximum duration of a reservation in hours
                                                # if changed, also change in Reservation.jsx line 11

# default credentials per device role
SONIC_USER = "admin"
SONIC_PASS = "YourPaSsWoRd"
MINIPC_USER = "oem"
MINIPC_PASS = "oem123"

# NFS server parameters
NAS_EXPORT_BASE = "/export"
NAS_IP = "192.168.1.166"                            # IP of the nfs server
NAS_MOUNT_BASE = "/mnt/nas"                         # local mount point on devices
NFS_OPTS = "rw,sync,hard,intr,timeo=600,retrans=2"
USER_QUOTA_BYTES =536870912

# LLM parameters
LLM_MODEL = "deepseek-v4-flash:cloud"                           
AVAILABLE_MODELS = ["gemini-3.1-flash-lite", "glm-5.1:cloud", "deepseek-v4-flash:cloud", "qwen3.5:397b-cloud", "deepseek-v4-pro:cloud", "gemma4:cloud"]
OPENAI_API_KEY = os.getenv("GEMINI_API_KEY")        
AVAILABLE_BASE_URLS = ["https://generativelanguage.googleapis.com/v1beta/openai/", "http://localhost:11434/v1"]
SAFETY_ITERATIONS = 3
JSON_RETRIES = 3
PHASES_ORDER = ['negotiation', 'planning', 'safety', 'execution']
AGENT_NAMES = {
    "negotiation": "Intent Analyst",
    "planning": "Action Planner",
    "safety": "Compliance Auditor",
    "execution": "Execution Reporter"
}
DIAGNOSTIC_ASSISTANT_PHASES_ORDER = ["diagnostic_intent", "diagnostic_planner", "execution", "diagnostic_reporter"]
LLM_TIMEOUT_SECONDS = 300
LLM_MAX_OUTPUT_TOKENS = 16384                                   #16384 - 32768
MAX_DIAGNOSTIC_ASSISTANT_MESSAGES = 10