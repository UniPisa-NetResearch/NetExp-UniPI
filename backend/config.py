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

# netbox connection parameters
NETBOX_HOST = "172.16.4.77"
NETBOX_PORT = 8080
NETBOX_URL = "http://172.16.4.77:8080"
NETBOX_TOKEN = "6152fbb91529522c72307b194a690c4ca5253e93"
NETBOX_SITE_PHYSICAL = "testbed"                            # netbox site for physical testbed
NETBOX_SITE_VIRTUAL = "containerlab"                        # netbox site for virtual testbed

# frontend and backend connection parameters
FRONTEND_PORT = 5173
CONTROLLER_URL = "http://172.16.2.21:5002"
FRONTEND_URL = "http://172.16.2.21:5173"

# VM with containerlab and sonic images
CONTAINERLAB_HOST = "172.16.6.55"

#local tet mode flag
LOCAL_TEST = False                                  # if true, the deployment is on a single windows host, if false, the deployment is on different linux virtual machines

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