// TelemetrySection.jsx
import React, {useRef} from 'react';
import jsyaml from 'js-yaml';

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
    metricIdCounter,
    metricConfigurations,
    setMetricConfigurations,
    yamlUploadMessageTelemetry,
    yamlUploadMessageTypeTelemetry,
    setYamlUploadMessageTelemetry,
    setYamlUploadMessageTypeTelemetry
}) {
    const yamlUploadRef = useRef(null);

    const handleYamlUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
            const yamlContent = event.target.result;
            const parsed = jsyaml.load(yamlContent);

            // validate required fields
            if (!parsed.metric || !Array.isArray(parsed.metric)) {
              setYamlUploadMessageTelemetry('Invalid YAML format: metric field must be an array');
              setYamlUploadMessageTypeTelemetry('error');
              return;
            }

            // validate numeric fields
            for (const metricDef of parsed.metric) {
                if ((metricDef.sampling_period && isNaN(metricDef.sampling_period)) || metricDef.sampling_period <= 0) {
                    setYamlUploadMessageTelemetry('Invalid YAML format: sampling_period must be a number > 0');
                    setYamlUploadMessageTypeTelemetry('error');
                    return;
                }
            }
            // set sampling mode to per-metric
            setSamplingMode('per-metric');

            // create a set of valid device names for quick lookup (only non-host devices)
            const validDeviceNames = new Set(nonHostDevices.map(d => d.name));
            const newSelectedMetrics = [];
            const metricsToAdd = [];
            const allInvalidDevices = new Set();
            const metricConfigArray = [];
            let configId = 1;


            parsed.metric.forEach((metricDef) => {
                const metricPath = metricDef.name;
                const samplingPeriod = metricDef.sampling_period || 5;
                const targets = metricDef.targets || [];

                // filter targets to only include devices that exist in nonHostDevices
                const validTargets = targets.filter(target => {
                    const isValid = validDeviceNames.has(target);
                    if (!isValid) {
                        allInvalidDevices.add(target);
                    }
                    return isValid;
                });
                // check if metric exists in predefined or custom metrics
                const isPredefined = predefinedMetrics.some(m => m.path === metricPath);
                const isCustom = customMetrics.some(m => m.path === metricPath);

                if (isPredefined || isCustom) {
                    // select existing metric avoiding duplicates
                    if (!newSelectedMetrics.includes(metricPath)) {
                        newSelectedMetrics.push(metricPath);
                    }
                } else {
                    // add to "add metrics" section for user to validate avoiding duplicates
                    if (!metricsToAdd.includes(metricPath)) {
                        metricsToAdd.push(metricPath);
                    }
                }

                 metricConfigArray.push({
                     id: configId++,
                     path: metricPath,
                     interval: samplingPeriod,
                     devices: validTargets
                 });
            });

            // update selected metrics
            setSelectedMetrics(newSelectedMetrics);

            setMetricConfigurations(metricConfigArray);


            // add unknown metrics to metric rows for validation
            if (metricsToAdd.length > 0) {
                setMetricRows(prev => {
                    const newRows = [];
                    // create rows for new metrics, reusing existing IDs where possible
                    for (let i = 0; i < metricsToAdd.length; i++) {
                        const rowId = i < prev.length ? prev[i].id : ++metricIdCounter.current;
                        newRows.push({id: rowId, path: metricsToAdd[i], status: '', message: ''});
                   }

                  // keep remaining existing rows unchanged
                  if (prev.length > metricsToAdd.length) {
                    newRows.push(...prev.slice(metricsToAdd.length));
                  }

                  return newRows;
                });

                setYamlUploadMessageTelemetry(`YAML loaded - ${metricConfigArray.length} metrics selected - ` +
                `${metricsToAdd.length} new metrics added to "Add Metrics" section - please validate them`);

            } else {
              setYamlUploadMessageTelemetry(`YAML loaded successfully. ${metricConfigArray.length} metrics selected`);
            }
            setYamlUploadMessageTypeTelemetry('success');

            } catch (error) {
                console.error('Error parsing YAML:', error);
                setYamlUploadMessageTelemetry(`Invalid YAML format: ${error.message}`);
                setYamlUploadMessageTypeTelemetry('error');
            }
        };

        reader.readAsText(file);
        e.target.value = null; // reset input
    };

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

                const successfulMetrics = data.results.filter(r => r.status === 'success').map((r, idx) => metricsToSendWithIndex[idx].row.path.trim());

                if (successfulMetrics.length > 0) {
                    setMetricConfigurations(prev => {
                        const maxId = prev.length > 0 ? Math.max(...prev.map(c => c.id)) : 0;
                        let newId = maxId + 1;
                        const newConfigs = successfulMetrics
                            .filter(path => selectedMetrics.includes(path))
                            .filter(path => !prev.some(c => c.path === path))
                            .map(path => ({
                                id: newId++,
                                path: path,
                                interval: 5,
                                devices: []
                            }));
                        return [...prev, ...newConfigs];
                    });
                }

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
            for (const config of metricConfigurations) {

                if (!config.interval || !String(config.interval).trim()) {
                    setTelemetryCreateMessage(`Error: interval is required for ${config.path}`);
                    setTelemetryCreateMessageType('error');
                    return;
                }
                if (!config.devices || config.devices.length === 0) {
                    setTelemetryCreateMessage(`Error: select at least one device for ${config.path}`);
                    setTelemetryCreateMessageType('error');
                    return;
                }
            }
        } else {
            setTelemetryCreateMessage('Error: sampling mode is required');
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

        const filename = `${telemetryBaseName}.yml`;
        try {
            const checkResponse = await fetch('http://localhost:5004/api/experimenter/checkFileExists', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    reservation_id: reservation_id,
                    filename: filename,
                    file_type: 'telemetry'
                })
            });

            const checkData = await checkResponse.json();

            if (checkData.success && checkData.exists) {
                const overwrite = window.confirm(
                    `A telemetry file named "${filename}" already exists. Do you want to overwrite it?`
                );
                if (!overwrite) {
                    return; // user chose not to overwrite
                }
            }
        } catch (error) {
            console.error('Error checking file existence:', error);
        }

        const metricsPayload = samplingMode === 'global'
            ? selectedMetrics.filter(metricPath =>
                predefinedMetrics.some(m => m.path === metricPath) ||
                customMetrics.some(m => m.path === metricPath)

            ).map((metricPath) => ({
                    name: metricPath,
                    sampling_period: parseInt(globalInterval, 10),
                    targets: globalDevices
            }))
            : metricConfigurations.filter(config =>
                predefinedMetrics.some(m => m.path === config.path) ||
                customMetrics.some(m => m.path === config.path)

            ).map((config) => ({
                name: config.path,
                sampling_period: parseInt(config.interval, 10),
                targets: config.devices || []
            }));

        setWaitOperation(true);
        try {
            const res = await fetch('http://localhost:5004/api/experimenter/createTelemetryFile', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    reservation_id,
                    telemetry_filename_base: telemetryBaseName,
                    experiment_name: expName,
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
                    <label className="label-inline label-fixed-width label-output">Load metrics from YAML template:</label>
                    <input
                        type="file"
                        ref={yamlUploadRef}
                        accept=".yml,.yaml"
                        onChange={handleYamlUpload}
                        style={{display: 'none'}}
                    />
                    <button
                        type="button"
                        className="compile-form-button configuration-button"
                        onClick={() => yamlUploadRef.current?.click()}
                        disabled={runningExperiment}
                        title="Upload telemetry configuration YAML file"
                    >
                        Upload template
                    </button>
                    {yamlUploadMessageTelemetry && (
                        <span className={`message-inline ${yamlUploadMessageTypeTelemetry === 'error' ? 'error-validation' : 'success-validation'}`}>
                            {yamlUploadMessageTelemetry}
                        </span>
                    )}
                </div>
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
                                                setMetricConfigurations(prev => prev.filter(c => c.path !== metric.path));
                                            } else {
                                                setSelectedMetrics([...selectedMetrics, metric.path]);
                                                setMetricConfigurations(prev => {
                                                    const maxId = prev.length > 0 ? Math.max(...prev.map(c => c.id)) : 0;
                                                    return [...prev, {
                                                        id: maxId + 1,
                                                        path: metric.path,
                                                        interval: 5,
                                                        devices: []
                                                    }];
                                                });
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
                                                setMetricConfigurations(prev => prev.filter(c => c.path !== metric.path));
                                            } else {
                                                setSelectedMetrics([...selectedMetrics, metric.path]);
                                                setMetricConfigurations(prev => {
                                                    const maxId = prev.length > 0 ? Math.max(...prev.map(c => c.id)) : 0
                                                    return [...prev, {
                                                        id: maxId + 1,
                                                        path: metric.path,
                                                        interval: 5,
                                                        devices: []
                                                    }];
                                                });
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

                {samplingMode === 'per-metric' && metricConfigurations.length > 0 && (
                    <div className="per-metric-intervals">
                        <h4>Interval and devices for each metric:</h4>
                        {metricConfigurations.filter(config =>
                            predefinedMetrics.some(m => m.path === config.path) ||
                            customMetrics.some(m => m.path === config.path)
                        ).map((config) => (
                            <div key={config.id} className="metric-interval-row">
                                <span className="metric-path-small">{config.path}</span>
                                <input
                                    type="text"
                                    className="interval-field-small"
                                    value={config.interval || ''}
                                    placeholder={5}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        if (value === '' || /^\d+$/.test(value)) {
                                            setMetricConfigurations(prev =>
                                                prev.map(c => c.id === config.id
                                                    ? {...c, interval: value} : c)
                                            );
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
                                                checked={config.devices.includes(device.name)}
                                                onChange={() => setMetricConfigurations(prev =>
                                                    prev.map(c => {
                                                        if (c.id === config.id) {
                                                            const isSelected = c.devices.includes(device.name);
                                                            return {...c,
                                                                devices: isSelected ? c.devices.filter(d => d !== device.name) : [...c.devices, device.name]
                                                            };
                                                        }
                                                        return c;
                                                    })
                                                )}
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