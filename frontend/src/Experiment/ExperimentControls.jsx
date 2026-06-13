// ExperimentControls.jsx
import React, {useEffect} from 'react';

export default function ExperimentControls({
    experimentTimer,
    setExperimentTimer,
    experimentDefinitions,
    selectedExperimentDefinitionRun,
    setSelectedExperimentDefinitionRun,
    experimentRunMessage,
    setExperimentRunMessage,
    experimentRunMessageType,
    setExperimentRunMessageType,
    runningExperiment,
    setRunningExperiment,
    waitOperation,
    setWaitOperation,
    currentExperimentId,
    setCurrentExperimentId,
    username,
    reservation_id,
    timerIntervalRef,
    batchMode,
    setBatchMode,
    selectedExperiments,
    setSelectedExperiments,
    batchTotalDuration,
    setBatchTotalDuration
}) {
    const experimentEndTimeRef = React.useRef(null);
    const [currentExperimentName, setCurrentExperimentName] = React.useState('');
    const [isExperimentStopping, setIsExperimentStopping] = React.useState(false);
    const [isCleaningUp, setIsCleaningUp] = React.useState(false);
    const statusPollingIntervalRef = React.useRef(null);
    const cleanupPollingIntervalRef = React.useRef(null);

    // function to format time for timer
    const formatTime = (totalSeconds) => {
        if (totalSeconds < 0) totalSeconds = 0;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    useEffect(() => {
        if (batchMode && selectedExperiments.length > 0) {
            const fetchDurations = async () => {
                try {
                    const response = await fetch('/api/experimenter/calculateBatchDuration', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            experiments: selectedExperiments.map(e => {
                                const filename = e.filename;
                                return filename.endsWith('.yml') || filename.endsWith('.yaml')
                                    ? filename.substring(0, filename.lastIndexOf('.'))
                                    : filename;
                            }),
                            reservation_id: reservation_id
                        })
                    });
                    const data = await response.json();
                    if (data.success) {
                        setBatchTotalDuration(data.total_duration_s);
                    }
                } catch (error) {
                    console.error('Error calculating batch duration:', error);
                }
            };
            fetchDurations();
        } else {
            setBatchTotalDuration(0);
        }
    }, [selectedExperiments, batchMode, reservation_id, setBatchTotalDuration]);

    // check if there is an active experiment
    useEffect(() => {
        const checkExperimentStatus = async () => {

            if (!reservation_id) return;

            try {
                const response = await fetch('/api/experimenter/getExperimentStatus', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reservation_id })
                });

                const data = await response.json();

                if (data.success && !data.clean_ended && !data.stopping && !data.running) {
                    // cleanup
                    setRunningExperiment(true);
                    setIsCleaningUp(true);
                    setCurrentExperimentId(data.experiment_id);
                    setCurrentExperimentName(data.experiment_name);
                    setExperimentRunMessage(`Experiment "${data.experiment_name}" completed with success, waiting for cleanup...`);
                    setExperimentRunMessageType('success');
                    setExperimentTimer('--:--:--');

                    if (timerIntervalRef.current) {
                        clearInterval(timerIntervalRef.current);
                        timerIntervalRef.current = null;
                    }
                    // start cleanup polling
                    if (!cleanupPollingIntervalRef.current) {
                        console.log('Starting cleanup polling after page reload');
                        cleanupPollingIntervalRef.current = setInterval(() => {
                            pollCleanupStatus(data.experiment_id, data.experiment_name);
                        }, 2000);
                    }
                    return;
                }
                if (data.success && data.clean_ended && !data.stopping && !data.running) {
                    // cleanup completed, apply reset
                    setRunningExperiment(false);
                    setIsCleaningUp(false);
                    setCurrentExperimentId(null);
                    setCurrentExperimentName('');
                    setExperimentTimer('--:--:--');
                    setExperimentRunMessage('');
                    setExperimentRunMessageType('');

                    if (cleanupPollingIntervalRef.current) {
                        clearInterval(cleanupPollingIntervalRef.current);
                        cleanupPollingIntervalRef.current = null;
                    }
                    if (statusPollingIntervalRef.current) {
                        clearInterval(statusPollingIntervalRef.current);
                        statusPollingIntervalRef.current = null;
                    }
                    return;
                }

                if (data.success && data.stopping) {
                    setRunningExperiment(true);
                    setIsExperimentStopping(true);
                    setCurrentExperimentId(data.experiment_id);
                    setCurrentExperimentName(data.experiment_name);

                    setExperimentRunMessage(`Experiment "${data.experiment_name}" is stopping. Please wait...`);
                    setExperimentRunMessageType('warning');
                    setExperimentTimer('--:--:--');

                    if (timerIntervalRef.current) {
                        clearInterval(timerIntervalRef.current);
                        timerIntervalRef.current = null;
                    }
                    if (!statusPollingIntervalRef.current) {
                        console.log('Starting polling for stopping experiment');
                        statusPollingIntervalRef.current = setInterval(() => {
                            checkExperimentStatus();
                        }, 2000);
                    }
                } else if (data.success && data.running) {
                    // the experiment is running and not concluded yet
                    const expId = data.experiment_id;
                    const remainingSeconds = data.remaining_seconds;
                    setRunningExperiment(true);
                    setIsExperimentStopping(false);
                    setCurrentExperimentId(data.experiment_id);
                    setCurrentExperimentName(data.experiment_name);

                    if (data.is_batch) {
                        setExperimentRunMessage(`Batch in progress: "${data.current_experiment}" (${data.total_experiments} experiments total)`);
                    } else {
                        setExperimentRunMessage(`Experiment "${data.experiment_name}" in progress`);
                    }
                    setExperimentRunMessageType('success');

                    if (statusPollingIntervalRef.current) {
                        console.log('Stopping polling - experiment is running normally');
                        clearInterval(statusPollingIntervalRef.current);
                        statusPollingIntervalRef.current = null;
                    }

                    experimentEndTimeRef.current = Date.now() + (remainingSeconds * 1000);
                    if (timerIntervalRef.current) {
                        clearInterval(timerIntervalRef.current);
                    }

                    const updateExperimentTimer = () => {
                        if (!experimentEndTimeRef.current) {
                            setExperimentTimer('--:--:--');
                            return;
                        }

                        const now = Date.now();
                        const diffMs = experimentEndTimeRef.current - now;
                        const timeLeft = Math.max(0, Math.floor(diffMs / 1000));

                        if (timeLeft <= 0) {
                            clearInterval(timerIntervalRef.current);
                            timerIntervalRef.current = null;
                            experimentEndTimeRef.current = null;
                            setExperimentTimer('--:--:--');
                            setIsCleaningUp(true);
                            setExperimentRunMessage(`Experiment "${data.experiment_name}" completed with success, waiting for cleanup...`);
                            setExperimentRunMessageType('success');

                            // update the experiment status on database if it is ended
                            fetch('/api/experimenter/updateExperimentStatus', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({
                                    reservation_id: reservation_id,
                                    experiment_id: expId
                                })
                            }).then(() => {
                                console.log('Experiment status updated to completed');
                                if (!cleanupPollingIntervalRef.current) {
                                    cleanupPollingIntervalRef.current = setInterval(() => {
                                        pollCleanupStatus(expId, data.experiment_name);
                                    }, 2000);
                                }
                            }).catch(error => {
                                console.error('Error updating experiment status:', error);
                            });
                        } else {
                            setExperimentTimer(formatTime(timeLeft));
                        }
                    };
                    // initial update
                    updateExperimentTimer();

                    // start interval
                    timerIntervalRef.current = setInterval(updateExperimentTimer, 1000);

                } else if (data.just_completed) {
                    // the experiment has ended
                    setCurrentExperimentId(null);
                    setExperimentRunMessage(`Experiment "${data.experiment_name}" completed`);
                    setExperimentRunMessageType('success');
                    setExperimentTimer('--:--:--');
                    setRunningExperiment(false);
                    setIsExperimentStopping(false);
                    if (statusPollingIntervalRef.current) {
                        console.log('Stopping polling - experiment completed');
                        clearInterval(statusPollingIntervalRef.current);
                        statusPollingIntervalRef.current = null;
                    }
                    if (cleanupPollingIntervalRef.current) {
                        clearInterval(cleanupPollingIntervalRef.current);
                        cleanupPollingIntervalRef.current = null;
                    }
                } else {

                    console.log('Experiment removed after stopping - unlocking page');

                    setRunningExperiment(false);
                    setIsExperimentStopping(false);
                    setCurrentExperimentId(null);
                    setCurrentExperimentName('');
                    setExperimentTimer('--:--:--');
                    setExperimentRunMessage('');
                    setExperimentRunMessageType('');

                    if (statusPollingIntervalRef.current) {
                        console.log('Stopping polling - no experiment found');
                        clearInterval(statusPollingIntervalRef.current);
                        statusPollingIntervalRef.current = null;
                    }
                    if (cleanupPollingIntervalRef.current) {
                        clearInterval(cleanupPollingIntervalRef.current);
                        cleanupPollingIntervalRef.current = null;
                    }
                }

            } catch (error) {
                console.error('Error checking experiment status:', error);
            }
        };

        checkExperimentStatus();

        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
            if (statusPollingIntervalRef.current) {
                clearInterval(statusPollingIntervalRef.current);
            }
            if (cleanupPollingIntervalRef.current) {
                clearInterval(cleanupPollingIntervalRef.current);
            }
        };
    }, [reservation_id]);
    // update timer
    useEffect(() => {
        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
        };
    }, []);
    // check cleanup status
    const pollCleanupStatus = async (expId, expName) => {
        try {
            const response = await fetch('/api/experimenter/getExperimentStatus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id })
            });

            const data = await response.json();

            if (data.success && data.clean_ended === true) {
                if (cleanupPollingIntervalRef.current) {
                    clearInterval(cleanupPollingIntervalRef.current);
                    cleanupPollingIntervalRef.current = null;
                }

                setIsCleaningUp(false);
                setRunningExperiment(false);
                setCurrentExperimentId(null);
                setCurrentExperimentName('');
                setExperimentTimer('--:--:--');
                setExperimentRunMessage(`Cleanup of ${expName} completed`);
                setExperimentRunMessageType('success');

                setTimeout(() => {
                    setExperimentRunMessage('');
                    setExperimentRunMessageType('');
                }, 2000);
            }
        } catch (error) {
            console.error('Error polling cleanup status:', error);
        }
    };

    // run the selected experiment
    const handleRunExperiment = async () => {
        setExperimentRunMessage('');
        setExperimentRunMessageType('');

        if (batchMode) {
            if (selectedExperiments.length === 0) {
              setExperimentRunMessage('Error: please select at least one experiment for batch');
              setExperimentRunMessageType('error');
              return;
            }
        } else {
            if (!experimentDefinitions || experimentDefinitions.length === 0) {
                setExperimentRunMessage('Error: no experiment definitions available');
                setExperimentRunMessageType('error');
                return;
            }
            if (!selectedExperimentDefinitionRun || selectedExperimentDefinitionRun === '') {
                setExperimentRunMessage('Error: please select an experiment to run');
                setExperimentRunMessageType('error');
                return;
            }
        }

        setWaitOperation(true);

        try {
            const payload = {
                reservation_id: reservation_id,
                username: username
            };

            if (batchMode) {
                // list of names in batch mode
                payload.experiment_names = selectedExperiments.map(e => {
                    const filename = e.filename;
                    return filename.endsWith('.yml') || filename.endsWith('.yaml')
                        ? filename.substring(0, filename.lastIndexOf('.'))
                        : filename;
                });

            } else {
                const selectedExp = experimentDefinitions.find(e => e.filename === selectedExperimentDefinitionRun);
                payload.experiment_name = selectedExp ? selectedExp.label : selectedExperimentDefinitionRun;
            }

            const response = await fetch('/api/experimenter/runExperiment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.success) {
                const expId = data.experiment_id;
                const durationSeconds = data.duration_s;

                setRunningExperiment(true);
                setCurrentExperimentId(expId);

                if (data.is_batch) {
                    setExperimentRunMessage(`Batch started: ${data.num_experiments} experiments in sequence`);
                } else {
                    setExperimentRunMessage(`Experiment ${payload.experiment_name} started successfully`);
                }

                setExperimentRunMessageType('success');

                experimentEndTimeRef.current = Date.now() + (durationSeconds * 1000);

                if (timerIntervalRef.current) {
                    clearInterval(timerIntervalRef.current);
                }

                const updateExperimentTimer = () => {
                    if (!experimentEndTimeRef.current) {
                        setExperimentTimer('--:--:--');
                        return;
                    }

                    const now = Date.now();
                    const diffMs = experimentEndTimeRef.current - now;
                    const remainingTime = Math.max(0, Math.floor(diffMs / 1000));

                    if (remainingTime <= 0) {
                        clearInterval(timerIntervalRef.current);
                        timerIntervalRef.current = null;
                        experimentEndTimeRef.current = null;
                        setExperimentTimer('--:--:--');
                        setIsCleaningUp(true);
                        setExperimentRunMessage(data.is_batch ? 'Batch completed' : `Experiment ${payload.experiment_name} completed, waiting for cleanup...`);
                        setExperimentRunMessageType('success');

                        // experiment completed, update status
                        fetch('/api/experimenter/updateExperimentStatus', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                reservation_id: reservation_id,
                                experiment_id: expId
                            })
                        }).then(() => {
                            console.log('Experiment status updated to completed');
                            if (!cleanupPollingIntervalRef.current) {
                                cleanupPollingIntervalRef.current = setInterval(() => {
                                    pollCleanupStatus(expId, data.is_batch ? 'Batch' : payload.experiment_name);
                                }, 2000);
                            }
                        }).catch(error => {
                            console.error('Error updating experiment status:', error);
                        });
                    } else {
                        setExperimentTimer(formatTime(remainingTime));
                    }
                };
                // initial update
                updateExperimentTimer();

                // start interval
                timerIntervalRef.current = setInterval(updateExperimentTimer, 1000);

            } else {
                setExperimentRunMessage(`Error: ${data.error || 'Failed to start experiment'}`);
                setExperimentRunMessageType('error');
            }

        } catch (error) {
            console.error('Error running experiment:', error);
            setExperimentRunMessage('Error: network/server error');
            setExperimentRunMessageType('error');
        } finally {
            setWaitOperation(false);
        }
    };
    // delete a running experiment
    const handleFinishExperiment = async () => {
        if (!currentExperimentId && !runningExperiment) {
            return;
        }

        const expName = currentExperimentName || 'Current experiment';
        if (timerIntervalRef.current) {
            clearInterval(timerIntervalRef.current);
            timerIntervalRef.current = null;
        }
        experimentEndTimeRef.current = null;
        setExperimentTimer('--:--:--');
        setExperimentRunMessage(`Stopping ${expName}...`);
        setExperimentRunMessageType('warning');

        setWaitOperation(true);
        setIsExperimentStopping(true);

        try {
            const response = await fetch('/api/experimenter/finishExperiment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id })
            });

            const data = await response.json();

            if (data.success) {
                if (statusPollingIntervalRef.current) {
                    clearInterval(statusPollingIntervalRef.current);
                    statusPollingIntervalRef.current = null;
                }
                if (cleanupPollingIntervalRef.current) {
                    clearInterval(cleanupPollingIntervalRef.current);
                    cleanupPollingIntervalRef.current = null;
                }

                setIsExperimentStopping(false);
                setRunningExperiment(false);
                setCurrentExperimentId(null)
                setCurrentExperimentName('');
                setExperimentRunMessage(`Experiment ${expName} finished and removed`);
                setExperimentRunMessageType('success');

                setTimeout(() => {
                    setExperimentRunMessage('');
                    setExperimentRunMessageType('');
                }, 3000);
            } else {
                setExperimentRunMessage(`Error: ${data.error || 'Failed to finish experiment'}`);
                setExperimentRunMessageType('error');
                setIsExperimentStopping(false);
            }

        } catch (error) {
            console.error('Error finishing experiment:', error);
            setExperimentRunMessage('Error: network/server error');
            setExperimentRunMessageType('error');
            setIsExperimentStopping(false);
        } finally {
            setWaitOperation(false);
        }
    };

    return (
        <div className="experiment-section experiment-controls">
            <div className="config-row config-row-space-between">
                <div className="time-left-group">
                    <label className="label-inline label-fixed-width">Experiment time left:</label>
                    <label className="label-inline time-display">{experimentTimer}</label>
                </div>
                {/* Toggle Single/Batch Mode */}
                <div className="mode-toggle-container">
                    <label className="label-inline">Execution Mode:</label>
                    <label className="toggle-switch">
                        <input
                            type="checkbox"
                            checked={batchMode}
                            onChange={(e) => setBatchMode(e.target.checked)}
                            disabled={runningExperiment || waitOperation}
                        />
                        <span className="toggle-slider"></span>
                    </label>
                    <span className="toggle-label">{batchMode ? 'Batch' : 'Single'}</span>
                </div>
            </div>

            {!batchMode && (
                <div className="config-row config-row-space-between">
                    <div className="experiment-buttons">
                        <label className={"label-inline"}>Select experiment to run:</label>
                        <select
                            className="experiment-definition-select"
                            value={selectedExperimentDefinitionRun}
                            onChange={(e) => setSelectedExperimentDefinitionRun(e.target.value)}
                            disabled={runningExperiment || experimentDefinitions.length === 0}
                        >
                            {experimentDefinitions.length === 0 ? (
                                <option value="">no experiment definitions</option>
                            ) : (
                                <>
                                    <option value="">Select</option>
                                    {experimentDefinitions.map((exp) => (
                                        <option key={exp.filename} value={exp.filename}>
                                            {exp.label}
                                        </option>
                                    ))}
                                </>
                            )}
                        </select>
                    </div>
                </div>
            )}
            {batchMode && (
                <div className="batch-section">
                    <div className="config-row">
                        <label className={"label-inline"}>Select experiments to run in sequence:</label>
                        <select
                            className="experiment-definition-select"
                            onChange={(e) => {
                                if (e.target.value && !selectedExperiments.find(exp => exp.filename === e.target.value)) {
                                    const exp = experimentDefinitions.find(d => d.filename === e.target.value);
                                    if (exp) {
                                        setSelectedExperiments([...selectedExperiments, {
                                            filename: exp.filename,
                                            label: exp.label,
                                            order: selectedExperiments.length + 1
                                        }]);
                                    }
                                }
                                e.target.value = '';
                            }}
                            disabled={runningExperiment}
                        >
                            <option value="">Add experiment...</option>
                            {experimentDefinitions.map((exp) => (
                                <option key={exp.filename} value={exp.filename}>
                                    {exp.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    {selectedExperiments.length > 0 && (
                        <div className="batch-list">
                            <h4>Batch Sequence ({selectedExperiments.length} experiments):</h4>
                            {selectedExperiments.map((exp, idx) => (
                                <div key={exp.filename} className="batch-item">
                                    <span className="batch-order">{idx + 1}.</span>
                                    <span className="batch-name">{exp.label}</span>
                                    <div className="batch-controls">
                                        <button
                                            className="btn-small btn-remove"
                                            onClick={() => {
                                                setSelectedExperiments(selectedExperiments.filter((_, i) => i !== idx));
                                            }}
                                            disabled={runningExperiment}
                                        >
                                            ✕
                                        </button>
                                    </div>
                                </div>
                            ))}
                            <div className="batch-info">
                                <strong>Total estimated
                                    duration:</strong> {Math.floor(batchTotalDuration / 60)}m {batchTotalDuration % 60}s
                                <br/>
                                <small>(includes 1 minute between experiments)</small>
                            </div>
                        </div>
                    )}
                </div>
            )}
            <div className="config-row">
                <div className="experiment-buttons">
                    <button type="button" className="start-button configuration-button"
                            onClick={handleRunExperiment}
                            disabled={runningExperiment || waitOperation || currentExperimentId !== null}>Run experiment
                    </button>
                    <button
                        type="button"
                        className="delete-button delete configuration-button"
                        onClick={handleFinishExperiment}
                        disabled={(!runningExperiment && !currentExperimentId) || waitOperation || isExperimentStopping || isCleaningUp}
                    >
                        Finish experiment
                    </button>
                </div>
            </div>

            <div className="config-row">
                <div className={`experiment-output-message ${experimentRunMessageType}`}>
                    {experimentRunMessage}
                </div>
            </div>
        </div>
    );
}