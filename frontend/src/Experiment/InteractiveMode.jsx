// InteractiveMode.jsx
import React, { useRef } from 'react';
import jsyaml from 'js-yaml';
import JSZip from 'jszip';

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
    idCounter,
    yamlUploadMessage,
    yamlUploadMessageType,
    setYamlUploadMessage,
    setYamlUploadMessageType,
    zipUploadMessage,
    zipUploadMessageType,
    setZipUploadMessage,
    setZipUploadMessageType
}) {
    const playbookFileRefs = useRef({});
    const yamlUploadRef = useRef(null);
    const zipUploadRef = useRef(null);

    // shared function to validate YAML template
    const processYamlTemplate = (yamlContent) => {
        try {
            const parsed = jsyaml.load(yamlContent);

            if (parsed.iperf_flows) {
                return {
                    success: false,
                    error: 'Invalid YAML format: experiments with iperf_flows are not supported in interactive mode'
                };
            }

            if (!parsed.experiment_id || !parsed.duration_s || !parsed.schedule) {
                return {
                    success: false,
                    error: 'Invalid YAML format: required fields are experiment_id, duration_s, schedule'
                };
            }

            if (!Array.isArray(parsed.schedule) || parsed.schedule.length === 0) {
                return {
                    success: false,
                    error: 'Invalid YAML format: schedule must be a non-empty array'
                };
            }

            if (isNaN(parsed.duration_s) || parsed.duration_s <= 0) {
                return {
                    success: false,
                    error: 'Invalid YAML format: duration_s must be a positive number'
                };
            }

            for (const item of parsed.schedule) {
                if (item.time_offset_s === undefined || isNaN(item.time_offset_s) || item.time_offset_s < 0) {
                    return {
                        success: false,
                        error: 'Invalid YAML format: time_offset_s must be a non-negative number'
                    };
                }
            }

            return {
                success: true,
                data: parsed
            };
        } catch (error) {
            return {
                success: false,
                error: `Invalid YAML format: ${error.message}`
            };
        }
    };

    const handleYamlUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {

            const result = processYamlTemplate(event.target.result);

            if (!result.success) {
              setYamlUploadMessage(result.error);
              setYamlUploadMessageType('error');
              return;
            }

            const parsed = result.data;

            // populate experiment name and duration
            setExperimentName(parsed.experiment_id);
            setExperimentDuration(parsed.duration_s);

            // populate playbook rows from schedule
            const newRows = parsed.schedule.map((item) => {
                const newId = ++idCounter.current;
                // filter targets to only include devices that exist in deviceList
                const validDevices = (item.targets || []).filter(target =>
                    deviceList.some(device => device.name === target)
                );
                return {
                    id: newId,
                    executionTime: item.time_offset_s,
                    file: null, // file needs to be uploaded separately
                    fileName: item.playbook || '',
                    fileType: '', // will be set when user uploads the actual file
                    selectedDevices: validDevices
                };
            });

            setPlaybookRows(newRows);
            setYamlUploadMessage('YAML loaded successfully. Please upload the playbook files for each step');
            setYamlUploadMessageType('success');
        };

        reader.readAsText(file);
        e.target.value = null; // reset input
    };

    const handleZipUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
            const zip = new JSZip();
            const contents = await zip.loadAsync(file);

            const yamlFiles = Object.keys(contents.files).filter(
                name => !contents.files[name].dir && (name.endsWith('.yml') || name.endsWith('.yaml'))
            );

            if (yamlFiles.length === 0) {
                setZipUploadMessage('No YAML files found in zip');
                setZipUploadMessageType('error');
                return;
            }

            // find template
            let templateFile = null;
            let parsed = null;

            for (const fileName of yamlFiles) {
                const content = await contents.files[fileName].async('text');
                const result = processYamlTemplate(content);


                if (result.success && result.data.experiment_id && result.data.duration_s && result.data.schedule) {
                    if (templateFile) {
                        setZipUploadMessage('Multiple experiment definition files found in zip');
                        setZipUploadMessageType('error');
                        return;
                    }
                    templateFile = fileName;
                    parsed = result.data;
                }
            }

            if (!templateFile || !parsed) {
                setZipUploadMessage('No correct experiment definition file found in zip');
                setZipUploadMessageType('error');
                return;
            }

            setExperimentName(parsed.experiment_id);
            setExperimentDuration(parsed.duration_s);

            const requiredPlaybooks = parsed.schedule.map(item => item.playbook);
            const playbookFiles = new Map();

            for (const fileName of yamlFiles) {
                if (fileName !== templateFile) {
                    const baseName = fileName.split('/').pop();
                    const content = await contents.files[fileName].async('blob');
                    const fileObj = new File([content], baseName, { type: 'application/x-yaml' });
                    playbookFiles.set(baseName, fileObj);
                }
            }

            // check extra/missing files
            const missingFiles = requiredPlaybooks.filter(pb => !playbookFiles.has(pb));
            const extraFiles = Array.from(playbookFiles.keys()).filter(name => !requiredPlaybooks.includes(name));

            const newRows = parsed.schedule.map((item) => {
                const newId = ++idCounter.current;
                const validDevices = (item.targets || []).filter(target =>
                    deviceList.some(device => device.name === target)
                );
                const playbookFile = playbookFiles.get(item.playbook);

                return {
                    id: newId,
                    executionTime: item.time_offset_s,
                    file: playbookFile || null,
                    fileName: item.playbook || '',
                    fileType: playbookFile ? 'valid' : '',
                    selectedDevices: validDevices
                };
            });

            setPlaybookRows(newRows);

            let message = 'Experiment loaded successfully';
            let messageType = 'success';

            if (missingFiles.length > 0 || extraFiles.length > 0) {
                const warnings = [];
                if (missingFiles.length > 0) warnings.push(`Missing: ${missingFiles.join(', ')}`);
                if (extraFiles.length > 0) warnings.push(`Ignored: ${extraFiles.join(', ')}`);
                message += ' - ' + warnings.join(' - ');
                messageType = 'warning';
            }

            setZipUploadMessage(message);
            setZipUploadMessageType(messageType);

        } catch (error) {
            setZipUploadMessage(`Error processing zip: ${error.message}`);
            setZipUploadMessageType('error');
        }

        e.target.value = null;
    };

    // download iperf3 and nfs example playbook
    const downloadIperfExample = async () => {
        try {
            const response = await fetch('http://localhost:5004/api/experimenter/downloadTemplate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    experiment_mode: "interactive"
                })
            });

            if (!response.ok) {
                console.error('Failed to download iperf and nfs example');
                return;
            }

            const blob = await response.blob();
            createDownload(blob, 'experiment_template_package.zip');
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
        const allRowsFilled = playbookRows.every(row =>  (row.executionTime !== '' && row.executionTime !== null && row.executionTime !== undefined) && row.file);

        if (!experimentName || !experimentName.trim()) {
            setExperimentMessage('Experiment name is required');
            setExperimentMessageType('error');
            return;
        }

        if (!experimentDuration || experimentDuration === '' || experimentDuration === '0') {
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

        const filename = `${experimentName.trim().toLowerCase().replace(/ /g, '_')}.yml`;
        try {
            const checkResponse = await fetch('http://localhost:5004/api/experimenter/checkFileExists', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    reservation_id: reservation_id,
                    filename: filename,
                    file_type: 'template'
                })
            });

            const checkData = await checkResponse.json();

            if (checkData.success && checkData.exists) {
                const overwrite = window.confirm(`An experiment named "${filename}" already exists. Do you want to overwrite it?`);
                if (!overwrite) {
                    return; // user chose not to overwrite
                }
            }
        } catch (error) {
            console.error('Error checking file existence:', error);
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
                    <label className="label-inline label-fixed-width label-output">Load experiment YAML template file:</label>
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
                        title="Upload experiment definition YAML file"
                    >
                        Upload template
                    </button>
                    {yamlUploadMessage && (
                        <span
                            className={`message-inline ${yamlUploadMessageType === 'error' ? 'error-validation' : 'success-validation'}`}>
                        {yamlUploadMessage}
                      </span>
                    )}
                </div>
                <div className="config-row">
                    <label className="label-inline label-fixed-width label-output">Load ZIP with experiment templates:</label>
                    <input
                        type="file"
                        ref={zipUploadRef}
                        accept=".zip"
                        onChange={handleZipUpload}
                        style={{display: 'none'}}
                    />
                    <button
                        type="button"
                        className="compile-form-button configuration-button"
                        onClick={() => zipUploadRef.current?.click()}
                        disabled={runningExperiment}
                        title="Upload experiment definition zip"
                    >
                        Upload zip folder
                    </button>
                    {zipUploadMessage && (
                        <span
                            className={`message-inline ${zipUploadMessageType === 'error' ? 'error-validation' : zipUploadMessageType === 'warning' ? 'warning-validation' : 'success-validation'}`}>
                        {zipUploadMessage}
                      </span>
                    )}
                </div>
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
                    <label className="label-inline label-fixed-width label-output">Download description template
                        package:</label>
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
                        <div className={`selected-file-name-compact file-status-${row.fileType}`}>{row.fileName}</div>
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
                            style={{pointerEvents: runningExperiment ? 'none' : 'auto'}}
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