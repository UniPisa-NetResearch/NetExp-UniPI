EXPERIMENT TEMPLATE PACKAGE
============================

This package contains:

1. experiment_template.yml
   - Base template for your experiment definition

2. iperf_client_example.yml
   - Example playbook showing how to capture iperf3 output
   - IMPORTANT: Follow this format to see iperf results in GUI

IPERF OUTPUT REQUIREMENTS:
- Files must be in: /tmp/iperf3_results/
- Files must match: iperf_flow_<FLOW_ID>_<HOSTNAME>.txt
- See iperf_client_example.yml for complete instructions
