// InteractiveMode.jsx
import React, { useRef } from 'react';

export default function InteractiveMode({
    experimentName,
    setExperimentName,
    experimentDuration,
    setExperimentDuration,
    experimentMessage,
    setExperimentMessage,
    experimentMessageType,
    setExperimentMessageType,
    playbookRows,
    setPlaybookRows,
    deviceList,
    runningExperiment,
    setWaitOperation,
    reservation_id,
    refreshExperiments,
    createDownload,
    idCounter
}) {
    const playbookFileRefs = useRef({});
    // download iperf3 example playbook
    const downloadIperfExample = async () => {
        try {
            const response = await fetch('http://localhost:5004/api/experimenter/downloadIperfExample', {
                method: 'GET'
            });

            if (!response.ok) {
                console.error('Failed to download iperf example');
                return;
            }

            const blob = await response.blob();
            createDownload(blob, 'iperf_client_example.yml');
        } catch (error) {
            console.error('Error downloading iperf example:', error);
        }
    };

    const allowedPlaybookExt = ['.yml', '.yaml'];
    // handler for experiment duration
    const handleNumericChange = (setter) => (e) => {
        const value = e.target.value;
        if (value === '' || /^\d+$/.test(value)) {
            setter(value);
        }
    };
    // add a row for a new step clicking + button
    const handleAddPlaybookRow = (index) => {
        const newId = ++idCounter.current;
        setPlaybookRows(prev => {
            const copy = [...prev];
            copy.splice(index + 1, 0, {
                id: newId,
                executionTime: '',
                file: null,
                fileName: '',
                fileType: '',
                selectedDevices: []
            });
            return copy;
        });
    };
    // remove a playbook row by clicking - button
    const handleRemovePlaybookRow = (index) => {
        if (index === 0) return;
        setPlaybookRows(prev => prev.filter((_, i) => i !== index));
    };
    // handler for execution time
    const handleExecutionTimeChange = (id, value) => {
        if (value === '' || /^\d+$/.test(value)) {
            setPlaybookRows(prev =>
                prev.map(r => r.id === id ? { ...r, executionTime: value } : r)
            );
        }
    };
    // functions for playbooks loading
    const choosePlaybookFile = (id) => {
        playbookFileRefs.current[id]?.click();
    };

    const onPlaybookFileChange = (e, id) => {
        const f = e.target.files[0] || null;
        const nameLower = f ? f.name.toLowerCase() : '';
        const isValid = f
            ? allowedPlaybookExt.some(ext => nameLower.endsWith(ext))
            : false;

        setPlaybookRows(prev =>
            prev.map(r =>
                r.id === id
                    ? {
                        ...r,
                        file: f,
                        fileName: f ? f.name : '',
                        fileType: f ? (isValid ? 'valid' : 'invalid') : ''
                      }
                : r
            )
        );
        e.target.value = null;
    };
    // handler for device selection on each row
    const handleDeviceToggle = (rowId, device) => {
        setPlaybookRows(prev =>
            prev.map(r => {
                if (r.id === rowId) {
                    const isSelected = r.selectedDevices.includes(device);
                    return {
                        ...r,
                        selectedDevices: isSelected
                            ? r.selectedDevices.filter(d => d !== device)
                            : [...r.selectedDevices, device]
                    };
                }
                return r;
            })
        );
    };
    // handler to create the definition file
    const handleCreateExperiment = async () => {
        const allRowsFilled = playbookRows.every(row => row.executionTime && row.file);

        if (!experimentName || !experimentName.trim()) {
            setExperimentMessage('Experiment name is required');
            setExperimentMessageType('error');
            return;
        }

        if (!experimentDuration || experimentDuration === '0') {
            setExperimentMessage('Experiment duration is required');
            setExperimentMessageType('error');
            return;
        }

        if (!allRowsFilled) {
            setExperimentMessage('Following rows must have each field selected');
            setExperimentMessageType('error');
            return;
        }

        const hasInvalidFiles = playbookRows.some(row => row.fileType === 'invalid');

        if (hasInvalidFiles) {
            setExperimentMessage('Invalid playbook files detected');
            setExperimentMessageType('error');
            return;
        }

        const hasRowsWithoutDevices = playbookRows.some(row => row.selectedDevices.length === 0);

        if (hasRowsWithoutDevices) {
            setExperimentMessage('Each playbook must have at least one device selected');
            setExperimentMessageType('error');
            return;
        }

        const formData = new FormData();
        formData.append('experiment_name', experimentName.trim());
        formData.append('duration', experimentDuration);
        formData.append('reservation_id', reservation_id);

        const playbooksData = playbookRows.map(row => ({
            execution_time: row.executionTime,
            devices: row.selectedDevices,
            filename: row.fileName
        }));

        formData.append('playbooks_data', JSON.stringify(playbooksData));

        playbookRows.forEach((row, index) => {
            if (row.file) {
                formData.append(`playbook_${index}`, row.file);
            }
        });

        setWaitOperation(true);
        try {
            const response = await fetch('http://localhost:5004/api/experimenter/createExperiment', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                console.error('Failed to create experiment');
                return;
            }

            const blob = await response.blob();
            const contentDisposition = response.headers.get('Content-Disposition');
            let filename = `res_${reservation_id}_exp_description.yml`;

            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (filenameMatch && filenameMatch[1]) {
                    filename = filenameMatch[1].replace(/['"]/g, '');
                }
            }

            createDownload(blob, filename);

            setExperimentMessage(filename);
            setExperimentMessageType('success');
            await refreshExperiments();
        } catch (error) {
            console.error('Error creating experiment:', error);
            setExperimentMessage('Error creating experiment');
            setExperimentMessageType('error');
        } finally {
            setWaitOperation(false);
        }
    };

    return (
        <div className="experiment-section mode-content">
            <div className="section-content">
                <div className="config-row">
                    <label className="label-inline label-fixed-width label-output">Insert experiment name:</label>
                    <input
                        type="text"
                        className="duration-field"
                        value={experimentName}
                        onChange={(e) => setExperimentName(e.target.value)}
                        readOnly={runningExperiment}
                        placeholder="e.g., My Experiment"
                    />
                    <label className="label-inline label-fixed-width label-output">Download client iperf example:</label>
                    <button
                        type="button"
                        className="template-button configuration-button"
                        onClick={downloadIperfExample}
                        disabled={runningExperiment}
                        style={{marginLeft: '10px'}}
                        title="Download iperf3 example playbook"
                    >
                        Download
                    </button>
                </div>
                <div className="config-row">
                    <label className="label-inline label-fixed-width label-output">Insert experiment
                        duration
                        (seconds):</label>
                    <input
                        type={"text"}
                        className={`duration-field`}
                        value={experimentDuration}
                        onChange={handleNumericChange(setExperimentDuration)}
                        readOnly={runningExperiment}
                    />
                    <button type="button" className="send-button experiment-button additional-margin"
                            onClick={handleCreateExperiment}
                            disabled={runningExperiment}>Create experiment
                    </button>
                    <div
                        className={`experiment-created-message ${experimentMessageType}`}>{experimentMessage}</div>
                </div>
                {playbookRows.map((row, idx) => (
                    <div key={row.id} className="config-row config-row-nowrap  playbook-row-container">
                        <label className="label-inline label-time">Time of execution(seconds):</label>
                        <input
                            type={"text"}
                            className="time-field-short"
                            value={row.executionTime}
                            onChange={(e) => handleExecutionTimeChange(row.id, e.target.value)}
                            readOnly={runningExperiment}
                        />
                        <label className="label-inline label-playbook">Load playbook:</label>
                        <button
                            type="button"
                            className="playbook-button configuration-button"
                            onClick={() => choosePlaybookFile(row.id)}
                            disabled={runningExperiment}
                        >
                            Choose file
                        </button>
                        <div
                            className={`selected-file-name-compact file-status-${row.fileType}`}>{row.fileName}</div>
                        <input
                            type="file"
                            ref={(el) => (playbookFileRefs.current[row.id] = el)}
                            style={{display: 'none'}}
                            onChange={(e) => onPlaybookFileChange(e, row.id)}
                            disabled={runningExperiment}
                        />
                        <label className="label-inline label-devices">Devices:</label>
                        <div className="device-checkboxes">
                            {[...deviceList].sort((a, b) => a.name.localeCompare(b.name)).map(device => (
                                <label key={device.name} className="device-checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={row.selectedDevices.includes(device.name)}
                                        onChange={() => handleDeviceToggle(row.id, device.name)}
                                        disabled={runningExperiment}
                                    />
                                    <span>{device.name}</span>
                                </label>
                            ))}
                        </div>
                        <label
                            className="label-inline add-remove-label"
                            onClick={() => handleAddPlaybookRow(idx)}
                            style={{ pointerEvents: runningExperiment ? 'none' : 'auto' }}
                        >+</label>
                        <label
                            className="label-inline add-remove-label"
                            onClick={() => handleRemovePlaybookRow(idx)}
                            style={{
                                opacity: idx === 0 ? 0.3 : 1,
                                pointerEvents: (idx === 0 || runningExperiment) ? 'none' : 'auto'
                            }}
                        >-</label>
                    </div>
                ))}
            </div>
        </div>
    );
}