// Evaluation.jsx
import React, { useState, useEffect } from 'react';
import './style/style.css';
import './style/evaluation.css';

export default function Evaluation({ username, reservation_id }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [experimentData, setExperimentData] = useState(null);
    const [selectedMetric, setSelectedMetric] = useState('');
    const [selectedDevice, setSelectedDevice] = useState('');

    useEffect(() => {
        loadExperimentResults();
    }, [reservation_id]);

    const loadExperimentResults = async () => {
        setLoading(true);
        setError('');

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/getExperimentResults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id })
            });

            const data = await response.json();

            if (data.success) {
                setExperimentData(data);

                // Imposta la prima metrica e il primo device come default
                if (data.telemetry_results) {
                    const metrics = Object.keys(data.telemetry_results);
                    if (metrics.length > 0) {
                        setSelectedMetric(metrics[0]);
                        const devices = Object.keys(data.telemetry_results[metrics[0]]);
                        if (devices.length > 0) {
                            setSelectedDevice(devices[0]);
                        }
                    }
                }
            } else {
                setError(data.error || 'Failed to load experiment results');
            }
        } catch (err) {
            console.error('Error loading results:', err);
            setError('Network error while loading results');
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadResults = async () => {
        if (!experimentData) return;

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/downloadResults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reservation_id,
                    experiment_name: experimentData.experiment_name
                })
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${experimentData.experiment_name}_results.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            } else {
                alert('Failed to download results');
            }
        } catch (error) {
            console.error('Error downloading results:', error);
            alert('Error downloading results');
        }
    };

    if (loading) {
        return (
            <div className="page-container">
                <h1>Experiment Evaluation</h1>
                <div className="loading-message">Loading experiment results...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="page-container">
                <h1>Experiment Evaluation</h1>
                <div className="error-message">{error}</div>
            </div>
        );
    }

    if (!experimentData) {
        return (
            <div className="page-container">
                <h1>Experiment Evaluation</h1>
                <div className="info-message">No experiment results available</div>
            </div>
        );
    }

    const telemetryResults = experimentData.telemetry_results || {};
    const executionLog = experimentData.execution_log || [];
    const metrics = Object.keys(telemetryResults);

    return (
        <div className="page-container">
            <h1>Experiment Evaluation</h1>

            {/* Experiment Info */}
            <div className="experiment-info-card">
                <h2>Experiment: {experimentData.experiment_name}</h2>
                <div className="info-grid">
                    <div className="info-item">
                        <strong>Start Time:</strong> {new Date(experimentData.start_time).toLocaleString()}
                    </div>
                    <div className="info-item">
                        <strong>End Time:</strong> {new Date(experimentData.end_time).toLocaleString()}
                    </div>
                    <div className="info-item">
                        <strong>Duration:</strong> {experimentData.duration_s}s ({Math.floor(experimentData.duration_s / 60)}m {experimentData.duration_s % 60}s)
                    </div>
                </div>
                <button onClick={handleDownloadResults} className="download-button">
                    Download All Results
                </button>
            </div>

            {/* Execution Log */}
            <div className="section-card">
                <h2>Execution Log</h2>
                {executionLog.length === 0 ? (
                    <p>No execution log available</p>
                ) : (
                    <div className="execution-log">
                        {executionLog.map((step, idx) => (
                            <div key={idx} className={`log-entry ${step.status}`}>
                                <div className="log-header">
                                    <span className="log-time">T+{step.time_offset_s}s</span>
                                    <span className="log-step-name">{step.step}</span>
                                    <span className={`log-status ${step.status}`}>
                                        {step.status === 'success' ? '✓' : '✗'} {step.status}
                                    </span>
                                </div>
                                <div className="log-details">
                                    <div><strong>Playbook:</strong> {step.playbook}</div>
                                    <div><strong>Targets:</strong> {step.targets ? step.targets.join(', ') : 'N/A'}</div>
                                    {step.error && <div className="error-text"><strong>Error:</strong> {step.error}</div>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Telemetry Results */}
            <div className="section-card">
                <h2>Telemetry Data</h2>

                {metrics.length === 0 ? (
                    <p>No telemetry data available</p>
                ) : (
                    <>
                        <div className="telemetry-controls">
                            <div className="control-group">
                                <label>Metric:</label>
                                <select
                                    value={selectedMetric}
                                    onChange={(e) => {
                                        setSelectedMetric(e.target.value);
                                        const devices = Object.keys(telemetryResults[e.target.value] || {});
                                        if (devices.length > 0) setSelectedDevice(devices[0]);
                                    }}
                                >
                                    {metrics.map(metric => (
                                        <option key={metric} value={metric}>{metric}</option>
                                    ))}
                                </select>
                            </div>

                            {selectedMetric && telemetryResults[selectedMetric] && (
                                <div className="control-group">
                                    <label>Device:</label>
                                    <select
                                        value={selectedDevice}
                                        onChange={(e) => setSelectedDevice(e.target.value)}
                                    >
                                        {Object.keys(telemetryResults[selectedMetric]).map(device => (
                                            <option key={device} value={device}>{device}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>

                        {selectedMetric && selectedDevice && telemetryResults[selectedMetric][selectedDevice] && (
                            <div className="telemetry-data">
                                <h3>Data for {selectedMetric} on {selectedDevice}</h3>
                                <div className="data-table-container">
                                    <table className="data-table">
                                        <thead>
                                            <tr>
                                                <th>#</th>
                                                <th>Timestamp</th>
                                                <th>Value</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {telemetryResults[selectedMetric][selectedDevice].map((dataPoint, idx) => (
                                                <tr key={idx}>
                                                    <td>{idx + 1}</td>
                                                    <td>{new Date(dataPoint.timestamp).toLocaleTimeString()}</td>
                                                    <td>
                                                        <pre className="json-value">
                                                            {JSON.stringify(dataPoint.value, null, 2)}
                                                        </pre>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <div className="data-summary">
                                    <strong>Total samples:</strong> {telemetryResults[selectedMetric][selectedDevice].length}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}