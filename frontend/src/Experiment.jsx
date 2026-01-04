// Configuration.jsx
import React, {useState, useRef, useEffect} from 'react';
import './style/style.css';
import './style/experiment.css';

export default function Experiment({username, reservation_id}) {
    // files: experiment_description and configuration files
    const experimentDescription = useFileInput(['.yml', '.yaml']);
    const [experimentDuration, setExperimentDuration] = useState('');   // experiment duration

    // free mode states
    const [freePlaybookFiles, setFreePlaybookFiles] = useState([]);
    const freeModeFileRef = useRef(null);
    const [experimentMessage, setExperimentMessage] = useState('');
    const [experimentMessageType, setExperimentMessageType] = useState(''); // 'success' | 'error'
    const [templateValidation, setTemplateValidation] = useState({ message: '', type: '' }); // 'success' | 'error
    // interactive mode
    const [experimentName, setExperimentName] = useState('');       // name of the experiment
    // guided mode states
    const [guidedDuration, setGuidedDuration] = useState('');
    const [guidedExperimentName, setGuidedExperimentName] = useState('');
    const [guidedMessage, setGuidedMessage] = useState('');
    const [guidedMessageType, setGuidedMessageType] = useState('');  // 'success' | 'error'
    const [deviceList, setDeviceList] = useState([]);
    const [iperfClients, setIperfClients] = useState([]);
    const [iperfServers, setIperfServers] = useState([]);
    // metrics states
    const [predefinedMetrics, setPredefinedMetrics] = useState([]);  // common metrics
    const [customMetrics, setCustomMetrics] = useState([]);          //manual add of metric
    const [selectedMetrics, setSelectedMetrics] = useState([]);
    const [telemetryType, setTelemetryType] = useState('');         // radio button status
    const [telemetryCreateMessage, setTelemetryCreateMessage] = useState('');
    const [telemetryCreateMessageType, setTelemetryCreateMessageType] = useState(''); // 'success' | 'error'
    // dynamic iperf flows
    const [iperfFlows, setIperfFlows] = useState([
        {id: 1, client: '', server: '', bandwidth: '', protocol: 'tcp', /*parallelStreams: '1',*/ startOffset: '', duration: ''}
    ]);
    const iperfFlowIdCounter = useRef(1);
    // Sampling
    const [samplingMode, setSamplingMode] = useState('global');
    const [globalInterval, setGlobalInterval] = useState('5');
    const [metricIntervals, setMetricIntervals] = useState({});

    const [globalDevices, setGlobalDevices] = useState([]);  // device for global mode
    const [metricDevices, setMetricDevices] = useState({});    // device for per-metric mode {metricPath: [device1, device2, ...]}
    // Validation in progress
    const [validatingMetrics, setValidatingMetrics] = useState(false);

    // experiment mode selected by user
    const [selectedMode, setSelectedMode] = useState('free'); // 'free' | 'interactive' | 'guided'
    // experiment section
    const [experimentTimer, setExperimentTimer] = useState('--:--:--');
    const [experimentRunMessage, setExperimentRunMessage] = useState('');
    const [experimentRunMessageType, setExperimentRunMessageType] = useState(''); // 'success' | 'error'
    const [currentExperimentId, setCurrentExperimentId] = useState(null);
    const timerIntervalRef = useRef(null);
    // disable functionalities while experiment is running
    const [runningExperiment, setRunningExperiment] = useState(false);

    // when true all buttons are disabled until operation completes
    const [waitOperation, setWaitOperation] = useState(false);
    // experiment name list and selected experiment for create telemetry file and run
    const [experimentDefinitions, setExperimentDefinitions] = useState([]);
    const [selectedExperimentDefinitionTelemetry, setSelectedExperimentDefinitionTelemetry] = useState('');
    const [selectedExperimentDefinitionRun, setSelectedExperimentDefinitionRun] = useState('');

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

    // function for numeric input
    const handleNumericChange = (setter) => (e) => {
        const value = e.target.value;
        // only integers
        if (value === '' || /^\d+$/.test(value)) {
            setter(value);
        }
    };

    // ----------------------------------------------
    const allowedPlaybookExt = ['.yml', '.yaml'];

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
    // refresh experiment list
    const refreshExperiments = async () => {
          if (!reservation_id) return;

          try {
            const res = await fetch('http://localhost:5004/api/experimenter/showExperiments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reservation_id })
            });

            const data = await res.json();
            const exps = (data && data.success && Array.isArray(data.experiments)) ? data.experiments : [];

            setExperimentDefinitions(exps);

            // se il value selezionato non esiste più, resettalo
            if (selectedExperimentDefinitionTelemetry && !exps.some(e => e.filename === selectedExperimentDefinitionTelemetry)) {
              setSelectedExperimentDefinitionTelemetry('');
            }
            if (selectedExperimentDefinitionRun && !exps.some(e => e.filename === selectedExperimentDefinitionRun)) {
              setSelectedExperimentDefinitionRun('');
            }
          } catch (err) {
            console.error('Error fetching experiments:', err);
            setExperimentDefinitions([]);
            setSelectedExperimentDefinitionTelemetry('');
            setSelectedExperimentDefinitionRun('');
          }
    };

    useEffect(() => {
      refreshExperiments();
    }, [reservation_id]);

    // Free mode ---------------------------------------------------------------------------
    const handleFreePlaybookFiles = (e) => {
        const files = Array.from(e.target.files || []);

        const validFiles = files.filter(f => {
            const name = f.name.toLowerCase();
            return name.endsWith('.yml') || name.endsWith('.yaml');
        });

        setFreePlaybookFiles(prev => [...prev, ...validFiles]);
        e.target.value = null;

        // validation reset if it was a loaded template
        if (experimentDescription.file) {
            setTemplateValidation({ message: 'Playbooks changed - please reload template', type: 'error' });
            experimentDescription.reset();
        }
    };

    const removeFreePlaybookFile = (index) => {
        setFreePlaybookFiles(prev => prev.filter((_, i) => i !== index));
        // validation reset if it was a loaded template
        if (experimentDescription.file) {
            setTemplateValidation({ message: 'Playbooks changed - please reload template', type: 'error' });
            experimentDescription.reset();
        }
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

    const handleExperimentDescriptionChange = async (e) => {
        const f = e.target.files[0] || null;
        experimentDescription.onChange(e);

        if (!f) {
            setTemplateValidation({ message: '', type: '' });
            return;
        }

        const nameLower = f.name.toLowerCase();
        const isValid = ['.yml', '.yaml'].some(ext => nameLower.endsWith(ext));

        if (isValid) {
            await validateExperimentTemplate(f);
        } else {
            setTemplateValidation({ message: '', type: '' });
        }
    };

    const validateExperimentTemplate = async (templateFile) => {
        const formData = new FormData();
        formData.append('experiment_description', templateFile);
        formData.append('reservation_id', reservation_id);

        // add every selected playbook
        freePlaybookFiles.forEach(file => {
            formData.append('playbooks', file);
        });

        setWaitOperation(true);
        setTemplateValidation({ message: 'Validating...', type: '' });

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/validateTemplate', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (data.success) {
                setTemplateValidation({ message: 'valid', type: 'success' });
                 await refreshExperiments();
            } else {
                let errorMsg = 'Invalid format';
                if (data.error === 'missing_playbooks') {
                    errorMsg = `Missing playbooks: ${data.missing.join(', ')}`;
                } else if (data.details) {
                    errorMsg = data.details;
                }

                setTemplateValidation({ message: errorMsg, type: 'error' });
                // reset file if not valid
                experimentDescription.reset();
            }
        } catch (error) {
            console.error('Error validating template:', error);
            setTemplateValidation({ message: 'Validation error', type: 'error' });
            experimentDescription.reset();
        } finally {
            setWaitOperation(false);
        }
    };

    // Interactive mode -------------------------------------------------------------------------
    const handleCreateExperiment = async () => {
        // check each field is not empty
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

        // check for invalid files
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
                return;
            }

            const blob = await response.blob();
            const contentDisposition = response.headers.get('Content-Disposition');
            let filename = `res_${reservation_id}_exp_description.yml`; // fallback name

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

    // Guided mode -------------------------------------------------------------------------------
    const handleDeviceSelect = (device, type) => {
        if (type === 'client') {
            // deselect, if client selected
            if (iperfClients.includes(device)) {
                setIperfClients(prev => prev.filter(d => d !== device));
                //setIperfServers(prev => prev.filter(d => d !== device)); // remove from server
            } else {
                // select as client, remove from server
                setIperfClients(prev => [...prev, device]);
                //setIperfServers(prev => prev.filter(d => d !== device));
            }
        } else {
            // deselect, if server selected
            if (iperfServers.includes(device)) {
                setIperfServers(prev => prev.filter(d => d !== device));
                //setIperfClients(prev => prev.filter(d => d !== device)); // // remove from client
            } else {
                // // select as server, remove from  client
                setIperfServers(prev => [...prev, device]);
                //setIperfClients(prev => prev.filter(d => d !== device));
            }
        }
    };

    // iperf flows management
    const handleAddIperfFlow = (index) => {
        const newId = ++iperfFlowIdCounter.current;
        setIperfFlows(prev => {
            const copy = [...prev];
            copy.splice(index + 1, 0, {
                id: newId,
                client: '',
                server: '',
                bandwidth: '',
                protocol: 'tcp',
                //parallelStreams: '1',
                startOffset: '',
                duration: ''
            });
            return copy;
        });
    };

    const handleRemoveIperfFlow = (index) => {
        if (index === 0) return;
        setIperfFlows(prev => prev.filter((_, i) => i !== index));
    };

    const handleIperfFlowChange = (flowId, field, value) => {
        // numeric fields validation
        if (['bandwidth', 'startOffset', 'duration'/*, 'parallelStreams'*/].includes(field)) {
            if (value !== '' && !/^\d+$/.test(value)) return;
        }

        setIperfFlows(prev =>
            prev.map(flow =>
                flow.id === flowId ? { ...flow, [field]: value } : flow
            )
        );
    };

    // create iperf experiment
    const handleCreateIperfExperiment = async () => {
        if (!guidedExperimentName || !guidedExperimentName.trim()) {
            setGuidedMessage('Experiment name is required');
            setGuidedMessageType('error');
            return;
        }

        if (!guidedDuration || guidedDuration === '0') {
            setGuidedMessage('Experiment duration is required');
            setGuidedMessageType('error');
            return;
        }
        // at least one flow defined
        if (iperfFlows.length === 0) {
            setGuidedMessage('At least one traffic flow must be defined');
            setGuidedMessageType('error');
            return;
        }
        // each flow must have client and server
        const hasIncompleteFlows = iperfFlows.some(flow => !flow.client || !flow.server);
        if (hasIncompleteFlows) {
            setGuidedMessage('All flows must have client and server selected');
            setGuidedMessageType('error');
            return;
        }
        // client and server in a flow can't be in the same device
        const hasSelfLoopFlows = iperfFlows.some(flow => flow.client === flow.server);
        if (hasSelfLoopFlows) {
            setGuidedMessage('Client and server cannot be the same device in a flow');
            setGuidedMessageType('error');
            return;
        }
        // start offset cannot be greater than experiment duration
        const invalidTiming = iperfFlows.some(flow =>
        flow.startOffset && parseInt(flow.startOffset) >= parseInt(guidedDuration)
        );
        if (invalidTiming) {
            setGuidedMessage('Flow start time cannot exceed experiment duration');
            setGuidedMessageType('error');
            return;
        }

        setWaitOperation(true);
        try {
            const response = await fetch('http://localhost:5004/api/experimenter/createIperfExperiment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    experiment_name: guidedExperimentName.trim(),
                    duration: guidedDuration,
                    reservation_id: reservation_id,
                    flows: iperfFlows
                })
            });

            if (!response.ok) {
                console.error('Failed to create iperf experiment');
                setGuidedMessage('Failed to create experiment');
                setGuidedMessageType('error');
                return;
            }

            const blob = await response.blob();
            const contentDisposition = response.headers.get('Content-Disposition');
            let filename = 'iperf_experiment.yml'; // fallback name

            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (filenameMatch && filenameMatch[1]) {
                    filename = filenameMatch[1].replace(/['"]/g, '');
                }
            }

            createDownload(blob, filename);

            setGuidedMessage(filename);
            setGuidedMessageType('success');
            await refreshExperiments();
        } catch (error) {
            console.error('Error creating iperf experiment:', error);
            setGuidedMessage('Error creating experiment');
            setGuidedMessageType('error');
        } finally {
            setWaitOperation(false);
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

    const handleCreateTelemetryFile = async () => {
        setTelemetryCreateMessage('');
        setTelemetryCreateMessageType('');

        // at least one selected metric
        if (!selectedMetrics || selectedMetrics.length === 0) {
            setTelemetryCreateMessage('Error: select at least one metric');
            setTelemetryCreateMessageType('error');
            return;
        }

        // sampling validation
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

        // mandatory telemetry type
        if (!telemetryType || !telemetryType.trim()) {
            setTelemetryCreateMessage('Error: telemetry type is required');
            setTelemetryCreateMessageType('error');
            return;
        }

        // at least one experiment must exist and selected (Telemetry select)
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

        // retrieve experiment name from select telemetry
        const expName = experimentDefinitions.find(e => e.filename === selectedExperimentDefinitionTelemetry)?.label || selectedExperimentDefinitionTelemetry;
        const telemetryBaseName = `${expName}_telemetry`;

        // map telemetry type
        const telemetryTypeNum = telemetryType === 'Real time mode' ? 0 : 1;

        // create metrics list
        const metricsPayload = selectedMetrics.map((metricPath) => {
            if (samplingMode === 'global') {
                return {
                    name: metricPath,
                    sampling_period: parseInt(globalInterval, 10),
                    targets: globalDevices
                };
            }
            // per-metric
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

            // download YAML
            const blob = await res.blob();

            const contentDisposition = res.headers.get('Content-Disposition');
            let filename = `${telemetryBaseName}.yaml`;
            if (contentDisposition) {
                const m = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                if (m && m[1]) filename = m[1].replace(/['"]/g, '');
            }

            createDownload(blob, filename);
            //success message: "<selected_experiment_name>_telemetry created"
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
    // run section ----------------------------------------------
    // function to convert seconds in HH:MM:SS
    const formatTime = (totalSeconds) => {
        if (totalSeconds < 0) totalSeconds = 0;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    // useEffect to check status at the start
    useEffect(() => {
        const checkExperimentStatus = async () => {
            if (!reservation_id) return;

            try {
                const response = await fetch('http://localhost:5004/api/experimenter/getExperimentStatus', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reservation_id })
                });

                const data = await response.json();

                if (data.success && data.running) {
                    // there is a running experiment - update the timer
                    const expId = data.experiment_id;
                    const remainingSeconds = data.remaining_seconds;
                    setRunningExperiment(true);
                    setCurrentExperimentId(data.experiment_id);
                    setExperimentRunMessage(`Experiment "${data.experiment_name}" in progress`);
                    setExperimentRunMessageType('success');
                    setExperimentTimer(formatTime(remainingSeconds));

                    // start countdown
                    let timeLeft = remainingSeconds;
                    if (timerIntervalRef.current) {
                        clearInterval(timerIntervalRef.current);
                    }

                    timerIntervalRef.current = setInterval(async () => {
                        timeLeft -= 1;
                        if (timeLeft <= 0) {
                            clearInterval(timerIntervalRef.current);
                            setExperimentTimer('--:--:--');
                            setRunningExperiment(false);
                            setCurrentExperimentId(null);
                            setExperimentRunMessage(`Experiment "${data.experiment_name}" completed`);
                            setExperimentRunMessageType('success');
                            try {
                                await fetch('http://localhost:5004/api/experimenter/updateExperimentStatus', {
                                    method: 'POST',
                                    headers: {'Content-Type': 'application/json'},
                                    body: JSON.stringify({
                                        reservation_id: reservation_id,
                                        experiment_id: expId
                                    })
                                });
                                console.log('Experiment status updated to completed');
                            } catch (error) {
                                console.error('Error updating experiment status:', error);
                            }
                        } else {
                            setExperimentTimer(formatTime(timeLeft));
                        }
                    }, 1000);

                } else if (data.just_completed) {
                    // experiment ended
                    setCurrentExperimentId(null);
                    setExperimentRunMessage(`Experiment "${data.experiment_name}" completed`);
                    setExperimentRunMessageType('success');
                    setExperimentTimer('--:--:--');
                    setRunningExperiment(false);
                }

            } catch (error) {
                console.error('Error checking experiment status:', error);
            }
        };

        checkExperimentStatus();

        // cleanup
        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
        };
    }, [reservation_id]);

    // function to manage click on "Run experiment"
    const handleRunExperiment = async () => {
        setExperimentRunMessage('');
        setExperimentRunMessageType('');

        // check if there are no experiments or none of them is selected
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
        // find experiment name from the list
        const selectedExp = experimentDefinitions.find(e => e.filename === selectedExperimentDefinitionRun);
        const experimentName = selectedExp ? selectedExp.label : selectedExperimentDefinitionRun;

        setWaitOperation(true);

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/runExperiment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    experiment_name: experimentName,
                    reservation_id: reservation_id
                })
            });

            const data = await response.json();

            if (data.success) {
                // start timer with the received duration
                const expId = data.experiment_id;
                const durationSeconds = data.duration_s;
                setRunningExperiment(true);
                setCurrentExperimentId(data.experiment_id);
                setExperimentRunMessage(`Experiment "${experimentName}" started successfully`);
                setExperimentRunMessageType('success');

                // set remaining time
                let remainingTime = durationSeconds;
                setExperimentTimer(formatTime(remainingTime));

                // start countdown
                if (timerIntervalRef.current) {
                    clearInterval(timerIntervalRef.current);
                }

                timerIntervalRef.current = setInterval(async () => {
                    remainingTime -= 1;
                    if (remainingTime <= 0) {
                        clearInterval(timerIntervalRef.current);
                        setExperimentTimer('--:--:--');
                        setRunningExperiment(false);
                        setCurrentExperimentId(null);
                        setExperimentRunMessage(`Experiment "${experimentName}" completed`);
                        setExperimentRunMessageType('success');
                        try {
                            await fetch('http://localhost:5004/api/experimenter/updateExperimentStatus', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({
                                    reservation_id: reservation_id,
                                    experiment_id: expId
                                })
                            });
                            console.log('Experiment status updated to completed');
                        } catch (error) {
                            console.error('Error updating experiment status:', error);
                        }
                    } else {
                        setExperimentTimer(formatTime(remainingTime));
                    }
                }, 1000);

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

    // timer cleanup
    useEffect(() => {
        return () => {
            if (timerIntervalRef.current) {
                clearInterval(timerIntervalRef.current);
            }
        };
    }, []);

    const handleFinishExperiment = async () => {
        if (!currentExperimentId && !runningExperiment) {
            return;
        }

        setWaitOperation(true);

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/finishExperiment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id })
            });

            const data = await response.json();

            if (data.success) {
                // stop timer
                if (timerIntervalRef.current) {
                    clearInterval(timerIntervalRef.current);
                    timerIntervalRef.current = null;
                }

                // reset states
                setRunningExperiment(false);
                setCurrentExperimentId(null);
                setExperimentTimer('--:--:--');
                setExperimentRunMessage('Experiment finished and removed');
                setExperimentRunMessageType('success');

                // clear message after 3 seconds
                setTimeout(() => {
                    setExperimentRunMessage('');
                    setExperimentRunMessageType('');
                }, 3000);
            } else {
                setExperimentRunMessage(`Error: ${data.error || 'Failed to finish experiment'}`);
                setExperimentRunMessageType('error');
            }

        } catch (error) {
            console.error('Error finishing experiment:', error);
            setExperimentRunMessage('Error: network/server error');
            setExperimentRunMessageType('error');
        } finally {
            setWaitOperation(false);
        }
    };

    // ----------------------------------------------
    return (
        <div className="home-content-wrapper experiment-wrapper">
            <div className="card experiment-card">
                <h2 className="title">🧪 Setup and run experiment</h2>
                {/* Mode selector tabs */}
                <div className="mode-selector">
                    <button
                        className={`mode-tab ${selectedMode === 'free' ? 'active' : ''}`}
                        onClick={() => setSelectedMode('free')}
                        disabled={runningExperiment}
                    >
                        Free Mode
                    </button>
                    <button
                        className={`mode-tab ${selectedMode === 'interactive' ? 'active' : ''}`}
                        onClick={() => setSelectedMode('interactive')}
                        disabled={runningExperiment}
                    >
                        Interactive Mode
                    </button>
                    <button
                        className={`mode-tab ${selectedMode === 'guided' ? 'active' : ''}`}
                        onClick={() => setSelectedMode('guided')}
                        disabled={runningExperiment}
                    >
                        Guided Mode
                    </button>
                </div>

                {/* Free Mode Section */}
                {selectedMode === 'free' && (
                    <div className="experiment-section mode-content">
                        <div className="section-content">
                            <div className="config-row">
                                <label className="label-inline label-fixed-width">Download description template:</label>
                                <button type="button" className="template-button configuration-button"
                                        onClick={downloadTemplate} disabled={runningExperiment || waitOperation}>Download
                                </button>
                                <label className="label-inline label-fixed-width additional-margin">Load experiment description:</label>
                                <button type="button" className="template-button configuration-button choose-button"
                                        onClick={experimentDescription.choose} disabled={runningExperiment || waitOperation}>Choose
                                    description
                                </button>
                                <input ref={experimentDescription.ref} type="file" style={{display: 'none'}}
                                       onChange={handleExperimentDescriptionChange}
                                       disabled={runningExperiment}/>

                                {(experimentDescription.fileName || templateValidation.message) && (
                                    <div className={`validation-message ${
                                        experimentDescription.fileType === 'valid' && templateValidation.type === 'success' 
                                            ? 'success' 
                                            : experimentDescription.fileType === 'invalid' || templateValidation.type === 'error' 
                                                ? 'error' 
                                                : ''
                                    } additional-margin`}>
                                        {experimentDescription.fileType === 'valid' && templateValidation.type === 'success'
                                            ? `✓ ${experimentDescription.fileName} ${templateValidation.message}`
                                            : experimentDescription.fileType === 'invalid'
                                                ? `${experimentDescription.fileName} invalid format`
                                                : templateValidation.message
                                        }
                                    </div>
                                )}

                            </div>

                            <div className="config-row">
                                <label className="label-inline label-fixed-width">Load playbooks:</label>
                                <button type="button" className="playbook-button configuration-button choose-button"
                                        onClick={chooseFreePlaybooks} disabled={runningExperiment || waitOperation}>Choose playbooks
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
                                                    disabled={runningExperiment || waitOperation}
                                                >×</button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}
                {/* Interactive Mode Section */}
                {selectedMode === 'interactive' && (
                    <div className="experiment-section mode-content">
                        <div className="section-content">
                            <div className="config-row">
                                <label className="label-inline label-fixed-width label-output">Insert experiment
                                    name:</label>
                                <input
                                    type="text"
                                    className="duration-field"
                                    value={experimentName}
                                    onChange={(e) => setExperimentName(e.target.value)}
                                    readOnly={runningExperiment}
                                    placeholder="e.g., My Experiment"
                                />
                            </div>
                            <div className="config-row">
                                {/* Experiment duration line */}
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
                )}
                {/* Guided Mode Section */}
                {selectedMode === 'guided' && (
                    <div className="experiment-section mode-content">
                        <div className="section-content">
                            <div className="config-row">
                                <label className="label-inline label-fixed-width">Experiment name:</label>
                                <input
                                    type="text"
                                    className="duration-field"
                                    value={guidedExperimentName}
                                    onChange={(e) => setGuidedExperimentName(e.target.value)}
                                    readOnly={runningExperiment}
                                    placeholder="e.g., Iperf Test"
                                />
                            </div>
                            <div className="config-row">
                                <label className="label-inline label-fixed-width">Experiment duration (seconds):</label>
                                <input
                                    type="text"
                                    className="duration-field"
                                    value={guidedDuration}
                                    onChange={handleNumericChange(setGuidedDuration)}
                                    readOnly={runningExperiment}
                                />
                                <button
                                    type="button"
                                    className="send-button experiment-button additional-margin"
                                    onClick={handleCreateIperfExperiment}
                                    disabled={runningExperiment || waitOperation}
                                >
                                    Create iperf experiment
                                </button>
                                <div className={`experiment-created-message ${guidedMessageType}`}>
                                    {guidedMessage}
                                </div>
                            </div>

                            <div className="config-row guided-row">
                                <label className="label-inline label-fixed-width">Select iperf roles:</label>

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
                            <div className="config-row">
                                <label className="label-inline label-fixed-width">Define traffic flows:</label>
                            </div>

                            {iperfFlows.map((flow, idx) => (
                                <div key={flow.id} className="config-row config-row-nowrap iperf-flow-container">
                                    {/* Client dropdown */}
                                    <label className="label-inline label-flow">Client:</label>
                                    <select
                                        className={`flow-select ${flow.client && flow.server === flow.client ? 'flow-select-error' : ''}`}
                                        value={flow.client}
                                        onChange={(e) => handleIperfFlowChange(flow.id, 'client', e.target.value)}
                                        disabled={runningExperiment}
                                    >
                                        <option value="">Select</option>
                                        {iperfClients.map(client => (
                                            <option key={client} value={client} disabled={client === flow.server}>{client}{client === flow.server? ' (same as server' : ''}</option>
                                        ))}
                                    </select>

                                    <span className="flow-arrow">→</span>

                                    {/* Server dropdown */}
                                    <label className="label-inline label-flow">Server:</label>
                                    <select
                                        className={`flow-select ${flow.client && flow.server === flow.client ? 'flow-select-error' : ''}`}
                                        value={flow.server}
                                        onChange={(e) => handleIperfFlowChange(flow.id, 'server', e.target.value)}
                                        disabled={runningExperiment}
                                    >
                                        <option value="">Select</option>
                                        {iperfServers.map(server => (
                                            <option key={server} value={server} disabled={server === flow.client}>{server}{server === flow.client ? ' (same as client)' : ''}</option>
                                        ))}
                                    </select>

                                    {/* Bandwidth */}
                                    <label className="label-inline label-flow">BW(Mbps):</label>
                                    <input
                                        type="text"
                                        className="flow-field"
                                        value={flow.bandwidth}
                                        onChange={(e) => handleIperfFlowChange(flow.id, 'bandwidth', e.target.value)}
                                        placeholder="1000"
                                        disabled={runningExperiment}
                                    />

                                    {/* Protocol */}
                                    <label className="label-inline label-flow">Protocol:</label>
                                    <select
                                        className="flow-select-short"
                                        value={flow.protocol}
                                        onChange={(e) => handleIperfFlowChange(flow.id, 'protocol', e.target.value)}
                                        disabled={runningExperiment}
                                    >
                                        <option value="tcp">TCP</option>
                                        <option value="udp">UDP</option>
                                    </select>

                                    {/* Start offset */}
                                    <label className="label-inline label-flow">Start(s):</label>
                                    <input
                                        type="text"
                                        className="flow-field"
                                        value={flow.startOffset}
                                        onChange={(e) => handleIperfFlowChange(flow.id, 'startOffset', e.target.value)}
                                         placeholder="5"
                                        disabled={runningExperiment}
                                    />

                                    {/* Duration */}
                                    <label className="label-inline label-flow">Duration(s):</label>
                                    <input
                                        type="text"
                                        className="flow-field"
                                        value={flow.duration}
                                        onChange={(e) => handleIperfFlowChange(flow.id, 'duration', e.target.value)}
                                        placeholder="Auto"
                                        disabled={runningExperiment}
                                    />

                                    {/* + and - buttons*/}
                                    <label
                                        className="label-inline add-remove-label"
                                        onClick={() => handleAddIperfFlow(idx)}
                                        style={{ pointerEvents: runningExperiment ? 'none' : 'auto' }}
                                    >+</label>
                                    <label
                                        className="label-inline add-remove-label"
                                        onClick={() => handleRemoveIperfFlow(idx)}
                                        style={{
                                            opacity: idx === 0 ? 0.3 : 1,
                                            pointerEvents: (idx === 0 || runningExperiment) ? 'none' : 'auto'
                                        }}
                                    >-</label>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
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

                <div className="experiment-section experiment-controls">
                    {/* Experiment time left row */}
                    <div className="config-row config-row-space-between">
                        <div className="time-left-group">
                            <label className="label-inline label-fixed-width">Experiment time left:</label>
                            <label className="label-inline time-display">{experimentTimer}</label>
                        </div>
                        {/* Experiment buttons */}
                        <div className="experiment-buttons">
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
                            <button type="button" className="start-button configuration-button"
                                    onClick={handleRunExperiment}
                                    disabled={runningExperiment || waitOperation || currentExperimentId !== null}>Run experiment
                            </button>
                            <button
                                type="button"
                                className="delete-button delete configuration-button"
                                onClick={handleFinishExperiment}
                                disabled={(!runningExperiment && !currentExperimentId) || waitOperation}
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
            </div>
        </div>
    );
}