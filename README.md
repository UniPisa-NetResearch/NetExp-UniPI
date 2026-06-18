# Testbed Management Platform for Network Experiments

This platform allows users to reserve and manage a network testbed composed of **Edgecore switches (running SONiC)** and **Qotom Mini-PCs**. Users can provision devices, configure them via SSH or GUI, manage states with snapshots/rollbacks, and execute automated network experiments with real-time results observation.

---
## Installation & Setup for Distributed Deployment

Considering the following deployment:

- **VM NetExp1** for backend and frontend — username: `ubuntu` — IP address: `172.16.2.21` — RAM: 8GB — disk: 40GB
- **VM NetExp2** for backend services (**PostgreSQL**, **Redis**, **NetBox**) — username: `ubuntu` — IP address: `172.16.4.24` — RAM: 8GB — disk: 40GB
- **VM NetExp-containerlab** for containerlab deployment — username: `ubuntu` — IP address: `172.16.6.55` — RAM: 8GB — disk: 40GB

### NetExp1 Setup

#### Repository & SSH Access
1. Clone the project repository on **NetExp1**:
   ```bash
   git clone https://github.com/UniPisa-NetResearch/NetExp-UniPI.git
   ```
2. Create an SSH key:
   ```bash
   ssh-keygen -t ed25519
   ```
3. Paste the content of `~/.ssh/id_ed25519.pub` from **NetExp1** at the bottom of the `~/.ssh/authorized_keys` file on **NetExp2** and **NetExp-containerlab**.

#### Dependencies
1. Install Python essentials:
   ```bash
   sudo apt-get update
   sudo apt install -y python3.12 python3.12-venv python3.12-dev python3-pip build-essential
   ```
2. Install Node.js:
   ```bash
   sudo apt install -y curl ca-certificates gnupg
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
3. Verify the installation:
   ```bash
   node -v
   npm -v
   ```
4. Install Ansible and verify the installation:
   ```bash
   sudo apt install -y ansible
   ansible --version
   ```
5. Install `sshpass` for Ansible access to devices:
   ```bash
   sudo apt-get install sshpass
   ```
6. Install frontend packages:
   ```bash
   cd NetExp-UniPI/
   cd frontend
   npm ci
   ```
7. Create a virtual environment and install requirements:
   ```bash
   cd ~/NetExp-UniPI/
   python3 -m venv backend-venv
   source backend-venv/bin/activate
   pip3 install -r requirements.txt
   ```
8. Install `python3-rq` for Redis queue scheduling:
   ```bash
   sudo apt install python3-rq
   ```

#### Transfer Required Files
1. Send the `docker-compose.yml` file to **NetExp2**:
   ```bash
   scp NetExp-UniPI/docker-compose.yml ubuntu@172.16.4.77:~/
   ```
2. Send the NetBox database dump to **NetExp2**:
   ```bash
   scp NetExp-UniPI/backend/netbox/netbox.sql ubuntu@172.16.4.77:/tmp/netbox.sql
   ```
3. Send the containerlab topology file to **NetExp-containerlab**:
   ```bash
   scp NetExp-UniPI/backend/controller/controllerPlaybooks/containerlabTopology/topology.clab.yaml ubuntu@172.16.6.55:~/
   ```

### NetExp2 Setup

#### Docker & Services
1. Create the `NetExp-Services` folder:
   ```bash
   mkdir NetExp-Services
   mv docker-compose.yml NetExp-Services/
   ```
2. Install Docker:
   ```bash
   sudo apt-get update
   sudo apt-get install ca-certificates curl gnupg
   sudo install -m 0755 -d /etc/apt/keyrings
   curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
   sudo chmod a+r /etc/apt/keyrings/docker.gpg
   echo \
     "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
     $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
     sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   ```
3. Start the services with Docker Compose:
   ```bash
   cd NetExp-Services/
   sudo docker compose up -d
   sudo docker -v
   sudo docker compose ps
   ```

#### NetBox Initialization
1. Create an account on NetBox (**can be skipped**, directly included on point 3):
   ```bash
   sudo docker compose exec netbox /opt/netbox/netbox/manage.py createsuperuser
   sudo docker compose exec netbox /opt/netbox/netbox/manage.py changepassword admin
   ```

2. Create a v1 token through the NetBox GUI in the token API section (**can be skipped**, directly included on point 3).

3. Import the NetBox dump directly into the NetBox database:
   ```bash
   docker stop netexp-services-netbox-1
   docker exec -i netexp-services-netbox-db-1 dropdb -U netbox netbox
   docker exec -i netexp-services-netbox-db-1 createdb -U netbox netbox
   docker exec -i netexp-services-netbox-db-1 psql -U netbox netbox < /tmp/netbox.sql
   docker start netexp-services-netbox-1
   ```

4. Wait at least one minute before accessing NetBox to verify the data are correct.

5. To access NetBox GUI connect to `http://172.16.4.77:8080` with your browser and log in with   username: `admin` and password: `admin`

6. Install Redis tools for job scheduling:
   ```bash
   sudo apt install redis-tools
   ```

### NetExp-containerlab Setup

#### Docker & Containerlab
1. Install Docker as on **NetExp2**.
2. Install containerlab:
   ```bash
   sudo apt-get update
   curl -sL https://containerlab.dev/setup | sudo -E bash -s "all"
   ```
3. Download the latest version of `docker-sonic-vs.gz`:
   ```bash
   curl -L -o docker-sonic-vs.gz https://artprodcus3.artifacts.visualstudio.com/Af91412a5-a906-4990-9d7c-f697b81fc04d/be1b070f-be15-4154-aade-b1d3bfb17054/_apis/artifact/cGlwZWxpbmVhcnRpZmFjdDovL21zc29uaWMvcHJvamVjdElkL2JlMWIwNzBmLWJlMTUtNDE1NC1hYWRlLWIxZDNiZmIxNzA1NC9idWlsZElkLzExMjc3MzUvYXJ0aWZhY3ROYW1lL3NvbmljLWJ1aWxkaW1hZ2UudnM1/content?format=file&subpath=/target/docker-sonic-vs.gz
   ```
4. Create the SONiC container image:
   ```bash
   sudo docker load -i docker-sonic-vs.gz
   rm docker-sonic-vs.gz
   ```
5. Install the Ubuntu image for topology hosts:
   ```bash
   sudo docker pull ubuntu:22.04
   ```
6. Create the topology folder and move the topology file:
   ```bash
   mkdir testbed-sonic
   mv topology.clab.yaml testbed-sonic/
   ```
7. Deploy the virtual network:
   ```bash
   cd testbed-sonic/
   sudo containerlab deploy
   ```

### Starting the System

To start the system, create 9 terminals connected to **NetExp1**.

1. Start the frontend:
   ```bash
   cd NetExp-UniPI/
   cd frontend
   npm run dev -- --host 0.0.0.0
   ```
2. Start the authentication service:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.authentication.authentication
   ```
3. Start the orchestrator service:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.orchestrator.orchestrator
   ```
4. Start the controller service:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.controller.controller
   ```
5. Start the validator service:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.controller.validator
   ```
6. Start the experimenter service:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.controller.experimenter.experimenter
   ```
7. Start the evaluator service:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.controller.evaluator.evaluator
   ```
8. Start the scheduler runner:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   python3 -m backend.orchestrator.scheduler_runner
   ```
9. Start the Redis queue worker:
   ```bash
   cd NetExp-UniPI/
   source backend-venv/bin/activate
   rq worker -u redis://172.16.4.77:6379 default
   ```

### GUI Access

To access NetExp GUI connect to `http://172.16.2.21:5173` with your browser

### Device Access

When a reservation starts, the user can connect to each reserved device by using an SSH jump through **NetExp-containerlab**:

```bash
ssh -J ubuntu@172.16.6.55 <your_username>@<device_ip>
```

For example:

```bash
ssh -J ubuntu@172.16.6.55 gabripian@172.20.20.161
```

### Useful Tips

- To access the PostgreSQL database on **NetExp2**, run:
  ```bash
  docker exec -it netexp-services-db-1 psql -U root -d netexp_db
  ```
- To see scheduled jobs on Redis, use:
  ```bash
  redis-cli ZRANGEBYSCORE "rq:scheduled:default" -inf +inf WITHSCORES
  ```
- To cancel a scheduled job on Redis (for example the job named `res-18-end`), use:
  ```bash
  redis-cli ZREM "rq:scheduled:default" "res-18-end"
  ```
- To see a saved date on Redis (for example `1781456460`) in a readable format, use:
  ```bash
  date -d @1781456460
  ```
- To remove a device (for example `172.20.20.164`) from the `known_hosts` file when the virtual topology is redeployed, use:
  ```bash
  ssh-keygen -f '~/.ssh/known_hosts' -R '172.20.20.164'
  ```

---

## Installation & Setup for Local Deployment

### Prerequisites
1.  **Repository:** Clone this repository to your local machine.
2.  **Python:** Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```
3.  **Frontend:** Ensure **Node.js** and **React** are installed.
4.  **Windows Users (WSL):**
    * Docker Desktop must be configured with the **WSL 2 backend**.
    * **Ansible** must be installed within your WSL distribution.

### Starting the System
1.  Run the `docker-compose.yml` file within your WSL environment.
2.  Execute the startup script:
    ```bash
    ./start_system.bat
    ```
3.  Ensure your **VPN** is connected to access the testbed infrastructure.
4.  Open your browser and navigate to: `http://localhost:5173/`

---

## Workflow Example: BGP Failover Test

Follow these steps to run a complete end-to-end experiment.

### 1. Reservation
* Log in or create a new account.
* Go to the **Reservation** page.
* Select your desired date and time.
* Select at least two devices (select **all** devices to run the provided example experiment).
* Wait for the reservation time to start and provisioning to complete.

### 2. Device Access & Configuration
* **SSH Access:** Connect directly using your username and the Management IP found in the device list in Reservation section (ssh your_username@192.168.1.151).
* **GUI Configuration:**
    * Go to the **Configuration** page.
    * Navigate to the folder `experimentExamples/bgp_failover_complete_test`.
    * Click **Choose playbook** and select `configure_device_ip.yml`.
    * Click **Run playbook**.
    * Verify the configuration by connecting via SSH.

### 3. Snapshots & Rollback
* **Create Snapshot:** Enter a description in the **Insert description** field and click **Take snapshot**.
* **Test Rollback:**
    * Upload and run `configure_bgp.yml`.
    * To revert, select **snapshot1** and click **Rollback**. 
    * Verify that the BGP changes are removed and the state is restored.
* *Note:* For the full experiment, ensure both IP and BGP playbooks are successfully executed after testing the rollback. Repeat step 1 without 2 and 3 to create the correct configuration for the experiment.

### 4. Running the Experiment
1.  Go to the **Experiment** section and select **Free mode**.
2.  **Upload Logic:**
    * Click **Choose description** and select `bgp_failover_complete_test.yml`.
    * Click **Choose playbooks** and select: `collect_bgp_results.yml`, `cut_link.yml`, `restore_link.yml`, and `start_iperf_traffic.yml`.
    * Click **Upload template**.
3.  **Telemetry Setup:**
    * Go to the **Telemetry** section.
    * Click **Upload template** and select `bgp_failover_complete_test_telemetry.yml`.
    * In **Select experiment definition**, choose *bgp_failover_complete_test* and click **Generate telemetry file**.
4.  **Execution:**
    * In **Select experiment to run**, select *bgp_failover_complete_test*.
    * Click **Run experiment** and wait for completion.

### 5. Evaluation & Results
* Open the **Evaluation** page.
* **Visualization:** Select the metric fields you wish to observe and click **Generate Plot**.
* **Traffic Logs:** Select an iPerf flow to view the specific output.
* **Data Export:** Select devices (e.g., `sw1`, `sw2`, `sw5`) and click **Download NFS Data** to download the results in a `.zip` file.

To prevent accidental lockouts and protect the management interface, to some users is assigned a restricted environment. Use the following custom commands instead of standard Linux/SONiC ones:

* **`res_ip`**: Use this for IP address management.
* **`res_config`**: Use this for general system configurations.
* **`res_vtysh`**: Use this to access the routing stack shell (only inline mode with **-c** parameter is allowed, interactive mode is forbidden).

> **Note:** These commands are mandatory for restricted users as they specifically block any modification to the management interfaces, ensuring the testbed remains reachable at all times.


* **vtysh Shell:** If you configure BGP using the `vtysh` command line, the configurations are applied immediately to the routing stack. You can (and should) verify them using `show ip bgp` or `show running-config` within the `vtysh` environment.
* **Standard Linux Commands:** Even when configurations are active and functional, they may **not** be visible or detectable using standard Linux networking commands (like `ip route` or `ifconfig`) in some specific states of the SONiC database.
* **Actual State:** Despite not appearing in the standard Linux shell, the configurations are **effectively applied** to the hardware/ASIC and the routing engine. Always rely on `vtysh` as the "source of truth" for the network protocol status.