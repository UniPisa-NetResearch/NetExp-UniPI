@echo off

:: 1) GUI terminal
wt -d . --title "GUI" cmd /k "cd frontend && npm run dev" ; ^
new-tab -d . --title "Authentication" cmd /k "python -m backend.authentication.authentication" ; ^
new-tab -d . --title "Orchestrator" cmd /k "python -m backend.orchestrator.orchestrator" ; ^
new-tab -d . --title "Controller" cmd /k "python -m backend.controller.controller" ; ^
new-tab -d . --title "Validator" cmd /k "python -m backend.controller.validator" ; ^
new-tab -d . --title "Experimenter" cmd /k "python -m backend.controller.experimenter.experimenter" ; ^
new-tab -d . --title "Evaluator" cmd /k "python -m backend.controller.evaluator.evaluator" ; ^
new-tab -d . --title "RQ Scheduler" cmd /k "rq worker --with-scheduler -u redis://localhost:6379 default --worker-class rq.worker.SimpleWorker"

echo All services are on starting phase...
exit