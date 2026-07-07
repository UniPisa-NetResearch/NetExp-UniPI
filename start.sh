#!/bin/bash

for log in log_authentication log_orchestrator log_controller log_validator log_experimenter log_evaluator log_scheduler_runner log_agent_server log_rq_worker log_frontend; do
    : > "${log}.txt"
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

start_bg log_authentication.txt python3 -u -m backend.authentication.authentication
start_bg log_orchestrator.txt python3 -u -m backend.orchestrator.orchestrator
start_bg log_controller.txt python3 -u -m backend.controller.controller
start_bg log_validator.txt python3 -u -m backend.controller.validator
start_bg log_experimenter.txt python3 -u -m backend.controller.experimenter.experimenter
start_bg log_evaluator.txt python3 -u -m backend.controller.evaluator.evaluator
start_bg log_scheduler_runner.txt python3 -u -m backend.orchestrator.scheduler_runner
start_bg log_agent_server.txt python3 -u -m backend.agent.agent_server
start_bg log_rq_worker.txt rq worker -u redis://172.16.4.77:6379 default
start_bg log_frontend.txt bash -c "cd frontend && exec npm run dev -- --host 0.0.0.0"
