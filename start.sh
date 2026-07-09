#!/bin/bash

LOG_DIR="execution_logs"

mkdir -p "$LOG_DIR"

for log in log_authentication log_orchestrator log_controller log_validator log_experimenter log_evaluator log_scheduler_runner log_agent_server log_rq_worker log_frontend; do
    : > "$LOG_DIR/${log}.txt"
done


PIDFILE="pids.txt"
: > "$PIDFILE"


start_bg() {
    local log_file="$1"
    shift
    setsid "$@" >> "$log_file" 2>&1 &
    pid=$!
    echo "$pid" >> "$PIDFILE"
    echo "Started: $*  PID=$pid LOG=$log_file"
}

start_bg "$LOG_DIR/log_authentication.txt" python3 -u -m backend.authentication.authentication
start_bg "$LOG_DIR/log_orchestrator.txt" python3 -u -m backend.orchestrator.orchestrator
start_bg "$LOG_DIR/log_controller.txt" python3 -u -m backend.controller.controller
start_bg "$LOG_DIR/log_validator.txt" python3 -u -m backend.controller.validator
start_bg "$LOG_DIR/log_experimenter.txt" python3 -u -m backend.controller.experimenter.experimenter
start_bg "$LOG_DIR/log_evaluator.txt" python3 -u -m backend.controller.evaluator.evaluator
start_bg "$LOG_DIR/log_scheduler_runner.txt" python3 -u -m backend.orchestrator.scheduler_runner
start_bg "$LOG_DIR/log_agent_server.txt" python3 -u -m backend.agent.agent_server
start_bg "$LOG_DIR/log_rq_worker.txt" rq worker -u redis://172.16.4.77:6379 default
start_bg "$LOG_DIR/log_frontend.txt" bash -c "cd frontend && exec npm run dev -- --host 0.0.0.0"
