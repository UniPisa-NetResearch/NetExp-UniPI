import React, {useState, useEffect, useRef} from 'react';
import { Chart } from 'chart.js/auto';
import './style/style.css';
import './style/evaluation.css';

export default function Evaluation({ username, reservation_id }) {
    const [experimentData, setExperimentData] = useState(null);            // experiment data object containing results
    const [selectedMetric, setSelectedMetric] = useState('');       // selected metric path
    const [selectedDevice, setSelectedDevice] = useState('');       // select device from inventory
    const [availableDevices, setAvailableDevices] = useState([]);   // list of available devices for selected metric
    const [telemetryResults, setTelemetryResults] = useState(null);       // complete telemetry data
    const [availableMetrics, setAvailableMetrics] = useState([]);  // metric paths list
    const [availableFields, setAvailableFields] = useState([]);    // available fields for the metric
    const [selectedField, setSelectedField] = useState('');       // selected field
    const [chartData, setChartData] = useState(null);                    // data for the plot
    const [errorMessage, setErrorMessage] = useState('');         // error message
    const [loadingData, setLoadingData] = useState(true);       // data loading
    // iperf results
    const [iperfResults, setIperfResults] = useState(null);              // iperf3 results
    const [availableFlows, setAvailableFlows] = useState([]);      // available flows list
    const [selectedFlow, setSelectedFlow] = useState('');          // selected flow
    const [flowData, setFlowData] = useState(null);                       // selected flow data

    // extract unique metric names from telemetry results
    // telemetryResults is an Object with metric names as keys and returns an array of {name, label} objects
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

    // fetch experiment results from backend API
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
                // extract available metrics from telemetry data
                const metrics = extractAvailableMetrics(data.telemetry_results);
                setAvailableMetrics(metrics);
            } else {
                setErrorMessage('No telemetry data available');
            }

            if (data.iperf_results) {
                setIperfResults(data.iperf_results);
                // extract flows
                const flows = Object.keys(data.iperf_results).sort();
                setAvailableFlows(flows);
            } else {
                setErrorMessage('No iperf data available');
            }

        } catch (err) {
            console.error('Error loading results:', err);
            setErrorMessage('Network error while loading results');
        } finally {
            setLoadingData(false);
        }
    };

    // download complete experiment results as ZIP file
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
        // reset all dependent selections
        setSelectedMetric(metricName);
        setSelectedDevice('');
        setSelectedField('');
        setChartData(null);
        setErrorMessage('');

        // validate metric exists in telemetry data
        if (!metricName || !telemetryResults[metricName]) {
            setAvailableFields([]);
            setAvailableDevices([]);
            return;
        }

        // extract device names (targets) for this metric
        const targets = Object.keys(telemetryResults[metricName]);
        setAvailableDevices(targets);

        if (targets.length === 0) {
            setAvailableFields([]);
        }
    };

    const handleDeviceSelection = (deviceName) => {
        setSelectedDevice(deviceName);
        // reset field selection and chart
        setSelectedField('');
        setChartData(null);
        setErrorMessage('');

        // validate device exists for selected metric
        if (!deviceName || !telemetryResults[selectedMetric] || !telemetryResults[selectedMetric][deviceName]) {
            setAvailableFields([]);
            return;
        }
        // get datapoints array for this device
        const datapoints = telemetryResults[selectedMetric][deviceName];
        if (!datapoints || datapoints.length === 0) {
            setAvailableFields([]);
            return;
        }
        // analyze first sample to determine structure
        const firstSample = datapoints[0].value;

        // extract fields from gNMI notification structure
        const fields = extractFieldsFromSample(firstSample, selectedMetric);
        setAvailableFields(fields);
    };

    const handleFieldSelection = (fieldPath) => {
        setSelectedField(fieldPath);
        setChartData(null);
        setErrorMessage('');
    };

    // extract available fields from a gNMI sample value
    const extractFieldsFromSample = (sampleValue, metricName) => {
      const fields = [];

      // gNMI structure: {notification: [{update: [{path, val}]}]}
      const notifications = sampleValue?.notification;
      if (!notifications || !Array.isArray(notifications)) return fields;

      // iterate through notifications and updates
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
              for (const interfaceKey in val) {
                const interfaceData = val[interfaceKey];
                // expand if the value is an object
                if (typeof interfaceData === 'object' && interfaceData !== null && !Array.isArray(interfaceData)) {
                  // extract each field from nested level
                  for (const fieldKey in interfaceData) {
                    fields.push({
                      path: `${interfaceKey}.${fieldKey}`,
                      label: `${interfaceKey} - ${fieldKey}`,
                      fullPath: `${interfaceKey}.${fieldKey}`
                    });
                  }
                } else {
                  // use directly a simple value
                  fields.push({
                    path: interfaceKey,
                    label: interfaceKey,
                    fullPath: interfaceKey
                  });
                }
              }
            }
          }
        }
      }

      return fields;
    };

    const handleGeneratePlot = () => {
      setErrorMessage('');

      // validate all required selections are made
      if (!selectedMetric || !selectedDevice || !selectedField) {
        setErrorMessage('Please select metric, device and field');
        return;
      }

      const timestamps = [];
      const values = [];
      let hasNonNumeric = false;

      // get datapoints for selected metric and device
      const metricData = telemetryResults[selectedMetric];
      const deviceDatapoints = metricData[selectedDevice];

      if (!deviceDatapoints || deviceDatapoints.length === 0) {
          setErrorMessage('No data available for selected device');
          return;
      }

      // sort datapoints by timestamp
      const sortedDatapoints = [...deviceDatapoints].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // extract value from each datapoint
      sortedDatapoints.forEach((datapoint) => {
        // convert timestamp to readable time format
        timestamps.push(new Date(datapoint.timestamp).toLocaleTimeString());

        // navigate gNMI notification structure to extract value
        const sampleValue = datapoint.value;
        const notifications = sampleValue?.notification;

        let extractedValue = null;

        if (notifications && Array.isArray(notifications)) {
            for (const notif of notifications) {

                if (notif.update && Array.isArray(notif.update)) {
                    const isOpenConfig = selectedMetric.includes('openconfig');
                    let val = null;
                    if(isOpenConfig) {
                        // remove leading slash from metric name if present
                        const normalizedMetric = selectedMetric.startsWith('/') ? selectedMetric.substring(1) : selectedMetric;
                        // find the update corresponding to the selected metric
                        const matchingUpdate = notif.update.find(upd => upd.path === normalizedMetric);

                        if (matchingUpdate) {
                           val = matchingUpdate.val;
                        }
                    } else {
                      // Sonic DB:
                      if (notif.update.length > 0) {
                          val = notif.update[0].val;
                      }
                    }
                    if(val){
                        // navigate nested object structure using field path
                        const pathParts = selectedField.split('.');

                        let currentVal = val;

                        // traverse object hierarchy
                        for (const part of pathParts) {
                          currentVal = currentVal?.[part];
                          if (currentVal === undefined || currentVal === null) {
                            break;
                            }
                        }
                        extractedValue = currentVal;
                        break;
                   }else {
                        console.log('NO MATCHING UPDATE FOUND!');
                   }
                }
           }
        }

        // convert extracted value to number for plotting
        if (extractedValue !== null && extractedValue !== undefined) {
          const numValue = Number(extractedValue);

          if (isNaN(numValue)) {
            hasNonNumeric = true;
            values.push(null);
          } else {
            values.push(numValue);
          }
        } else {
          values.push(null);
        }
      });

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

    // render Chart.js line chart with time series data
    const renderChart = (data) => {
      // destroy previous chart instance to prevent memory leaks
      if (chartInstanceRef.current) {
        chartInstanceRef.current.destroy();
      }

      // get 2D rendering context from canvas element
      const ctx = chartRef.current.getContext('2d');
      chartInstanceRef.current = new Chart(ctx, {
        type: 'line',
        data: {
          labels: data.timestamps,              // X-axis labels (time)
          datasets: [{
            label: `${selectedDevice} - ${selectedMetric} - ${selectedField}`,
            data: data.values,                  // Y-axis values
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            tension: 0.1                        // line smoothing
          }]
        },
        options: {
          responsive: true,                         // adapt to container size
          maintainAspectRatio: false,               // allow custom height
          plugins: {
            title: {
              display: true,
              text: 'Telemetry Time Series'
            }
          },
          scales: {
            y: {
              beginAtZero: false,                       // don't force Y-axis to start at 0
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

        // cleanup: destroy the plot when the component is unmounted or before creating a new one
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

    const handleFlowSelection = (flowName) => {
        setSelectedFlow(flowName);
        setFlowData(null);

        if (!flowName || !iperfResults[flowName]) {
            return;
        }

        // load data of selected
        setFlowData(iperfResults[flowName]);
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
                                                    <div>
                                                        <strong>Targets:</strong> {step.targets ? step.targets.join(', ') : 'N/A'}
                                                    </div>
                                                    {step.error &&
                                                        <div className="error-text"><strong>Error:</strong> {step.error}
                                                        </div>}
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
                                        <select value={selectedDevice}
                                                onChange={(e) => handleDeviceSelection(e.target.value)}
                                                disabled={!selectedMetric || availableDevices.length === 0}>
                                            <option value="">-- Select Device --</option>
                                            {availableDevices.map(device => (
                                                <option key={device} value={device}>{device}</option>
                                            ))}
                                        </select>
                                    </div>


                                    {/* select field */}
                                    <div className="selection-row">
                                        <label>Select Field to Plot:</label>
                                        <select value={selectedField}
                                                onChange={(e) => handleFieldSelection(e.target.value)}
                                                disabled={!selectedDevice || availableFields.length === 0}>
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
                                        <button className="btn-primary" onClick={handleGeneratePlot}
                                                disabled={!selectedMetric || !selectedDevice || !selectedField}>Generate
                                            Plot
                                        </button>
                                        <button className="btn-secondary" onClick={handleDownloadCSV}
                                                disabled={!chartData || errorMessage}>Download CSV
                                        </button>

                                    </div>


                                    {/* error message */}
                                    {errorMessage && (
                                        <div className="error-message">{errorMessage}</div>
                                    )}

                                    {/* show plot */}
                                    {chartData && !errorMessage && (
                                        <div className="chart-container" style={{height: '400px', marginTop: '20px'}}>
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

                        <div className="section-card">
                            <h2>iPerf Flow Results</h2>

                            {!iperfResults || Object.keys(iperfResults).length === 0 ? (
                                <div className="no-data-message">
                                    No iPerf results available for this experiment
                                </div>
                            ) : (
                                <>
                                    {/* Select flow */}
                                    <div className="selection-row">
                                        <label>Select Flow:</label>
                                        <select value={selectedFlow} onChange={(e) => handleFlowSelection(e.target.value)}>
                                            <option value="">-- Select Flow --</option>
                                            {availableFlows.map(flow => (<option key={flow} value={flow}>{flow}</option>))}
                                        </select>
                                    </div>
                                    {/* Full txt output */}
                                    {flowData && flowData.text && (
                                        <div className="iperf-viewer-card">
                                            <h3>Flow Output: {selectedFlow}</h3>
                                            <pre className="iperf-text-content">
                                                {flowData.text}
                                            </pre>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}