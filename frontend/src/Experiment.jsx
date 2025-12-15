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
      { id: 1, executionTime: '', file: null, fileName: '', fileType: '' }
    ]);

    const playbookFileRefs = useRef({});

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
                fileType: ''
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


    // ----------------------------------------------
    return (
        <div className="home-content-wrapper experiment-wrapper">

            <div className="card experiment-card">
                <h2 className="title">⚙️ Setup and run experiment</h2>

                {/* Row for type 1 of experiment */}
                <div className="config-row main-actions-row">
                    <div className="aligned-group">
                        <label className="label-inline">Download description template:</label>
                        <button type="button" className="template-button configuration-button"
                                onClick={() => downloadFile("template")} disabled={runningExperiment}>Download
                        </button>
                        <label className="label-inline additional-margin">Load experiment description:</label>
                        <button type="button" className="template-button configuration-button choose-button"
                                onClick={experimentDescription.choose} disabled={runningExperiment}>Choose description
                        </button>
                        <div className={`selected-file-name file-status-${experimentDescription.fileType}`}>{experimentDescription.fileName}</div>
                        <input ref={experimentDescription.ref} type="file" style={{display: 'none'}} onChange={experimentDescription.onChange}
                               disabled={runningExperiment}/>
                    </div>
                </div>

                {/* Experiment duration line */}
                <div className="duration-row">
                    <div className="aligned-group">
                        <label className="label-inline label-output">Insert experiment duration (seconds):</label>
                        <input
                            type={"text"}
                            className={`duration-field`}
                            value={experimentDuration}
                            onChange={handleNumericChange(setExperimentDuration)}
                            readOnly={runningExperiment}
                        />
                        <button type="button" className="send-button experiment-button additional-margin"
                                disabled={runningExperiment}>Create experiment
                        </button>
                    </div>
                </div>

                {/* Row for second mode of experiment definition */}
                {/*<div className="config-row main-actions-row">
                    <div className="aligned-group">
                        <label className="label-inline">Time of execution (seconds):</label>
                        <textarea
                            className={`duration-field`}
                            value={executionTime}
                            onChange={handleNumericChange(setExecutionTime)}
                            readOnly={runningExperiment}
                        />
                        <label className="label-inline additional-margin">Load playbook/script:</label>
                        <button type="button" className="playbook-button configuration-button choose-button"
                                onClick={experimentStep.choose} disabled={runningExperiment}>Choose file
                        </button>
                        <div className={`selected-file-name file-status-${experimentStep.fileType}`}>{experimentStep.fileName}</div>
                        <input ref={experimentStep.ref} type="file" style={{display: 'none'}}
                               onChange={experimentStep.onChange}
                               disabled={runningExperiment}/>
                        <label className="label-inline add-remove-label" onClick={() => handleAddRemove('add_playbook')}>+</label>
                        <label className="label-inline add-remove-label" onClick={() => handleAddRemove('remove_playbook')}>-</label>
                    </div>
                </div>*/}
                {playbookRows.map((row, idx) => (
                    <div key={row.id} className="config-row main-actions-row">
                        <div className="aligned-group">
                            <label className="label-inline">Time of execution (seconds):</label>
                            <input
                                type={"text"}
                                className="duration-field"
                                value={row.executionTime}
                                onChange={(e) => handleExecutionTimeChange(row.id, e.target.value)}
                                readOnly={runningExperiment}
                            />
                            <label className="label-inline additional-margin">Load playbook/script:</label>
                            <button
                                type="button"
                                className="playbook-button configuration-button choose-button"
                                onClick={() => choosePlaybookFile(row.id)}
                                disabled={runningExperiment}
                            >
                            Choose file
                            </button>
                            <div className={`selected-file-name file-status-${row.fileType}`}>{row.fileName}</div>
                            <input
                                type="file"
                                ref={(el) => (playbookFileRefs.current[row.id] = el)}
                                style={{ display: 'none' }}
                                onChange={(e) => onPlaybookFileChange(e, row.id)}
                                disabled={runningExperiment}
                            />
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
                    </div>
                ))}

                {/* Row for third type of experiment */}
                <div className="config-row main-actions-row">
                    <div className="aligned-group">
                        <label className="label-inline">Download description template:</label>
                        <button type="button" className="template-button configuration-button"
                                onClick={() => downloadFile("template")} disabled={runningExperiment}>Download
                        </button>
                        <label className="label-inline additional-margin">Load experiment description:</label>
                        <button type="button" className="template-button configuration-button choose-button"
                                onClick={experimentDescriptionThird.choose} disabled={runningExperiment}>Choose description
                        </button>
                        <div className={`selected-file-name file-status-${experimentDescriptionThird.fileType}`}>{experimentDescriptionThird.fileName}</div>
                        <input ref={experimentDescriptionThird.ref} type="file" style={{display: 'none'}} onChange={experimentDescriptionThird.onChange}
                               disabled={runningExperiment}/>
                    </div>
                </div>

                {/* choose metric row */}
                <div className="config-row">
                    <div className="aligned-group">
                        <label className="label-inline label-output">Choose metrics:</label>
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
                        <button type="button" className="template-button configuration-button choose-button additional-margin"
                                onClick={handleAddMetrics} disabled={runningExperiment}>Add metrics
                        </button>
                    </div>
                </div>

                {/* add metric row */}
                {/*
                <div className="config-row main-actions-row">
                    <div className="aligned-group">
                        <label className="label-inline">Add metric:</label>
                        <textarea
                            className={`add-metric-field`}
                            value={newMetric}
                            onChange={(e) => setNewMetric(e.target.value)} // input management
                            readOnly={runningExperiment}
                        />
                        <label className="label-inline add-remove-label" onClick={() => handleAddRemove('add_metric')}>+</label>
                        <label className="label-inline add-remove-label" onClick={() => handleAddRemove('remove_metric')}>-</label>
                    </div>
                </div>
                */}
                {metricRows.map((m, idx) => (
                    <div key={m.id} className="config-row main-actions-row">
                        <div className="aligned-group">
                            <label className="label-inline">Add metric:</label>

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
                    </div>
                ))}

                {/* Telemetry type row */}
                <div className="config-row main-actions-row">
                    <label className="label-inline">Telemetry type:</label>
                    <input
                        type="radio"
                        id="realTime"
                        name="telemetry_type"
                        value="Real time mode"
                        checked={telemetryType === 'Real time mode'}
                        onChange={(e) => setTelemetryType(e.target.value)}
                        disabled={runningExperiment}
                    />
                    <label className="label-inline" htmlFor="realTime">Real time mode</label>
                    <input
                        type="radio"
                        id="afterExperiment"
                        name="telemetry_type"
                        value="After experiment mode"
                        checked={telemetryType === 'After experiment mode'}
                        onChange={(e) => setTelemetryType(e.target.value)}
                        disabled={runningExperiment}
                    />
                    <label className="label-inline" htmlFor="afterExperiment">After experiment mode</label>
                </div>

                {/* Experiment time left row */}
                <div className="config-row main-actions-row">
                    <label className="label-inline">Experiment time left:</label>
                    <label className="label-inline">--:--</label>
                </div>

                {/* Experiment buttons */}
                <div className="config-row main-actions-row">
                    <div className="experiment-buttons">
                        <button type="button" className="rollback-button configuration-button"
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
            </div>
        </div>
    );
}