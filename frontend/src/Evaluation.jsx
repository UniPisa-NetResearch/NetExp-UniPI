// Evaluation.jsx
import React, {useState, useEffect, useRef} from 'react';
import { Chart } from 'chart.js/auto';
import './style/style.css';
import './style/evaluation.css';

export default function Evaluation({ username, reservation_id }) {
    const [experimentData, setExperimentData] = useState(null);
    const [selectedMetric, setSelectedMetric] = useState(''); // selected metric path
    const [selectedDevice, setSelectedDevice] = useState('');
    const [availableDevices, setAvailableDevices] = useState([]);
    const [telemetryResults, setTelemetryResults] = useState(null); // complete telemetry data
    const [availableMetrics, setAvailableMetrics] = useState([]); // metric paths list
    const [availableFields, setAvailableFields] = useState([]); // available fields for the metric
    const [selectedField, setSelectedField] = useState(''); // selected field
    const [chartData, setChartData] = useState(null); // data for the plot
    const [errorMessage, setErrorMessage] = useState(''); // error message
    const [loadingData, setLoadingData] = useState(true); // data loading

    const extractAvailableMetrics = (telemetryResults) => {
      const metricsSet = new Set();

      // telemetryResults is an object with keys = metric names
      // each metric has target → datapoints with {timestamp, value}
      Object.keys(telemetryResults).forEach(metricName => {
        metricsSet.add(metricName);
      });

      return Array.from(metricsSet).map(name => ({
        name: name,
        label: name
      }));
    };

    useEffect(() => {
        loadExperimentResults();
    }, [reservation_id]);

    const loadExperimentResults = async () => {
        setLoadingData(true);
        setErrorMessage('');

        try {
            const response = await fetch('http://localhost:5004/api/experimenter/getExperimentResults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id })
            });

            const data = await response.json();

            if (data.success && data.telemetry_results) {
                setExperimentData(data);
                setTelemetryResults(data.telemetry_results);

                const metrics = extractAvailableMetrics(data.telemetry_results);
                setAvailableMetrics(metrics);
            } else {
                setErrorMessage('No telemetry data available');
            }
        } catch (err) {
            console.error('Error loading results:', err);
            setErrorMessage('Network error while loading results');
        } finally {
            setLoadingData(false);
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

    const handleMetricSelection = (metricName) => {
        setSelectedMetric(metricName);
        setSelectedDevice('');
        setSelectedField('');
        setChartData(null);
        setErrorMessage('');

        if (!metricName || !telemetryResults[metricName]) {
            setAvailableFields([]);
            setAvailableDevices([]);
            return;
        }

        // get first target and datapoint to analyze structure
        const targets = Object.keys(telemetryResults[metricName]);
        setAvailableDevices(targets);

        if (targets.length === 0) {
            setAvailableFields([]);
        }
    };

    const handleDeviceSelection = (deviceName) => {
        setSelectedDevice(deviceName);
        setSelectedField('');
        setChartData(null);
        setErrorMessage('');

        if (!deviceName || !telemetryResults[selectedMetric] || !telemetryResults[selectedMetric][deviceName]) {
            setAvailableFields([]);
            return;
        }

        const datapoints = telemetryResults[selectedMetric][deviceName];
        if (!datapoints || datapoints.length === 0) {
            setAvailableFields([]);
            return;
        }

        const firstSample = datapoints[0].value;

        // extract fields from first sample
        const fields = extractFieldsFromSample(firstSample, selectedMetric);
        setAvailableFields(fields);
    };

    const handleFieldSelection = (fieldPath) => {
        setSelectedField(fieldPath);
        setChartData(null);
        setErrorMessage('');
    };

    const extractFieldsFromSample = (sampleValue, metricName) => {
      const fields = [];

      // {notification: [{update: [{path, val}]}]}
      const notifications = sampleValue?.notification;
      if (!notifications || !Array.isArray(notifications)) return fields;

      // get the first notification and the first update
      for (const notif of notifications) {
        if (notif.update && Array.isArray(notif.update)) {
          for (const upd of notif.update) {
            const val = upd.val;
            if (!val || typeof val !== 'object') continue;

            // determine if it is OpenConfig or Config DB
            const isOpenConfig = metricName.includes('openconfig');

            if (isOpenConfig) {
              // OpenConfig: val = {"openconfig-interfaces:counters": {...}}
              for (const wrapperKey in val) {
                const counters = val[wrapperKey];
                if (typeof counters === 'object' && counters !== null) {
                  for (const fieldKey in counters) {
                    fields.push({
                      path: `${wrapperKey}.${fieldKey}`,
                      label: fieldKey,
                      fullPath: `${wrapperKey}.${fieldKey}`
                    });
                  }
                }
              }
            } else {
              // Config DB: val = {"SAI_PORT_STAT_...": "value", ...}
              for (const fieldKey in val) {
                fields.push({
                  path: fieldKey,
                  label: fieldKey,
                  fullPath: fieldKey
                });
              }
            }
          }
        }
      }

      return fields;
    };

    const handleGeneratePlot = () => {
      setErrorMessage('');

      if (!selectedMetric || !selectedDevice || !selectedField) {
        setErrorMessage('Please select metric, device and field');
        return;
      }

      console.log('=== DEBUG handleGeneratePlot ===');
      console.log('selectedMetric:', selectedMetric);
      console.log('selectedDevice:', selectedDevice);
      console.log('selectedField:', selectedField);

      const timestamps = [];
      const values = [];
      let hasNonNumeric = false;

      // combine every datapoints of each target for selected metric
      const metricData = telemetryResults[selectedMetric];
      const deviceDatapoints = metricData[selectedDevice];

      if (!deviceDatapoints || deviceDatapoints.length === 0) {
          setErrorMessage('No data available for selected device');
          return;
      }
      console.log('Total datapoints:', deviceDatapoints.length);

      // sort by timestamp
      const sortedDatapoints = [...deviceDatapoints].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // extract values
      sortedDatapoints.forEach((datapoint, index) => {
          console.log(`\n--- Datapoint ${index} ---`);
        timestamps.push(new Date(datapoint.timestamp).toLocaleTimeString());

        // navigate the structure to extract value
        const sampleValue = datapoint.value;
        const notifications = sampleValue?.notification;

        console.log('notifications:', notifications ? 'exists' : 'null');
        let extractedValue = null;

        if (notifications && Array.isArray(notifications)) {
            for (const notif of notifications) {
                console.log('notif.update:', notif.update);
                if (notif.update && Array.isArray(notif.update)) {
                    console.log('Available paths in this notification:');
                    notif.update.forEach(upd => {
                        console.log('  -', upd.path);
                    });
                    const normalizedMetric = selectedMetric.startsWith('/') ? selectedMetric.substring(1) : selectedMetric;
                    // find the update corresponding to the selected metric
                    const matchingUpdate = notif.update.find(upd => upd.path === normalizedMetric);
                    console.log('matchingUpdate found:', !!matchingUpdate);
                    if (matchingUpdate) {
                        const val = matchingUpdate.val;
                        console.log('val keys:', Object.keys(val));
                        const pathParts = selectedField.split('.');
                        console.log('pathParts:', pathParts);
                        let currentVal = val;

                        for (const part of pathParts) {
                            console.log(`Navigating to: ${part}, currentVal:`, currentVal);
                          currentVal = currentVal?.[part];
                        }

                        extractedValue = currentVal;
                        console.log('extractedValue:', extractedValue);
                        break;
                   }else {
                        console.log('NO MATCHING UPDATE FOUND!');
                   }
                }
           }
        }

        // convert in number
        if (extractedValue !== null && extractedValue !== undefined) {
          const numValue = Number(extractedValue);
          console.log('numValue:', numValue, 'isNaN:', isNaN(numValue));
          if (isNaN(numValue)) {
            hasNonNumeric = true;
            values.push(null);
          } else {
            values.push(numValue);
          }
        } else {
            console.log('extractedValue is null or undefined');
          values.push(null);
        }
      });

      console.log('\n=== FINAL RESULTS ===');
        console.log('hasNonNumeric:', hasNonNumeric);
        console.log('values:', values);
        console.log('all null?', values.every(v => v === null));

      if (hasNonNumeric) {
        setErrorMessage('Cannot create chart: selected field contains non-numeric values');
        return;
      }

      if (values.every(v => v === null)) {
        setErrorMessage('No valid data found for the selected field');
        return;
      }

      setChartData({ timestamps, values });
    };

    const chartRef = useRef(null);
    const chartInstanceRef = useRef(null);

    const renderChart = (data) => {
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
      }

      const ctx = chartRef.current.getContext('2d');
      chartInstanceRef.current = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.timestamps,
          datasets: [{
            label: `${selectedDevice} - ${selectedMetric} - ${selectedField}`,
            data: data.values,
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            tension: 0.1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: {
              display: true,
              text: 'Telemetry Time Series'
            }
          },
          scales: {
            y: {
              beginAtZero: false,
              title: { display: true, text: 'Value' }
            },
            x: {
              title: { display: true, text: 'Time' }
            }
          }
        }
      });
    };

    useEffect(() => {
        // render the plot only when chartData is available and there are no errors
        if (chartData && chartRef.current && !errorMessage) {
            renderChart(chartData);
        }

        // Cleanup: destroy the plot when the component is unmounted or before creating a new one
        return () => {
            if (chartInstanceRef.current) {
                chartInstanceRef.current.destroy();
                chartInstanceRef.current = null;
            }
        };
    }, [chartData, errorMessage, selectedDevice, selectedMetric, selectedField]);

    const handleDownloadCSV = () => {
      if (!chartData) return;

      let csvContent = 'Timestamp,Value,Metric,Field\n';

      chartData.timestamps.forEach((timestamp, idx) => {
        const value = chartData.values[idx] !== null ? chartData.values[idx] : '';
        csvContent += `${timestamp},${value},${selectedMetric},${selectedField}\n`;
      });

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const filename = `telemetry_${selectedField.replace(/[:.]/g, '_')}.csv`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    };

    return (
        <div className="evaluation-wrapper">
            <div className="card evaluation-card">
                <h2>Experiment Evaluation</h2>
                {loadingData && (
                    <div className="loading-message">Loading experiment results...</div>
                )}
                {!loadingData && !experimentData && (
                    <div className="info-message">No experiment results available</div>
                )}
                {!loadingData && experimentData && (
                    <>
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
                                    <strong>Duration:</strong> {experimentData.duration_s}s
                                    ({Math.floor(experimentData.duration_s / 60)}m {experimentData.duration_s % 60}s)
                                </div>
                            </div>
                            <button onClick={handleDownloadResults} className="download-button">
                                Download All Results
                            </button>
                        </div>

                        {/* Execution Log */}
                        <div className="section-card">
                            <h2>Execution Log</h2>
                            {(() => {
                                const executionLog = experimentData.execution_log || [];
                                return executionLog.length === 0 ? (
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
                                                    <div><strong>Targets:</strong> {step.targets ? step.targets.join(', ') : 'N/A'}
                                                    </div>
                                                    {step.error &&
                                                        <div className="error-text"><strong>Error:</strong> {step.error}</div>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                 );
                            })()}
                        </div>

                        {/* Telemetry Results */}
                        <div className="section-card">
                            <h2>Telemetry Data</h2>
                            {loadingData && (
                                <div className="loading-message">Loading telemetry data...</div>
                            )}

                            {!loadingData && telemetryResults && (
                            <>
                              {/* select metric */}
                              <div className="selection-row">
                                <label>Select Metric:</label>
                                <select
                                  value={selectedMetric}
                                  onChange={(e) => handleMetricSelection(e.target.value)}
                                  disabled={availableMetrics.length === 0}
                                >
                                  <option value="">-- Select Metric --</option>
                                  {availableMetrics.map(metric => (
                                    <option key={metric.name} value={metric.name}>
                                      {metric.label}
                                    </option>
                                  ))}
                                </select>
                              </div>


                              {/* select device */}
                              <div className="selection-row">
                                  <label>Select Device:</label>
                                  <select value={selectedDevice} onChange={(e) => handleDeviceSelection(e.target.value)} disabled={!selectedMetric || availableDevices.length === 0}>
                                      <option value="">-- Select Device --</option>
                                      {availableDevices.map(device => (
                                          <option key={device} value={device}>{device}</option>
                                      ))}
                                  </select>
                              </div>


                              {/* select field */}
                              <div className="selection-row">
                                  <label>Select Field to Plot:</label>
                                  <select value={selectedField} onChange={(e) => handleFieldSelection(e.target.value)} disabled={!selectedDevice || availableFields.length === 0}>
                                    <option value="">-- Select Field --</option>
                                    {availableFields.map(field => (
                                      <option key={field.path} value={field.path}>
                                        {field.label}
                                      </option>
                                    ))}
                                  </select>
                              </div>

                              {/* action buttons */}
                              <div className="action-buttons">
                                  <button className="btn-primary" onClick={handleGeneratePlot} disabled={!selectedMetric || !selectedDevice || !selectedField}>Generate Plot</button>
                                  <button className="btn-secondary" onClick={handleDownloadCSV} disabled={!chartData || errorMessage}>Download CSV</button>

                              </div>


                              {/* error message */}
                              {errorMessage && (
                                <div className="error-message">{errorMessage}</div>
                              )}

                              {/* show plot */}
                              {chartData && !errorMessage && (
                                <div className="chart-container" style={{ height: '400px', marginTop: '20px' }}>
                                  <canvas ref={chartRef}></canvas>
                                </div>
                              )}
                            </>
                          )}

                          {!loadingData && !telemetryResults && (
                            <div className="no-data-message">
                              No telemetry data available for this experiment
                            </div>
                          )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}