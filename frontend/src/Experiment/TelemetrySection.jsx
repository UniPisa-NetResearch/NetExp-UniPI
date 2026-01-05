// TelemetrySection.jsx
import React from 'react';

export default function TelemetrySection({
    predefinedMetrics,
    customMetrics,
    setCustomMetrics,
    selectedMetrics,
    setSelectedMetrics,
    metricRows,
    setMetricRows,
    samplingMode,
    setSamplingMode,
    globalInterval,
    setGlobalInterval,
    globalDevices,
    setGlobalDevices,
    nonHostDevices,
    metricIntervals,
    setMetricIntervals,
    metricDevices,
    setMetricDevices,
    telemetryType,
    setTelemetryType,
    experimentDefinitions,
    selectedExperimentDefinitionTelemetry,
    setSelectedExperimentDefinitionTelemetry,
    telemetryCreateMessage,
    setTelemetryCreateMessage,
    telemetryCreateMessageType,
    setTelemetryCreateMessageType,
    runningExperiment,
    validatingMetrics,
    setValidatingMetrics,
    waitOperation,
    setWaitOperation,
    username,
    reservation_id,
    deviceList,
    createDownload,
    metricIdCounter
}) {
    // handler for experiment duration
    const handleNumericChange = (setter) => (e) => {
        const value = e.target.value;
        if (value === '' || /^\d+$/.test(value)) {
            setter(value);
        }
    };
    // handler for adding a metric with + button
    const handleAddMetricRow = (index) => {
        const newId = ++metricIdCounter.current;
        setMetricRows(prev => {
            const copy = [...prev];
            copy.splice(index + 1, 0, { id: newId,  path: '', status: '', message: '' });
            return copy;
        });
    };
    // remove a metric with - button
    const handleRemoveMetricRow = (index) => {
        if (index === 0) return;
        setMetricRows(prev => prev.filter((_, i) => i !== index));
    };
    // check if a new added metric is predefined
    const handleMetricPathChange = (id, value) => {
        const isPredefined = predefinedMetrics.some(metric => metric.path === value.trim());
        setMetricRows(prev =>
            prev.map(r => r.id === id ? { ...r, path: value, status: isPredefined ? 'predefined' : '',  message: isPredefined ? 'predefined' : '' } : r)
        );
    };
    // add all inserted metrics
    const handleAddMetrics = async () => {
        const hasEmpty = metricRows.some(row => !row.path.trim());

        if (hasEmpty) {
            setMetricRows(prev =>
                prev.map(r => ({
                    ...r,
                    status: !r.path.trim() ? 'empty' : r.status,
                    message: !r.path.trim() ? 'empty' : r.message
                }))
            );
            return;
        }

        const switchDevice = deviceList.find(device =>
            device.role && device.role.toLowerCase() !== 'host'
        );

        if (!switchDevice) {
            alert('Error: No switch device (leaf/spine) found. At least one non-host device is required to validate metrics.');
            return;
        }

        const metricsToSendWithIndex = [];
        const predefinedIndices = [];
        metricRows.forEach((row, idx) => {
            const isPredefined = predefinedMetrics.some(metric => metric.path === row.path.trim());
            if (isPredefined) {
                predefinedIndices.push(idx);
            } else {
                metricsToSendWithIndex.push({ row, originalIndex: idx });
            }
        });

        if (metricsToSendWithIndex.length === 0) {
            alert('All metrics are predefined. No custom metrics to add.');
            return;
        }

        setValidatingMetrics(true);

        console.log("Check metrics on switch: ", switchDevice.ip);

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/addMetrics', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    username,
                    switch_ip: switchDevice.ip,
                    metrics: metricsToSendWithIndex.map(item=> ({path: item.row.path.trim()}))
                })
            });

            const data = await response.json();

            if (data.success) {
                setMetricRows(prev => {
                    const newRows = [...prev];
                    metricsToSendWithIndex.forEach((item, resultIdx) => {
                        newRows[item.originalIndex] = {
                            ...newRows[item.originalIndex],
                            status: data.results[resultIdx].status,
                            message: data.results[resultIdx].message
                        };
                    });

                    predefinedIndices.forEach(idx => {
                        newRows[idx] = {
                            ...newRows[idx],
                            status: 'predefined',
                            message: 'predefined'
                        };
                    });

                    return newRows;
                });
                // update user metrics list
                const metricsResponse = await fetch('http://localhost:5004/api/experimenter/getUserMetrics', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({username})
                });

                const metricsData = await metricsResponse.json();
                setCustomMetrics(metricsData.custom || []);

            } else {
                alert(`Error: ${data.error}`);
            }

        } catch (error) {
            console.error('Error adding metrics:', error);
            alert('Error validating metrics');
        } finally {
            setValidatingMetrics(false);
        }
    };
    // select devices on global mode
    const handleGlobalDeviceToggle = (deviceName) => {
        setGlobalDevices(prev =>
            prev.includes(deviceName)
                ? prev.filter(d => d !== deviceName)
                : [...prev, deviceName]
        );
    };
    // select metrics
    const handleMetricDeviceToggle = (metricPath, deviceName) => {
        setMetricDevices(prev => {
            const currentDevices = prev[metricPath] || [];
            const isSelected = currentDevices.includes(deviceName);

            return {
                ...prev,
                [metricPath]: isSelected
                    ? currentDevices.filter(d => d !== deviceName)
                    : [...currentDevices, deviceName]
            };
        });
    };
    // create telemetry file
    const handleCreateTelemetryFile = async () => {
        setTelemetryCreateMessage('');
        setTelemetryCreateMessageType('');

        if (!selectedMetrics || selectedMetrics.length === 0) {
            setTelemetryCreateMessage('Error: select at least one metric');
            setTelemetryCreateMessageType('error');
            return;
        }

        if (samplingMode === 'global') {
            if (!globalInterval || !globalInterval.trim()) {
                setTelemetryCreateMessage('Error: global interval is required');
                setTelemetryCreateMessageType('error');
                return;
            }
            if (!globalDevices || globalDevices.length === 0) {
                setTelemetryCreateMessage('Error: select at least one device (global mode)');
                setTelemetryCreateMessageType('error');
                return;
            }
        } else if (samplingMode === 'per-metric') {
            for (const metricPath of selectedMetrics) {
                const interval = metricIntervals?.[metricPath];
                const devices = metricDevices?.[metricPath] || [];

                if (!interval || !String(interval).trim()) {
                    setTelemetryCreateMessage(`Error: interval is required for ${metricPath}`);
                    setTelemetryCreateMessageType('error');
                    return;
                }
                if (!devices || devices.length === 0) {
                    setTelemetryCreateMessage(`Error: select at least one device for ${metricPath}`);
                    setTelemetryCreateMessageType('error');
                    return;
                }
            }
        } else {
            setTelemetryCreateMessage('Error: sampling mode is required');
            setTelemetryCreateMessageType('error');
            return;
        }

        if (!telemetryType || !telemetryType.trim()) {
            setTelemetryCreateMessage('Error: telemetry type is required');
            setTelemetryCreateMessageType('error');
            return;
        }

        if (!experimentDefinitions || experimentDefinitions.length === 0) {
            setTelemetryCreateMessage('Error: no experiment definitions');
            setTelemetryCreateMessageType('error');
            return;
        }

        if (!selectedExperimentDefinitionTelemetry) {
            setTelemetryCreateMessage('Error: select an experiment definition');
            setTelemetryCreateMessageType('error');
            return;
        }

        const expName = experimentDefinitions.find(e => e.filename === selectedExperimentDefinitionTelemetry)?.label || selectedExperimentDefinitionTelemetry;
        const telemetryBaseName = `${expName}_telemetry`;

        const telemetryTypeNum = telemetryType === 'Real time mode' ? 0 : 1;

        const metricsPayload = selectedMetrics.map((metricPath) => {
            if (samplingMode === 'global') {
                return {
                    name: metricPath,
                    sampling_period: parseInt(globalInterval, 10),
                    targets: globalDevices
                };
            }
            return {
                name: metricPath,
                sampling_period: parseInt(metricIntervals[metricPath], 10),
                targets: metricDevices[metricPath] || []
            };
        });

        setWaitOperation(true);
        try {
            const res = await fetch('http://localhost:5004/api/experimenter/createTelemetryFile', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    reservation_id,
                    telemetry_filename_base: telemetryBaseName,
                    experiment_name: expName,
                    telemetry_type: telemetryTypeNum,
                    metrics: metricsPayload
                })
            });

            const contentType = res.headers.get('Content-Type') || '';
            if (!res.ok) {
                if (contentType.includes('application/json')) {
                    const errData = await res.json();
                    setTelemetryCreateMessage(`Error: ${errData.error || 'server error'}`);
                } else {
                    setTelemetryCreateMessage('Error: failed to create telemetry file');
                }
                setTelemetryCreateMessageType('error');
                return;
            }

            const blob = await res.blob();

            const contentDisposition = res.headers.get('Content-Disposition');
            let filename = `${telemetryBaseName}.yaml`;
            if (contentDisposition) {
                const m = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (m && m[1]) filename = m[1].replace(/['"]/g, '');
            }

            createDownload(blob, filename);
            setTelemetryCreateMessage(`${telemetryBaseName} created`);
            setTelemetryCreateMessageType('success');

        } catch (e) {
            console.error('Error creating telemetry file:', e);
            setTelemetryCreateMessage('Error: network/server error');
            setTelemetryCreateMessageType('error');
        } finally {
            setWaitOperation(false);
        }
    };

    return (
        <div className="experiment-section">
            <h3 className="section-title">Telemetry</h3>
            <div className="section-content">
                <div className="config-row">
                    <label className="label-inline label-fixed-width label-output">Choose metrics:</label>
                </div>

                <div className="metrics-selection-container">
                    {predefinedMetrics.length > 0 && (
                        <div className="metric-category">
                            <h4 className="category-title">Predefined Metrics</h4>
                            {predefinedMetrics.map((metric) => (
                                <label key={metric.id} className="metric-checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={selectedMetrics.includes(metric.path)}
                                        onChange={() => {
                                            if (selectedMetrics.includes(metric.path)) {
                                                setSelectedMetrics(selectedMetrics.filter(m => m !== metric.path));
                                            } else {
                                                setSelectedMetrics([...selectedMetrics, metric.path]);
                                            }
                                        }}
                                        disabled={runningExperiment}
                                    />
                                    <span className="metric-path">{metric.path}</span>
                                </label>
                            ))}
                        </div>
                    )}

                    {customMetrics.length > 0 && (
                        <div className="metric-category">
                            <h4 className="category-title">Your Custom Metrics</h4>
                            {customMetrics.map((metric) => (
                                <label key={metric.id} className="metric-checkbox-label">
                                    <input
                                        type="checkbox"
                                        checked={selectedMetrics.includes(metric.path)}
                                        onChange={() => {
                                            if (selectedMetrics.includes(metric.path)) {
                                                setSelectedMetrics(selectedMetrics.filter(m => m !== metric.path));
                                            } else {
                                                setSelectedMetrics([...selectedMetrics, metric.path]);
                                            }
                                        }}
                                        disabled={runningExperiment}
                                    />
                                    <span className="metric-path">{metric.path}</span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>

                <div className="config-row">
                    <label className="label-inline label-fixed-width">Add custom metrics:</label>
                </div>

                {metricRows.map((row, idx) => (
                    <div key={row.id} className="config-row metric-add-row">
                        <input
                            type="text"
                            className={`metric-path-input ${row.status === 'empty' || row.status === 'error' || row.status === 'predefined' ? 'input-error' : row.status === 'success' ? 'input-success' : row.status === 'warning' ? 'input-warning' : ''}`}
                            placeholder="e.g., COUNTERS_DB:COUNTERS/Ethernet8 or /openconfig-..."
                            value={row.path}
                            onChange={(e) => handleMetricPathChange(row.id, e.target.value)}
                            disabled={runningExperiment || validatingMetrics}
                        />

                        <label
                            className="label-inline add-remove-label"
                            onClick={() => !runningExperiment && !validatingMetrics && handleAddMetricRow(idx)}
                            style={{pointerEvents: runningExperiment || validatingMetrics ? 'none' : 'auto'}}
                        >+</label>

                        <label
                            className="label-inline add-remove-label"
                            onClick={() => !runningExperiment && !validatingMetrics && handleRemoveMetricRow(idx)}
                            style={{
                                opacity: idx === 0 ? 0.3 : 1,
                                pointerEvents: idx === 0 || runningExperiment || validatingMetrics ? 'none' : 'auto'
                            }}
                        >-</label>

                        {row.message && (
                            <span className={`metric-validation-message ${row.status}`}>
                                {row.status === 'success' && '✓ New metric added in the collection'}
                                {row.status === 'warning' && '⚠ Metric already inside the collection'}
                                {row.status === 'error' && '✗ Not available on devices'}
                                {row.status === 'predefined' && '⊘ This is a predefined metric'}
                                {row.status === 'empty' && '✗ Path is required'}
                            </span>
                        )}
                    </div>
                ))}

                <div className="config-row">
                    <button type="button" className="send-button configuration-button"
                            onClick={handleAddMetrics} disabled={runningExperiment || validatingMetrics}> Add
                        Metrics
                    </button>
                </div>

                <div className="config-row">
                    <label className="label-inline label-fixed-width">Sampling interval:</label>
                    <div className="radio-group">
                        <input
                            type="radio"
                            id="globalSampling"
                            value="global"
                            checked={samplingMode === 'global'}
                            onChange={(e) => setSamplingMode(e.target.value)}
                            disabled={runningExperiment}
                        />
                        <label className="label-inline label-radio" htmlFor="globalSampling">Global</label>
                        <input
                            type="radio"
                            id="perMetricSampling"
                            value="per-metric"
                            checked={samplingMode === 'per-metric'}
                            onChange={(e) => setSamplingMode(e.target.value)}
                            disabled={runningExperiment}
                        />
                        <label className="label-inline label-radio"
                               htmlFor="perMetricSampling">Per-metric</label>
                    </div>
                </div>

                {samplingMode === 'global' && (
                    <>
                        <div className="config-row">
                            <label className="label-inline label-fixed-width">Interval (seconds):</label>
                            <input
                                type="text"
                                className="duration-field"
                                value={globalInterval}
                                onChange={handleNumericChange(setGlobalInterval)}
                                disabled={runningExperiment}
                            />
                        </div>
                        <div className="config-row">
                            <label className="label-inline label-fixed-width">Select devices:</label>
                            <div className="device-checkboxes">
                                {nonHostDevices.map(device => (
                                    <label key={device.name} className="device-checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={globalDevices.includes(device.name)}
                                            onChange={() => handleGlobalDeviceToggle(device.name)}
                                            disabled={runningExperiment}
                                        />
                                        <span>{device.name}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                    </>
                )}

                {samplingMode === 'per-metric' && selectedMetrics.length > 0 && (
                    <div className="per-metric-intervals">
                        <h4>Interval and devices for each metric:</h4>
                        {selectedMetrics.map((metricPath) => (
                            <div key={metricPath} className="metric-interval-row">
                                <span className="metric-path-small">{metricPath}</span>
                                <input
                                    type="text"
                                    className="interval-field-small"
                                    value={metricIntervals[metricPath] || ''}
                                    placeholder={5}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        if (value === '' || /^\d+$/.test(value)) {
                                            setMetricIntervals({
                                                ...metricIntervals,
                                                [metricPath]: value
                                            });
                                        }
                                    }}
                                    disabled={runningExperiment}
                                />
                                <span>s</span>
                                <div className="device-checkboxes">
                                    {nonHostDevices.map(device => (
                                        <label key={device.name} className="device-checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={(metricDevices[metricPath] || []).includes(device.name)}
                                                onChange={() => handleMetricDeviceToggle(metricPath, device.name)}
                                                disabled={runningExperiment}
                                            />
                                            <span>{device.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div className="config-row">
                    <label className="label-inline label-fixed-width">Telemetry type:</label>
                    <div className="radio-group">
                        <input
                            type="radio"
                            id="realTime"
                            name="telemetry_type"
                            value="Real time mode"
                            checked={telemetryType === 'Real time mode'}
                            onChange={(e) => setTelemetryType(e.target.value)}
                            disabled={runningExperiment}
                        />
                        <label className="label-inline label-radio" htmlFor="realTime">Real time mode</label>
                        <input
                            type="radio"
                            id="afterExperiment"
                            name="telemetry_type"
                            value="After experiment mode"
                            checked={telemetryType === 'After experiment mode'}
                            onChange={(e) => setTelemetryType(e.target.value)}
                            disabled={runningExperiment}
                        />
                        <label className="label-inline label-radio" htmlFor="afterExperiment">After experiment
                            mode</label>
                    </div>
                </div>
                <div className="config-row">
                    <label className="label-inline label-fixed-width">Experiment definition:</label>
                    <select
                        className="duration-field"
                        value={selectedExperimentDefinitionTelemetry}
                        onChange={(e) => setSelectedExperimentDefinitionTelemetry(e.target.value)}
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
                    <button
                        type="button"
                        className="send-button configuration-button additional-margin"
                        onClick={handleCreateTelemetryFile}
                        disabled={runningExperiment || waitOperation}
                    >
                        Create telemetry file
                    </button>

                    <div className={`experiment-created-message ${telemetryCreateMessageType}`}>
                        {telemetryCreateMessage}
                    </div>
                </div>
            </div>
        </div>
    );
}