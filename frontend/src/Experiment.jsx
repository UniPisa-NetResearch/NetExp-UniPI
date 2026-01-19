// Experiment.jsx
import React, {useState, useRef, useEffect} from 'react';
import './style/style.css';
import './style/experiment.css';
import FreeMode from './Experiment/FreeMode';
import InteractiveMode from './Experiment/InteractiveMode';
import GuidedMode from './Experiment/GuidedMode';
import TelemetrySection from './Experiment/TelemetrySection';
import ExperimentControls from './Experiment/ExperimentControls';

export default function Experiment({username, reservation_id}) {
    // Utility function for file input management
    function useFileInput(allowedExt = []) {
        const ref = useRef(null);
        const [file, setFile] = useState(null);
        const [fileType, setFileType] = useState('');
        const choose = () => ref.current && ref.current.click();

        const onChange = (e) => {
            const f = e.target.files[0] || null;
            setFile(f);
            if (!f) {
              setFileType('');
              return;
            }
            const nameLower = f.name.toLowerCase();
            const isValid = allowedExt.some(ext => nameLower.endsWith(ext));
            setFileType(isValid ? 'valid' : 'invalid');
            e.target.value = null;
        };
        const reset = () => {
            setFile(null);
            setFileType('');
        }
        return { ref, file, fileType, choose, onChange, fileName: file ? file.name : '', reset };
    }

    // Utility function for file download
    function createDownload(blob, filename){
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }

    // Shared states
    const [selectedMode, setSelectedMode] = useState('free');                    // experiment mode
    const [waitOperation, setWaitOperation] = useState(false);                 // wait for completion of an operation
    const [runningExperiment, setRunningExperiment] = useState(false);        // experiment in execution
    const [deviceList, setDeviceList] = useState([]);                          // list of devices
    const [experimentDefinitions, setExperimentDefinitions] = useState([]);   // list of experiment definition names

    // Free mode states
    const experimentDescription = useFileInput(['.yml', '.yaml']);            // loaded experiment description
    const [freePlaybookFiles, setFreePlaybookFiles] = useState([]);         // list of inserted playbooks
    const freeModeFileRef = useRef(null);
    const [templateValidation, setTemplateValidation] = useState({ message: '', type: '' });

    // Interactive mode states
    const [experimentName, setExperimentName] = useState('');
    const [experimentDuration, setExperimentDuration] = useState('');
    const [experimentMessage, setExperimentMessage] = useState('');             // message of the operation
    const [experimentMessageType, setExperimentMessageType] = useState('');     // message type
    const idCounter = useRef(1);
    const [playbookRows, setPlaybookRows] = useState([
      { id: 1, executionTime: '', file: null, fileName: '', fileType: '', selectedDevices: [] }
    ]);
    const [yamlUploadMessage, setYamlUploadMessage] = useState('');
    const [yamlUploadMessageType, setYamlUploadMessageType] = useState('');

    // Guided mode states
    const [guidedDuration, setGuidedDuration] = useState('');               // experiment duration
    const [guidedExperimentName, setGuidedExperimentName] = useState('');  // exp name
    const [guidedMessage, setGuidedMessage] = useState('');               // message of the operation
    const [guidedMessageType, setGuidedMessageType] = useState('');
    const [iperfClients, setIperfClients] = useState([]);                // list of selected clients
    const [iperfServers, setIperfServers] = useState([]);               // list of selected servers
    const iperfFlowIdCounter = useRef(1);
    const [iperfFlows, setIperfFlows] = useState([
        {id: 1, client: '', server: '', bandwidth: '', protocol: 'tcp', startOffset: '', duration: ''}
    ]);
    const [yamlUploadMessageGuided, setYamlUploadMessageGuided] = useState('');
    const [yamlUploadMessageTypeGuided, setYamlUploadMessageTypeGuided] = useState('');

    // Telemetry states
    const [predefinedMetrics, setPredefinedMetrics] = useState([]);         // list of predefined metrics
    const [customMetrics, setCustomMetrics] = useState([]);                 // list of custom metrics
    const [selectedMetrics, setSelectedMetrics] = useState([]);             // list of selected metrics
    const metricIdCounter = useRef(1);
    const [metricRows, setMetricRows] = useState([
      { id: 1, path: '', status: '', message: '' }
    ]);
    const [samplingMode, setSamplingMode] = useState('global');         // mode of sampling
    const [globalInterval, setGlobalInterval] = useState('5');          // global interval value
    //const [metricIntervals, setMetricIntervals] = useState({});            // list of per-metric intervals
    const [globalDevices, setGlobalDevices] = useState([]);             // global devices list
    //const [metricDevices, setMetricDevices] = useState({});               // list of devices per each metric
    const [telemetryType, setTelemetryType] = useState('');            // type of telemetry
    const [metricConfigurations, setMetricConfigurations] = useState([]);
    const [selectedExperimentDefinitionTelemetry, setSelectedExperimentDefinitionTelemetry] = useState('');     // list of experiment names
    const [telemetryCreateMessage, setTelemetryCreateMessage] = useState('');               // message of the metrics button
    const [telemetryCreateMessageType, setTelemetryCreateMessageType] = useState('');
    const [validatingMetrics, setValidatingMetrics] = useState(false);                    // true if some metrics are under validation
    const [yamlUploadMessageTelemetry, setYamlUploadMessageTelemetry] = useState('');
    const [yamlUploadMessageTypeTelemetry, setYamlUploadMessageTypeTelemetry] = useState('');

    // Experiment controls states
    const [experimentTimer, setExperimentTimer] = useState('--:--:--');                 // timer
    const [experimentRunMessage, setExperimentRunMessage] = useState('');               // message of experiment run
    const [experimentRunMessageType, setExperimentRunMessageType] = useState('');
    const [currentExperimentId, setCurrentExperimentId] = useState(null);                                 // id of the current experiment
    const [selectedExperimentDefinitionRun, setSelectedExperimentDefinitionRun] = useState('');   // list of experiments on exp controls section
    const timerIntervalRef = useRef(null);

    // Batch experiment states
    const [batchMode, setBatchMode] = useState(false);                      // true = batch, false = single
    const [selectedExperiments, setSelectedExperiments] = useState([]);      // array of {filename, order}
    const [batchTotalDuration, setBatchTotalDuration] = useState(0);       // total duration
    // Load devices on mount
    useEffect(() => {
        const fetchDevices = async () => {
            try {
                const response = await fetch('http://localhost:5004/api/experimenter/getDevices', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ reservation_id })
                });

                if (!response.ok) {
                    console.error('Failed to fetch devices');
                    return;
                }

                const data = await response.json();
                setDeviceList(data.devices || []);                  // set the list of received devices
            } catch (error) {
                console.error('Error fetching devices:', error);
            }
        };

        fetchDevices();
    }, [reservation_id]);

    // Load metrics on mount
    useEffect(() => {
        const fetchMetrics = async () => {
            try {
                const predefinedResponse = await fetch('/assets/metrics.json');
                if (predefinedResponse.ok) {
                    const predefinedData = await predefinedResponse.json();
                    setPredefinedMetrics(predefinedData.predefined_metrics || []);      // read and set predefined metrics from file
                } else {
                    console.error('Failed to load predefined metrics');
                }

                const customResponse = await fetch('http://localhost:5004/api/experimenter/getUserMetrics', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username })
                });

                if (customResponse.ok) {
                    const customData = await customResponse.json();
                    setCustomMetrics(customData.custom || []);          // set custom metrics for user
                } else {
                    console.error('Failed to fetch custom metrics');
                }

            } catch (error) {
                console.error('Error loading metrics:', error);
            }
        };

        fetchMetrics();
    }, [username]);

    // Refresh experiment names list
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

    // Calculate non-host devices
    const nonHostDevices = deviceList.filter(device =>
        device.role && device.role.toLowerCase() !== 'host'
    ).sort((a, b) => a.name.localeCompare(b.name));

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

                {/* Free Mode */}
                {selectedMode === 'free' && (
                    <FreeMode
                        experimentDescription={experimentDescription}
                        freePlaybookFiles={freePlaybookFiles}
                        setFreePlaybookFiles={setFreePlaybookFiles}
                        freeModeFileRef={freeModeFileRef}
                        templateValidation={templateValidation}
                        setTemplateValidation={setTemplateValidation}
                        runningExperiment={runningExperiment}
                        waitOperation={waitOperation}
                        setWaitOperation={setWaitOperation}
                        reservation_id={reservation_id}
                        refreshExperiments={refreshExperiments}
                        createDownload={createDownload}
                    />
                )}

                {/* Interactive Mode */}
                {selectedMode === 'interactive' && (
                    <InteractiveMode
                        experimentName={experimentName}
                        setExperimentName={setExperimentName}
                        experimentDuration={experimentDuration}
                        setExperimentDuration={setExperimentDuration}
                        experimentMessage={experimentMessage}
                        setExperimentMessage={setExperimentMessage}
                        experimentMessageType={experimentMessageType}
                        setExperimentMessageType={setExperimentMessageType}
                        playbookRows={playbookRows}
                        setPlaybookRows={setPlaybookRows}
                        deviceList={deviceList}
                        runningExperiment={runningExperiment}
                        setWaitOperation={setWaitOperation}
                        reservation_id={reservation_id}
                        refreshExperiments={refreshExperiments}
                        createDownload={createDownload}
                        idCounter={idCounter}
                        yamlUploadMessage={yamlUploadMessage}
                        yamlUploadMessageType={yamlUploadMessageType}
                        setYamlUploadMessage={setYamlUploadMessage}
                        setYamlUploadMessageType={setYamlUploadMessageType}
                    />
                )}

                {/* Guided Mode */}
                {selectedMode === 'guided' && (
                    <GuidedMode
                        guidedExperimentName={guidedExperimentName}
                        setGuidedExperimentName={setGuidedExperimentName}
                        guidedDuration={guidedDuration}
                        setGuidedDuration={setGuidedDuration}
                        guidedMessage={guidedMessage}
                        setGuidedMessage={setGuidedMessage}
                        guidedMessageType={guidedMessageType}
                        setGuidedMessageType={setGuidedMessageType}
                        deviceList={deviceList}
                        iperfClients={iperfClients}
                        setIperfClients={setIperfClients}
                        iperfServers={iperfServers}
                        setIperfServers={setIperfServers}
                        iperfFlows={iperfFlows}
                        setIperfFlows={setIperfFlows}
                        runningExperiment={runningExperiment}
                        waitOperation={waitOperation}
                        setWaitOperation={setWaitOperation}
                        reservation_id={reservation_id}
                        refreshExperiments={refreshExperiments}
                        createDownload={createDownload}
                        iperfFlowIdCounter={iperfFlowIdCounter}
                        yamlUploadMessageGuided={yamlUploadMessageGuided}
                        yamlUploadMessageTypeGuided={yamlUploadMessageTypeGuided}
                        setYamlUploadMessageGuided={setYamlUploadMessageGuided}
                        setYamlUploadMessageTypeGuided={setYamlUploadMessageTypeGuided}
                    />
                )}

                {/* Telemetry Section */}
                <TelemetrySection
                    predefinedMetrics={predefinedMetrics}
                    customMetrics={customMetrics}
                    setCustomMetrics={setCustomMetrics}
                    selectedMetrics={selectedMetrics}
                    setSelectedMetrics={setSelectedMetrics}
                    metricRows={metricRows}
                    setMetricRows={setMetricRows}
                    samplingMode={samplingMode}
                    setSamplingMode={setSamplingMode}
                    globalInterval={globalInterval}
                    setGlobalInterval={setGlobalInterval}
                    globalDevices={globalDevices}
                    setGlobalDevices={setGlobalDevices}
                    nonHostDevices={nonHostDevices}
                    telemetryType={telemetryType}
                    setTelemetryType={setTelemetryType}
                    experimentDefinitions={experimentDefinitions}
                    selectedExperimentDefinitionTelemetry={selectedExperimentDefinitionTelemetry}
                    setSelectedExperimentDefinitionTelemetry={setSelectedExperimentDefinitionTelemetry}
                    telemetryCreateMessage={telemetryCreateMessage}
                    setTelemetryCreateMessage={setTelemetryCreateMessage}
                    telemetryCreateMessageType={telemetryCreateMessageType}
                    setTelemetryCreateMessageType={setTelemetryCreateMessageType}
                    runningExperiment={runningExperiment}
                    validatingMetrics={validatingMetrics}
                    setValidatingMetrics={setValidatingMetrics}
                    waitOperation={waitOperation}
                    setWaitOperation={setWaitOperation}
                    username={username}
                    reservation_id={reservation_id}
                    deviceList={deviceList}
                    createDownload={createDownload}
                    metricIdCounter={metricIdCounter}
                    metricConfigurations={metricConfigurations}
                    setMetricConfigurations={ setMetricConfigurations}
                    yamlUploadMessageTelemetry={yamlUploadMessageTelemetry}
                    yamlUploadMessageTypeTelemetry={yamlUploadMessageTypeTelemetry}
                    setYamlUploadMessageTelemetry={setYamlUploadMessageTelemetry}
                    setYamlUploadMessageTypeTelemetry={setYamlUploadMessageTypeTelemetry}
                />

                {/* Experiment Controls */}
                <ExperimentControls
                    experimentTimer={experimentTimer}
                    setExperimentTimer={setExperimentTimer}
                    experimentDefinitions={experimentDefinitions}
                    selectedExperimentDefinitionRun={selectedExperimentDefinitionRun}
                    setSelectedExperimentDefinitionRun={setSelectedExperimentDefinitionRun}
                    experimentRunMessage={experimentRunMessage}
                    setExperimentRunMessage={setExperimentRunMessage}
                    experimentRunMessageType={experimentRunMessageType}
                    setExperimentRunMessageType={setExperimentRunMessageType}
                    runningExperiment={runningExperiment}
                    setRunningExperiment={setRunningExperiment}
                    waitOperation={waitOperation}
                    setWaitOperation={setWaitOperation}
                    currentExperimentId={currentExperimentId}
                    setCurrentExperimentId={setCurrentExperimentId}
                    reservation_id={reservation_id}
                    timerIntervalRef={timerIntervalRef}
                    batchMode={batchMode}
                    setBatchMode={setBatchMode}
                    selectedExperiments={selectedExperiments}
                    setSelectedExperiments={setSelectedExperiments}
                    batchTotalDuration={batchTotalDuration}
                    setBatchTotalDuration={setBatchTotalDuration}
                />
            </div>
        </div>
    );
}