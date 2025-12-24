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
    const [newMetric, setNewMetric] = useState('');  //manual add of metric
    const [selectedMetrics, setSelectedMetrics] = useState([]); // multiple selection
    const [telemetryType, setTelemetryType] = useState(''); // radio button status

    // free mode states
    const [freePlaybookFiles, setFreePlaybookFiles] = useState([]);
    const freeModeFileRef = useRef(null);
    const [experimentMessage, setExperimentMessage] = useState('');
    const [experimentMessageType, setExperimentMessageType] = useState(''); // 'success' | 'error'
    // guided mode states
    const [guidedDuration, setGuidedDuration] = useState('');
    const deviceList = ['sw1', 'sw2', 'sw3', 'sw4', 'h1', 'h2', 'h3', 'h4'];
    const [iperfClients, setIperfClients] = useState([]);
    const [iperfServers, setIperfServers] = useState([]);

    // list of metrics
    const metricOptions = [
        'CPU Utilization',
        'Memory Usage',
        'Network Latency',
        'Disk I/O',
        'Process Count'
    ];

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
      { id: 1, value: '' }
    ]);

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

    // function to manage + and - buttons
    const handleAddRemove = (action) => {
        console.log(`Action: ${action}`);
    };
    const handleAddMetrics = () => {
        console.log("Adding selected metrics:", selectedMetrics);
        // Logica futura per inviare le metriche al backend
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
            copy.splice(index + 1, 0, { id: newId, value: '' });
            return copy;
        });
    };

    const handleRemoveMetricRow = (index) => {
        if (index === 0) return;
        setMetricRows(prev => prev.filter((_, i) => i !== index));
    };

    const handleMetricChange = (id, value) => {
        setMetricRows(prev =>
            prev.map(m => m.id === id ? { ...m, value } : m)
        );
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
            const response = await fetch(`http://localhost:5004/api/experimenter/template`, {
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
                                    {deviceList.map(device => (
                                        <label key={device} className="device-checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={row.selectedDevices.includes(device)}
                                                onChange={() => handleDeviceToggle(row.id, device)}
                                                disabled={runningExperiment}
                                            />
                                            <span>{device}</span>
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
                                    {deviceList.map(device => (
                                        <div key={device} className="device-table-row">
                                            <span className="device-col">{device}</span>
                                            <span className="role-col">
                                                <input
                                                    type="checkbox"
                                                    checked={iperfClients.includes(device)}
                                                    onChange={() => handleDeviceSelect(device, 'client')}
                                                    disabled={runningExperiment}
                                                />
                                            </span>
                                            <span className="role-col">
                                                <input
                                                    type="checkbox"
                                                    checked={iperfServers.includes(device)}
                                                    onChange={() => handleDeviceSelect(device, 'server')}
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
                            <select
                                className="select-field"
                                disabled={runningExperiment}
                                multiple={true}                 // multiple selection
                                value={selectedMetrics}
                                onChange={(e) => {
                                    // multiple selection logic
                                    const options = Array.from(e.target.options);
                                    const value = options.filter(option => option.selected).map(option => option.value);
                                    setSelectedMetrics(value);
                                }}
                            >
                                {/* select fill with metricOptions */}
                                {metricOptions.map((metric) => (
                                    <option key={metric} value={metric}>
                                        {metric}
                                    </option>
                                ))}
                            </select>

                            <button type="button"
                                    className="send-button configuration-button choose-button additional-margin"
                                    onClick={handleAddMetrics} disabled={runningExperiment}>Add metrics
                            </button>
                        </div>

                        {/* add metric row */}
                        {metricRows.map((m, idx) => (
                            <div key={m.id} className="config-row">
                                <label className="label-inline label-fixed-width">Add metric:</label>

                                <input
                                    type={"text"}
                                    className="add-metric-field"
                                    value={m.value}
                                    onChange={(e) => handleMetricChange(m.id, e.target.value)}
                                    readOnly={runningExperiment}
                                />

                                <label className="label-inline add-remove-label" onClick={() => handleAddMetricRow(idx)}>+</label>

                                <label
                                    className="label-inline add-remove-label"
                                    onClick={() => handleRemoveMetricRow(idx)}
                                    style={{
                                        opacity: idx === 0 ? 0.3 : 1,
                                        pointerEvents: idx === 0 ? 'none' : 'auto'
                                    }}
                                >-</label>
                            </div>
                        ))}

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