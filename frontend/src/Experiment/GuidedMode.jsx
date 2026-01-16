// GuidedMode.jsx
import React, {useRef} from 'react';
import jsyaml from 'js-yaml';

export default function GuidedMode({
    guidedExperimentName,
    setGuidedExperimentName,
    guidedDuration,
    setGuidedDuration,
    guidedMessage,
    setGuidedMessage,
    guidedMessageType,
    setGuidedMessageType,
    deviceList,
    iperfClients,
    setIperfClients,
    iperfServers,
    setIperfServers,
    iperfFlows,
    setIperfFlows,
    runningExperiment,
    waitOperation,
    setWaitOperation,
    reservation_id,
    refreshExperiments,
    createDownload,
    iperfFlowIdCounter,
    yamlUploadMessageGuided,
    yamlUploadMessageTypeGuided,
    setYamlUploadMessageGuided,
    setYamlUploadMessageTypeGuided
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

                // validate required fields for iperf experiment
                if (!parsed.experiment_id || !parsed.duration_s || !parsed.iperf_flows) {
                  setYamlUploadMessageGuided('Invalid YAML format: required fields are experiment_id, duration_s, iperf_flows');
                  setYamlUploadMessageTypeGuided('error');
                  return;
                }

                if (!Array.isArray(parsed.iperf_flows) || parsed.iperf_flows.length === 0) {
                  setYamlUploadMessageGuided('Invalid YAML format: iperf_flows must be a non-empty array');
                  setYamlUploadMessageTypeGuided('error');
                  return;
                }

                // validate numeric fields
                if (isNaN(parsed.duration_s) || parsed.duration_s <= 0) {
                    setYamlUploadMessageGuided('Invalid YAML format: duration_s must be a positive number');
                    setYamlUploadMessageTypeGuided('error');
                    return;
               }

               // validate iperf_flows numeric fields
               for (const flow of parsed.iperf_flows) {
                   if (flow.port && (isNaN(flow.port) || flow.port < 1024 || flow.port > 65535)) {
                       setYamlUploadMessageGuided('Invalid YAML format: port must be between 1024 and 65535');
                       setYamlUploadMessageTypeGuided('error');
                       return;
                   }
                   if ((flow.bandwidth_mbps && isNaN(flow.bandwidth_mbps)) || flow.bandwidth_mbps <= 0) {
                       setYamlUploadMessageGuided('Invalid YAML format: bandwidth_mbps must be a number > 0');
                       setYamlUploadMessageTypeGuided('error');
                       return;
                   }
                   if ((flow.start_offset_s !== undefined && isNaN(flow.start_offset_s)) || flow.start_offset_s < 0) {
                       setYamlUploadMessageGuided('Invalid YAML format: start_offset_s must be a positive number');
                       setYamlUploadMessageTypeGuided('error');
                       return;
                   }
                   if ((flow.duration_s && isNaN(flow.duration_s)) || flow.duration_s <= 0) {
                       setYamlUploadMessageGuided('Invalid YAML format: duration_s in flow must be a number > 0');
                       setYamlUploadMessageTypeGuided('error');
                       return;
                   }
               }

                // populate experiment name and duration
                setGuidedExperimentName(parsed.experiment_id);
                setGuidedDuration(String(parsed.duration_s));

                // create a set of valid device names for quick lookup
                const validDeviceNames = new Set(deviceList.map(d => d.name));

                // populate iperf flows
                const newFlows = parsed.iperf_flows.map((flow, index) => {
                  const newId = ++iperfFlowIdCounter.current;
                  const client = flow.client || '';
                  const server = flow.server || '';

                  return {
                    id: newId,
                    client: validDeviceNames.has(client) ? client : '',
                    server: validDeviceNames.has(server) ? server : '',
                    serverIp: flow.server_ip || '',
                    port: flow.port || 5201,
                    bandwidth: flow.bandwidth_mbps ? flow.bandwidth_mbps : '',
                    protocol: flow.protocol || 'tcp',
                    startOffset: flow.start_offset_s !== undefined ? flow.start_offset_s : '',
                    duration: flow.duration_s ? flow.duration_s : ''
                  };
                });

                setIperfFlows(newFlows);

                // extract unique clients and servers, filtering valid servers and clients
                const allClients = [...new Set(parsed.iperf_flows.map(f => f.client).filter(Boolean))];
                const allServers = [...new Set(parsed.iperf_flows.map(f => f.server).filter(Boolean))];
                const clients = allClients.filter(c => validDeviceNames.has(c));
                const servers = allServers.filter(s => validDeviceNames.has(s));

                setIperfClients(clients);
                setIperfServers(servers);

                setYamlUploadMessageGuided('YAML loaded successfully');
                setYamlUploadMessageTypeGuided('success');

            } catch (error) {
                console.error('Error parsing YAML:', error);
                setYamlUploadMessageGuided(`Invalid YAML format: ${error.message}`);
                setYamlUploadMessageTypeGuided('error');
            }
        };

        reader.readAsText(file);
        e.target.value = null; // reset input
    };

    // experiment duration handler
    const handleNumericChange = (setter) => (e) => {
        const value = e.target.value;
        if (value === '' || /^\d+$/.test(value)) {
            setter(value);
        }
    };
    // function for iperf client/server selection
    const handleDeviceSelect = (device, type) => {
        if (type === 'client') {
            if (iperfClients.includes(device)) {
                setIperfClients(prev => prev.filter(d => d !== device));
            } else {
                setIperfClients(prev => [...prev, device]);
            }
        } else {
            if (iperfServers.includes(device)) {
                setIperfServers(prev => prev.filter(d => d !== device));
            } else {
                setIperfServers(prev => [...prev, device]);
            }
        }
    };
    // add new iperf flow
    const handleAddIperfFlow = (index) => {
        const newId = ++iperfFlowIdCounter.current;
        setIperfFlows(prev => {
            const copy = [...prev];
            copy.splice(index + 1, 0, {
                id: newId,
                client: '',
                server: '',
                serverIp: '',
                port: 5201,
                bandwidth: '',
                protocol: 'tcp',
                startOffset: '',
                duration: ''
            });
            return copy;
        });
    };
    // remove iperf flow
    const handleRemoveIperfFlow = (index) => {
        if (index === 0) return;
        setIperfFlows(prev => prev.filter((_, i) => i !== index));
    };
    // change of flow handler
    const handleIperfFlowChange = (flowId, field, value) => {
        if (['bandwidth', 'startOffset', 'duration'].includes(field)) {
            if (value !== '' && !/^\d+$/.test(value)) return;
        }

        if (field === 'port') {
            value = value === '' ? '' : parseInt(value);
        }

        setIperfFlows(prev =>
            prev.map(flow =>
                flow.id === flowId ? { ...flow, [field]: value } : flow
            )
        );
    };
    // create iperf experiment description
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

        if (iperfFlows.length === 0) {
            setGuidedMessage('At least one traffic flow must be defined');
            setGuidedMessageType('error');
            return;
        }

        const hasIncompleteFlows = iperfFlows.some(flow => !flow.client || !flow.server);
        if (hasIncompleteFlows) {
            setGuidedMessage('All flows must have client and server selected');
            setGuidedMessageType('error');
            return;
        }

        const hasSelfLoopFlows = iperfFlows.some(flow => flow.client === flow.server);
        if (hasSelfLoopFlows) {
            setGuidedMessage('Client and server cannot be the same device in a flow');
            setGuidedMessageType('error');
            return;
        }

        const hasEmptyServerIp = iperfFlows.some(flow => !flow.serverIp || !flow.serverIp.trim());
        if (hasEmptyServerIp) {
            setGuidedMessage('All flows must have server IP address specified');
            setGuidedMessageType('error');
            return;
        }

        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        const hasInvalidIp = iperfFlows.some(flow => !ipRegex.test(flow.serverIp));
        if (hasInvalidIp) {
            setGuidedMessage('Invalid IP address format in one or more flows');
            setGuidedMessageType('error');
            return;
        }

        const hasInvalidPort = iperfFlows.some(flow =>
            !flow.port || flow.port < 1024 || flow.port > 65535
        );
        if (hasInvalidPort) {
            setGuidedMessage('Port must be between 1024 and 65535');
            setGuidedMessageType('error');
            return;
        }

        const portBindings = {};
        for (const flow of iperfFlows) {
            const key = `${flow.server}:${flow.serverIp}:${flow.port}`;
            if (portBindings[key]) {
                setGuidedMessage(`Port conflict: ${flow.server} on ${flow.serverIp}:${flow.port} is used by multiple flows`);
                setGuidedMessageType('error');
                return;
            }
            portBindings[key] = true;
        }

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
            let filename = 'iperf_experiment.yml';

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

    return (
        <div className="experiment-section mode-content">
            <div className="section-content">
                <div className="config-row">
                    <label className="label-inline label-fixed-width">Load experiment from YAML template:</label>
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
                        title="Upload iperf experiment YAML file"
                    >
                        Upload template
                    </button>
                    {yamlUploadMessageGuided && (
                        <span className={`message-inline ${yamlUploadMessageTypeGuided === 'error' ? 'error-validation' : 'success-validation'}`}>
                            {yamlUploadMessageGuided}
                        </span>
                    )}
                </div>
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
                        <div className="field-group">
                            <label className="label-inline label-flow">Client:</label>
                            <select
                                className={`flow-select ${flow.client && flow.server === flow.client ? 'flow-select-error' : ''}`}
                                value={flow.client}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'client', e.target.value)}
                                disabled={runningExperiment}
                            >
                                <option value="">Select</option>
                                {iperfClients.map(client => (
                                    <option key={client} value={client}
                                            disabled={client === flow.server}>{client}{client === flow.server ? ' (same as server' : ''}</option>
                                ))}
                            </select>
                        </div>
                        <span className="flow-arrow">→</span>
                        <div className="field-group">
                            <label className="label-inline label-flow">Server:</label>
                            <select
                                className={`flow-select ${flow.client && flow.server === flow.client ? 'flow-select-error' : ''}`}
                                value={flow.server}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'server', e.target.value)}
                                disabled={runningExperiment}
                            >
                                <option value="">Select</option>
                                {iperfServers.map(server => (
                                    <option key={server} value={server}
                                            disabled={server === flow.client}>{server}{server === flow.client ? ' (same as client)' : ''}</option>
                                ))}
                            </select>
                        </div>
                        <div className="field-group">
                            <label className="label-inline label-flow">Server IP:</label>
                            <input
                                type="text"
                                className="flow-field flow-field-ip"
                                value={flow.serverIp}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'serverIp', e.target.value)}
                                placeholder="10.0.1.1"
                                disabled={runningExperiment}
                                style={{width: '110px'}}
                            />
                        </div>
                        <div className="field-group">
                            <label className="label-inline label-flow">Port:</label>
                            <input
                                type="number"
                                className="flow-field"
                                value={flow.port}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'port', e.target.value)}
                                min="1024"
                                max="65535"
                                disabled={runningExperiment}
                                style={{width: '70px'}}
                            />
                        </div>
                        <div className="field-group">
                            <label className="label-inline label-flow">BW(Mbps):</label>
                            <input
                                type="text"
                                className="flow-field"
                                value={flow.bandwidth}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'bandwidth', e.target.value)}
                                placeholder="1000"
                                disabled={runningExperiment}
                            />
                        </div>
                        <div className="field-group">
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
                        </div>
                        <div className="field-group">
                            <label className="label-inline label-flow">Start(s):</label>
                            <input
                                type="text"
                                className="flow-field"
                                value={flow.startOffset}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'startOffset', e.target.value)}
                                placeholder="5"
                                disabled={runningExperiment}
                            />
                        </div>
                        <div className="field-group">
                            <label className="label-inline label-flow">Duration(s):</label>
                            <input
                                type="text"
                                className="flow-field"
                                value={flow.duration}
                                onChange={(e) => handleIperfFlowChange(flow.id, 'duration', e.target.value)}
                                placeholder="Auto"
                                disabled={runningExperiment}
                            />
                        </div>

                        <label
                            className="label-inline add-remove-label"
                            onClick={() => handleAddIperfFlow(idx)}
                            style={{pointerEvents: runningExperiment ? 'none' : 'auto'}}
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
    );
}