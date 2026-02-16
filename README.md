# Testbed Management Platform for Network Experiments

This platform allows users to reserve and manage a network testbed composed of **Edgecore switches (running SONiC)** and **Qotom Mini-PCs**. Users can provision devices, configure them via SSH or GUI, manage states with snapshots/rollbacks, and execute automated network experiments with real-time results observation.

---

## Installation & Setup

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