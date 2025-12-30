// Configuration.jsx
import React, {useState, useRef, useEffect} from 'react';
import './style/style.css';
import './style/experiment.css';

export default function Experiment({username, reservation_id}) {
    // files: experiment_description and configuration files
    const experimentDescription = useFileInput(['.yml', '.yaml']);
    const experimentStep = useFileInput(['.yml', '.yaml', 'sh', 'bash']);
    const experimentDescriptionThird = useFileInput(['.yml', '.yaml']);
    const [experimentDuration, setExperimentDuration] = useState('');   // experiment duration
    const [executionTime, setExecutionTime] = useState('');             // time to execute

    // free mode states
    const [freePlaybookFiles, setFreePlaybookFiles] = useState([]);
    const freeModeFileRef = useRef(null);
    const [experimentMessage, setExperimentMessage] = useState('');
    const [experimentMessageType, setExperimentMessageType] = useState(''); // 'success' | 'error'
    // guided mode states
    const [guidedDuration, setGuidedDuration] = useState('');
    const [deviceList, setDeviceList] = useState([]);
    const [iperfClients, setIperfClients] = useState([]);
    const [iperfServers, setIperfServers] = useState([]);
    // metrics states
    const [predefinedMetrics, setPredefinedMetrics] = useState([]);  // common metrics
    const [customMetrics, setCustomMetrics] = useState([]);          //manual add of metric
    const [selectedMetrics, setSelectedMetrics] = useState([]);
    const [telemetryType, setTelemetryType] = useState('');         // radio button status
    // Sampling
    const [samplingMode, setSamplingMode] = useState('global');
    const [globalInterval, setGlobalInterval] = useState('5');
    const [metricIntervals, setMetricIntervals] = useState({});

    const [globalDevices, setGlobalDevices] = useState([]);  // device for global mode
    const [metricDevices, setMetricDevices] = useState({});    // device for per-metric mode {metricPath: [device1, device2, ...]}

    // Validation in progress
    const [validatingMetrics, setValidatingMetrics] = useState(false);

    // disable functionalities while experiment is running
    const [runningExperiment, setRunningExperiment] = useState(false);

    // when true all buttons are disabled until operation completes
    const [waitOperation, setWaitOperation] = useState(false);
    // -----------------------------------
    // dynamic experiment definition
    const idCounter = useRef(1);

    const [playbookRows, setPlaybookRows] = useState([
      { id: 1, executionTime: '', file: null, fileName: '', fileType: '', selectedDevices: [] }
    ]);

    const playbookFileRefs = useRef({});

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

    // metrics section --------------------------------------------------------------------------
    const metricIdCounter = useRef(1);

    const [metricRows, setMetricRows] = useState([
      { id: 1, path: '', status: '', message: '' }
    ]);

    // useEffect to load devices at the component start
    useEffect(() => {
        const fetchDevices = async () => {
            try {
                const response = await fetch('http://localhost:5004/api/experimenter/getDevices', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ reservation_id })
                });

                if (!response.ok) {
                    console.error('Failed to fetch devices');
                    return;
                }

                const data = await response.json();
                setDeviceList(data.devices || []);
            } catch (error) {
                console.error('Error fetching devices:', error);
            }
        };

        // load devices
        fetchDevices();

    }, [reservation_id]); //reload if reservation_id change

    // useEffect to load predefined + custom metrics at component start
    useEffect(() => {
        const fetchMetrics = async () => {
            try {
                // Load predefined metrics from JSON file
                const predefinedResponse = await fetch('/assets/metrics.json');
                if (predefinedResponse.ok) {
                    const predefinedData = await predefinedResponse.json();
                    setPredefinedMetrics(predefinedData.predefined_metrics || []);
                } else {
                    console.error('Failed to load predefined metrics');
                }

                // Load user custom metrics from database
                const customResponse = await fetch('http://localhost:5004/api/experimenter/getUserMetrics', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ username })
                });

                if (customResponse.ok) {
                    const customData = await customResponse.json();
                    setCustomMetrics(customData.custom || []);
                } else {
                    console.error('Failed to fetch custom metrics');
                }

            } catch (error) {
                console.error('Error loading metrics:', error);
            }
        };

        fetchMetrics();
    }, [username]); // Reload if username changes


    // --------------------------------------
    function useFileInput(allowedExt = []) {
        // function called when the user loads a file
        const ref = useRef(null);
        const [file, setFile] = useState(null);
        const [fileType, setFileType] = useState(''); // '' | 'valid' | 'invalid'
        // selected file by the user
        const choose = () => ref.current && ref.current.click();

        const onChange = (e) => {
            const f = e.target.files[0] || null;
            setFile(f);
            if (!f) {
              setFileType('');
              return;
            }
            const nameLower = f.name.toLowerCase();
            const isValid = allowedExt.some(ext => nameLower.endsWith(ext));    // check if the extension is correct or not
            setFileType(isValid ? 'valid' : 'invalid');
            e.target.value = null;
        };
        const reset = () => {
            setFile(null);
            setFileType('');
        }
        return { ref, file, fileType, choose, onChange, fileName: file ? file.name : '', reset };
    }

    function handleUpload({ descriptors, setOutput, setOutputType, requireAny = true }) {
        // manages the behavior when a file is uploaded
        const errors = [];
        let errorMessage
        // set error messages depending on file type
        descriptors.forEach((d) => {
            if (d.fileType === 'invalid') {
                errors.push(`${d.label} has wrong format.`);
                if(d.label === "Playbook"){
                    errorMessage = errors + " File must be in 'yml' or 'yaml' format"
                }else{
                    errorMessage = errors + " File must be in 'zip' format"
                }
            }
        });
        // set errors if any
        if (errors.length > 0) {
            setOutput(errorMessage);
            setOutputType('error');
            return false;
        }
        // error if the user press button to execute a file, but there are not selected files
        // vedere cosa succede se c'è un experiment_description selezionato e l'utente preme run experiment_step
        const anySelected = descriptors.some(d => d.file);
        if (requireAny && !anySelected) {
            setOutput('No files selected');
            setOutputType('error');
            return false;
        }
        // add name to uploaded files list
        const names = descriptors.reduce((acc, d) => {
            if (d.file) acc.push(`${d.label}: ${d.file.name}`);
            return acc;
        }, []);
        // add to the output timestamp of upload
        const time = new Date().toLocaleString();
        setOutput(`File uploaded (${time}) — ${names.join(' | ')}`);
        setOutputType('success');
        return true;
    }

    function createDownload(blob, filename){
        // create object URL and start download without adding permanent link
        const url = window.URL.createObjectURL(blob);
        // create <a>, set href and click
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        // some browsers need to add the element to the body, after download we remove
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // remove URL to free memory
        window.URL.revokeObjectURL(url);
    }

    const downloadFile= async (experiment_type) =>{
        // executed when user press download button
        if (experiment_type === "first") {
            setWaitOperation(true);
            setWaitOperation(false);

        } else if (experiment_type === "third") {
            setWaitOperation(true);
            setWaitOperation(false);
        }
    }


    // function for numeric input
    const handleNumericChange = (setter) => (e) => {
        const value = e.target.value;
        // only integers
        if (value === '' || /^\d+$/.test(value)) {
            setter(value);
        }
    };

    // ----------------------------------------------
    const allowedPlaybookExt = ['.yml', '.yaml', '.sh', '.bash'];

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

    const handleRemovePlaybookRow = (index) => {
        if (index === 0) return;
        setPlaybookRows(prev => prev.filter((_, i) => i !== index));
    };

    const handleExecutionTimeChange = (id, value) => {
        if (value === '' || /^\d+$/.test(value)) {
            setPlaybookRows(prev =>
                prev.map(r => r.id === id ? { ...r, executionTime: value } : r)
            );
        }
    };

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

    const handleAddMetricRow = (index) => {
        const newId = ++metricIdCounter.current;
        setMetricRows(prev => {
            const copy = [...prev];
            copy.splice(index + 1, 0, { id: newId,  path: '', status: '', message: '' });
            return copy;
        });
    };

    const handleRemoveMetricRow = (index) => {
        if (index === 0) return;
        setMetricRows(prev => prev.filter((_, i) => i !== index));
    };

    // Update metric path
    const handleMetricPathChange = (id, value) => {
        // check if the metric is predefined
        const isPredefined = predefinedMetrics.some(metric => metric.path === value.trim());
        setMetricRows(prev =>
            prev.map(r => r.id === id ? { ...r, path: value, status: isPredefined ? 'predefined' : '',  message: isPredefined ? 'predefined' : '' } : r)
        );
    };

    const handleAddMetrics = async () => {
        // Check for empty fields
        const hasEmpty = metricRows.some(row => !row.path.trim());

        if (hasEmpty) {
            // Mark empty fields in red
            setMetricRows(prev =>
                prev.map(r => ({
                    ...r,
                    status: !r.path.trim() ? 'empty' : r.status,
                    message: !r.path.trim() ? 'empty' : r.message
                }))
            );
            return;
        }

        // find first device with role different from "host"
        const switchDevice = deviceList.find(device =>
            device.role && device.role.toLowerCase() !== 'host'
        );

        // if every device is host, show error
        if (!switchDevice) {
            alert('Error: No switch device (leaf/spine) found. At least one non-host device is required to validate metrics.');
            return;
        }

        // create a map of the metrics to send with their original indexes
        const metricsToSendWithIndex = [];
        const predefinedIndices = [];
        // filter all predefined metrics
        metricRows.forEach((row, idx) => {
            const isPredefined = predefinedMetrics.some(metric => metric.path === row.path.trim());
            if (isPredefined) {
                predefinedIndices.push(idx);
            } else {
                metricsToSendWithIndex.push({ row, originalIndex: idx });
            }
        });

        // if all the metrics are predefined, do not send anything
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
                // Update rows with validation results
                setMetricRows(prev => {
                    const newRows = [...prev];
                    // Mappa i risultati del server agli indici originali
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

                // Reload custom metrics to update the selection list
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

    // Free mode ---------------------------------------------------------------------------
    const handleFreePlaybookFiles = (e) => {
        const files = Array.from(e.target.files || []);

        const validFiles = files.filter(f => {
            const name = f.name.toLowerCase();
            return name.endsWith('.yml') || name.endsWith('.yaml');
        });

        setFreePlaybookFiles(prev => [...prev, ...validFiles]);
        e.target.value = null;
    };

    const removeFreePlaybookFile = (index) => {
        setFreePlaybookFiles(prev => prev.filter((_, i) => i !== index));
    };

    const chooseFreePlaybooks = () => {
        freeModeFileRef.current?.click();
    };

    const downloadTemplate = async () => {
        setWaitOperation(true);
        const payload = {reservation_id};
        try {
            const response = await fetch(`http://localhost:5004/api/experimenter/downloadTemplate`, {
                method: 'POST',
                headers: {'Content-Type': 'application/x-yaml'},
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                console.error('Failed to download template');
            }

            const blob = await response.blob();
            createDownload(blob, 'experiment_template.yml');
        } catch (error) {
            console.error('Error downloading template:', error);
        } finally {
            setWaitOperation(false);
        }
    };

    // Interactive mode -------------------------------------------------------------------------
    const handleCreateExperiment = async () => {
        // check each field is not empty
        const allRowsFilled = playbookRows.every(row => row.executionTime && row.file);

        if (!experimentDuration || experimentDuration === '0') {
            setExperimentMessage('Experiment duration is required');
            setExperimentMessageType('error');
            return;
        }

        if (!allRowsFilled) {
            setExperimentMessage('Following rows must have execution time and file selected');
            setExperimentMessageType('error');
            return;
        }

        // check for invalid files
        const hasInvalidFiles = playbookRows.some(row => row.fileType === 'invalid');

        if (hasInvalidFiles) {
            setExperimentMessage('Invalid playbook files detected');
            setExperimentMessageType('error');
            return;
        }

        const formData = new FormData();
        formData.append('duration', experimentDuration);
        formData.append('reservation_id', reservation_id);

        // add playbook rows as JSON
        const playbooksData = playbookRows.map(row => ({
            execution_time: row.executionTime,
            devices: row.selectedDevices,
            filename: row.fileName
        }));

        formData.append('playbooks_data', JSON.stringify(playbooksData));

        // add file
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
            }

            const blob = await response.blob();
            const filename = `res_${reservation_id}_exp_description.yml`;
            createDownload(blob, filename);

            setExperimentMessage(filename);
            setExperimentMessageType('success');
        } catch (error) {
            console.error('Error creating experiment:', error);
            setExperimentMessage('Error creating experiment');
            setExperimentMessageType('error');
        } finally {
            setWaitOperation(false);
        }
    };

    // Guided mode -------------------------------------------------------------------------------
    const handleDeviceSelect = (device, type) => {
        if (type === 'client') {
            // deselect, if client selected
            if (iperfClients.includes(device)) {
                setIperfClients(prev => prev.filter(d => d !== device));
                setIperfServers(prev => prev.filter(d => d !== device)); // remove from server
            } else {
                // select as client, remove from server
                setIperfClients(prev => [...prev, device]);
                setIperfServers(prev => prev.filter(d => d !== device));
            }
        } else {
            // deselect, if server selected
            if (iperfServers.includes(device)) {
                setIperfServers(prev => prev.filter(d => d !== device));
                setIperfClients(prev => prev.filter(d => d !== device)); // // remove from client
            } else {
                // // select as server, remove from  client
                setIperfServers(prev => [...prev, device]);
                setIperfClients(prev => prev.filter(d => d !== device));
            }
        }
    };

    // Handler for device toggle in global mode
    const handleGlobalDeviceToggle = (deviceName) => {
        setGlobalDevices(prev =>
            prev.includes(deviceName)
                ? prev.filter(d => d !== deviceName)
                : [...prev, deviceName]
        );
    };

    // Handler for device toggle in per-metric mode
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

    // variable for non-host devices
    const nonHostDevices = deviceList.filter(device =>
        device.role && device.role.toLowerCase() !== 'host'
    ).sort((a, b) => a.name.localeCompare(b.name));


    // ----------------------------------------------
    return (
        <div className="home-content-wrapper experiment-wrapper">

            <div className="card experiment-card">
                <h2 className="title">🧪 Setup and run experiment</h2>

                {/* Row for type 1 of experiment */}
                <div className="experiment-section">
                    <h3 className="section-title">Free Mode</h3>
                    <div className="section-content">
                        <div className="config-row">
                            <label className="label-inline label-fixed-width">Download description template:</label>
                            <button type="button" className="template-button configuration-button"
                                    onClick={downloadTemplate} disabled={runningExperiment || waitOperation}>Download
                            </button>
                            <label className="label-inline label-fixed-width additional-margin">Load experiment description:</label>
                            <button type="button" className="template-button configuration-button choose-button"
                                    onClick={experimentDescription.choose} disabled={runningExperiment}>Choose
                                description
                            </button>
                            <div
                                className={`selected-file-name file-status-${experimentDescription.fileType} additional-margin`}>{experimentDescription.fileName}</div>
                            <input ref={experimentDescription.ref} type="file" style={{display: 'none'}}
                                   onChange={experimentDescription.onChange}
                                   disabled={runningExperiment}/>
                        </div>

                        <div className="config-row">
                            <label className="label-inline label-fixed-width">Load playbooks:</label>
                            <button type="button" className="playbook-button configuration-button choose-button"
                                    onClick={chooseFreePlaybooks} disabled={runningExperiment}>Choose playbooks
                            </button>
                            <input ref={freeModeFileRef} type="file" multiple accept=".yml,.yaml"
                                   style={{display: 'none'}} onChange={handleFreePlaybookFiles}
                                   disabled={runningExperiment}/>
                        </div>

                        {freePlaybookFiles.length > 0 && (
                            <div className="config-row">
                                <div className="playbook-files-list">
                                    {freePlaybookFiles.map((file, idx) => (
                                        <div key={idx} className="playbook-file-item">
                                            <span className="file-name-text">{file.name}</span>
                                            <button
                                                type="button"
                                                className="remove-file-btn"
                                                onClick={() => removeFreePlaybookFile(idx)}
                                                disabled={runningExperiment}
                                            >×</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="experiment-section">
                    <h3 className="section-title">Interactive Mode</h3>
                    <div className="section-content">
                        <div className="config-row">
                            {/* Experiment duration line */}
                            <label className="label-inline label-fixed-width label-output">Insert experiment duration
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
                            <div className={`experiment-created-message ${experimentMessageType}`}>{experimentMessage}</div>
                        </div>
                        {/* Row for second mode of experiment definition */}
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
                                >+</label>
                                <label
                                    className="label-inline add-remove-label"
                                    onClick={() => handleRemovePlaybookRow(idx)}
                                    style={{
                                        opacity: idx === 0 ? 0.3 : 1,
                                        pointerEvents: idx === 0 ? 'none' : 'auto'
                                    }}
                                >-</label>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="experiment-section">
                    <h3 className="section-title">Guided Mode</h3>
                    <div className="section-content">
                        {/* Row for third type of experiment */}
                        <div className="config-row">
                            <label className="label-inline label-fixed-width">Experiment duration (seconds):</label>
                            <input
                                type="text"
                                className="duration-field"
                                value={guidedDuration}
                                onChange={handleNumericChange(setGuidedDuration)}
                                readOnly={runningExperiment}
                            />
                        </div>

                        <div className="config-row guided-row">
                            <label className="label-inline label-fixed-width">Select iperf configuration:</label>

                            <div className="guided-right">
                                {/* Device selection table */}
                                <div className="device-selection-table">
                                    <div className="device-table-header">
                                        <span className="device-col">Device</span>
                                        <span className="role-col">Client</span>
                                        <span className="role-col">Server</span>
                                    </div>
                                    {[...deviceList].sort((a, b) => a.name.localeCompare(b.name)).map(device => (
                                        <div key={device.name} className="device-table-row">
                                            <span className="device-col">{device.name}</span>
                                            <span className="role-col">
                                                <input
                                                    type="checkbox"
                                                    checked={iperfClients.includes(device.name)}
                                                    onChange={() => handleDeviceSelect(device.name, 'client')}
                                                    disabled={runningExperiment}
                                                />
                                            </span>
                                            <span className="role-col">
                                                <input
                                                    type="checkbox"
                                                    checked={iperfServers.includes(device.name)}
                                                    onChange={() => handleDeviceSelect(device.name, 'server')}
                                                    disabled={runningExperiment}
                                                />
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="experiment-section">
                    <h3 className="section-title">Telemetry</h3>
                    <div className="section-content">
                        {/* choose metric row */}
                        <div className="config-row">
                            <label className="label-inline label-fixed-width label-output">Choose metrics:</label>
                        </div>

                        <div className="metrics-selection-container">
                            {/* Predefined metrics */}
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

                            {/* Custom metrics */}
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

                        {/* Add custom metrics */}
                        <div className="config-row">
                            <label className="label-inline label-fixed-width">Add custom metrics:</label>
                        </div>

                        {metricRows.map((row, idx) => (
                            <div key={row.id} className="config-row metric-add-row">
                                <input
                                    type="text"
                                    className={`metric-path-input ${row.status === 'empty' || row.status === 'error' || row.status === 'predefined' ? 'input-error' : row.status === 'success' ? 'input-success' : row.status === 'warning' ? 'input-warning': ''}`}
                                    placeholder="e.g., COUNTERS_DB:COUNTERS/Ethernet8 or /openconfig-..."
                                    value={row.path}
                                    onChange={(e) => handleMetricPathChange(row.id, e.target.value)}
                                    disabled={runningExperiment || validatingMetrics}
                                />

                                <label
                                    className="label-inline add-remove-label"
                                    onClick={() => !runningExperiment && !validatingMetrics && handleAddMetricRow(idx)}
                                    style={{ pointerEvents: runningExperiment || validatingMetrics ? 'none' : 'auto' }}
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
                            <button type="button" className="send-button configuration-button" onClick={handleAddMetrics} disabled={runningExperiment || validatingMetrics}> Add Metrics</button>
                        </div>

                        {/* Sampling configuration */}
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
                                <label className="label-inline label-radio" htmlFor="perMetricSampling">Per-metric</label>
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
                                            value={metricIntervals[metricPath] || '5'}
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

                        {/* Telemetry type row */}
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
                    </div>
                </div>

                <div className="experiment-section experiment-controls">
                    {/* Experiment time left row */}
                    <div className="config-row config-row-space-between">
                        <div className="time-left-group">
                            <label className="label-inline label-fixed-width">Experiment time left:</label>
                            <label className="label-inline time-display">--:--</label>
                        </div>
                        {/* Experiment buttons */}
                        <div className="experiment-buttons">
                            <button type="button" className="start-button configuration-button"
                                    disabled={runningExperiment}>Run experiment
                            </button>
                            <button
                                type="button"
                                className="delete-button delete configuration-button"
                                disabled={!runningExperiment}
                            >
                                Finish experiment
                            </button>
                        </div>
                    </div>

                    <div className="config-row">
                        <div className="experiment-output-message">
                            {/* Initial void message, change after run/delete */}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}