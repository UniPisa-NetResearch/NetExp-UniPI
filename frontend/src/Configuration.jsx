// Configuration.jsx
import React, {useState, useRef, useEffect} from 'react';
import './style/style.css';
import './style/configuration.css';

const fetchAvailabilityStatus = async (username) => {
    try {
        const response = await fetch(`/api/controller/checkAvailability?username=${username}`);

        if (!response.ok) {
            console.error(`HTTP error! status: ${response.status}`);
            return 'error';
        }

        const data = await response.json();

        if (data.command === 'start_configuration') {
            return 'start_configuration';
        } else if (data.command === 'wait_configuration') {
            return 'wait_configuration';
        } else {
            console.error('Unexpected API response:', data);
            return 'error';
        }

    } catch (error) {
        console.error('Error during checkAvailability call:', error);
        return 'error';
    }
};

function useFileInput(allowedExt = []) {
  const ref = useRef(null);
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState(''); // '' | 'valid' | 'invalid'

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
  };

  return { ref, file, fileType, choose, onChange, fileName: file ? file.name : '' };
}

function handleUpload({ descriptors, setOutput, setOutputType, requireAny = true }) {
  const errors = [];

  descriptors.forEach((d) => {
    if (d.fileType === 'invalid') {
      errors.push(`${d.label} has wrong format.`);
    }
  });

  if (errors.length > 0) {
    let errorMessage = 'File format error: ';
    errorMessage += errors.length === 2 ? 'Both files have the wrong format.' : errors[0];
    setOutput(errorMessage);
    setOutputType('error');
    return;
  }

  const anySelected = descriptors.some(d => d.file);
  if (requireAny && !anySelected) {
    setOutput('No files selected');
    setOutputType('error');
    return;
  }

  const names = descriptors.reduce((acc, d) => {
    if (d.file) acc.push(`${d.label}: ${d.file.name}`);
    return acc;
  }, []);

  const time = new Date().toLocaleString();
  setOutput(`Files uploaded (${time}) — ${names.join(' | ')}`);
  setOutputType('success');
}

export default function Configuration({username}) {
  // files: config files and test files
  const playbook = useFileInput(['.yml', '.yaml']);
  const template = useFileInput(['.j2']);

  const testPlaybook = useFileInput(['.yml', '.yaml']);
  const testScript = useFileInput(['.sh', '.py']);

  // output for Load files
  const [loadOutput, setLoadOutput] = useState('');
  const [loadOutputType, setLoadOutputType] = useState(''); // 'success' |'error'

  // test execution output
  const [testOutput, setTestOutput] = useState('');
  const [testOutputType, setTestOutputType] = useState(''); // 'success' | 'error'

  // snapshot management
  const [snapshotList, setSnapshotList] = useState([
    { name: 'snapshot0', description: 'Original network state, no configurations applied' },
  ]);
  const [selectedSnapshot, setSelectedSnapshot] = useState('snapshot0');
  const [snapshotDescriptionInput, setSnapshotDescriptionInput] = useState('');
  const [snapshotResult, setSnapshotResult] = useState('');
  const [snapshotResultType, setSnapshotResultType] = useState(''); // 'success' | 'error'

  // result for rollback/delete
  const [actionResult, setActionResult] = useState('');
  const [actionResultType, setActionResultType] = useState(''); // 'success' | 'error'
  // unlock functionalities when account creation is completed
  const [isAccessGranted, setIsAccessGranted] = useState(false);

  const getNextSnapshotIndex = (currentList) => {
  // extract numerical index
  const indices = currentList.map(s => {
    const match = s.name.match(/snapshot(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  });
  // find max and add 1
  return Math.max(...indices) + 1;
};

  useEffect(() => {
    const POLL_INTERVAL = 10000; // 10 seconds

    let intervalId = null;
    let mounted = true;

    const checkStatus = async () => {
        const command = await fetchAvailabilityStatus(username);

        if (!mounted) return;

        if (command === 'start_configuration') {
            setIsAccessGranted(true);
             if (intervalId) {
              clearInterval(intervalId);
              intervalId = null;
            }
        } else if (command === 'wait_configuration') {
            setIsAccessGranted(false);
            if (!intervalId) {
              intervalId = setInterval(checkStatus, POLL_INTERVAL);
            }
        } else if (command === 'error') {
            console.error("Error or API response not valid. Continue polling");
        }
    };
    checkStatus();

    return () => {
        mounted = false;
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
    };
}, [username]);

  // character limit for description
  const MAX_CHARS = 80;

  // onChange for description: enforce max chars (maxLength on input also used)
  const handleDescriptionChange = (e) => {
    const val = e.target.value;
    // extra safety: prevent more than MAX_CHARS characters (slicing will only occur here, not at snapshot creation)
    if (val.length > MAX_CHARS) {
      setSnapshotDescriptionInput(val.slice(0, MAX_CHARS));
    } else {
      setSnapshotDescriptionInput(val);
    }
  };

  const handleTakeSnapshot = () => {

    const text = snapshotDescriptionInput.trim();
    if (text.length === 0) {
      setSnapshotResult('Description is empty, please add up to 80 chars');
      setSnapshotResultType('error');
      return;
    }
    if (text.length > MAX_CHARS) {
      setSnapshotResult(`Description too long (max ${MAX_CHARS} chars)`);
      setSnapshotResultType('error');
      return;
    }

    let nextIndex = getNextSnapshotIndex(snapshotList);
    const name = `snapshot${nextIndex}`;
    const newSnapshot = { name, description: text};
    setSnapshotList((s) => [...s, newSnapshot]);
    setSelectedSnapshot(name);
    setSnapshotResult(`Snapshot ${name} created`);
    setSnapshotResultType('success');
    setActionResult("");
  };

  const handleRollback = () => {
    if (!selectedSnapshot) {
      setActionResult('No snapshot selected');
      setActionResultType('error');
      return;
    }
    setActionResult(`Rollback to ${selectedSnapshot} started... (simulated)`);
    setActionResultType('success');
    setSnapshotResult("");
    setSnapshotDescriptionInput("");
  };

  const handleDeleteSnapshot = () => {
    if (!selectedSnapshot || selectedSnapshot === 'snapshot0') {
      setActionResult('Cannot delete this snapshot');
      setActionResultType('error');
      return;
    }
    setSnapshotList((list) => list.filter((s) => s.name !== selectedSnapshot));

    // choose a new selected snapshot (fallback to snapshot0)
    setSelectedSnapshot('snapshot0');
    setActionResult(`${selectedSnapshot} deleted`);
    setActionResultType('success');
    setSnapshotResult("");
    setSnapshotDescriptionInput("");
  };

  const selectedSnapshotDescription = () => {
    const s = snapshotList.find((it) => it.name === selectedSnapshot);
    return s ? s.description : '';
  };

   // wrappers that call the generic handler
  const handleLoadFiles = () => {
    handleUpload({
      descriptors: [
        { file: playbook.file, fileType: playbook.fileType, label: 'Playbook' },
        { file: template.file, fileType: template.fileType, label: 'Template' }
      ],
      setOutput: setLoadOutput,
      setOutputType: setLoadOutputType,
      requireAny: true
    });
    setActionResult('');
    setSnapshotResult('');
    setSnapshotDescriptionInput('');
  };

  const handleLoadTestFiles = () => {
    handleUpload({
      descriptors: [
        { file: testPlaybook.file, fileType: testPlaybook.fileType, label: 'Playbook' },
        { file: testScript.file, fileType: testScript.fileType, label: 'Script' }
      ],
      setOutput: setTestOutput,
      setOutputType: setTestOutputType,
      requireAny: true
    });
    setActionResult('');
    setSnapshotResult('');
    setSnapshotDescriptionInput('');
  };

  return (
    <div className="home-content-wrapper configuration-wrapper">
      {/* Conditional message: can be hidden by passing showWait={false} */}
      {!isAccessGranted && (
        <div className="wait-message">Wait account creation on devices...</div>
      )}

      <div className="card configuration-card">
        <h2 className="title">⚙️ Configure devices</h2>

        {/* Row for files and load */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Load Ansible playbook:</label>
            <button type="button" className="playbook-button configuration-button"
                    onClick={playbook.choose} disabled={!isAccessGranted}>Choose
              playbook
            </button>
            <div className={`selected-file-name file-status-${playbook.fileType}`}>{playbook.fileName}</div>
            <input ref={playbook.ref} type="file" style={{display: 'none'}} onChange={playbook.onChange} disabled={!isAccessGranted}/>
            <label className="label-inline">Load Jinja template:</label>
            <button type="button" className="template-button configuration-button" onClick={template.choose} disabled={!isAccessGranted}>Choose
              template
            </button>
            <div className={`selected-file-name file-status-${template.fileType}`}>{template.fileName}</div>
            <input ref={template.ref} type="file" style={{display: 'none'}} onChange={template.onChange} disabled={!isAccessGranted}/>
            <button type="button" className="send-button configuration-button" onClick={handleLoadFiles} disabled={!isAccessGranted}>Load files
            </button>
          </div>
        </div>

        {/* Output line */}
        <div className="output-row">
          <div className="aligned-group">
            <label className="label-inline label-output">Output:</label>
            <textarea readOnly className={`output-field ${loadOutputType}`} value={loadOutput}
                      placeholder="Output will appear here after loading files"/>
          </div>
        </div>

        {/* line for test file loading */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Load Ansible playbook:</label>
            <button type="button" className="playbook-button configuration-button"
                    onClick={testPlaybook.choose} disabled={!isAccessGranted}>Choose
              playbook
            </button>
            <div className={`selected-file-name file-status-${testPlaybook.fileType}`}>{testPlaybook.fileName}</div>
            <input ref={testPlaybook.ref} type="file" style={{display: 'none'}} onChange={testPlaybook.onChange} disabled={!isAccessGranted}/>

            <label className="label-inline">Load test script:</label>
            <button type="button" className="template-button configuration-button" onClick={testScript.choose} disabled={!isAccessGranted}>Choose test
              script
            </button>
            <div className={`selected-file-name file-status-${testScript.fileType} test-file-name`}>{testScript.fileName}</div>
            <input ref={testScript.ref} type="file" style={{display: 'none'}} onChange={testScript.onChange} disabled={!isAccessGranted}/>

            <button type="button" className="send-button configuration-button" onClick={handleLoadTestFiles} disabled={!isAccessGranted}>Run test</button>
          </div>
        </div>

        {/* Output line for Test */}
        <div className="output-row">
          <div className="aligned-group">
            <label className="label-inline label-output">Output:</label>
            <textarea readOnly className={`output-field ${testOutputType}`} value={testOutput}
                      placeholder="Output of the test"/>
          </div>
        </div>

        {/* Snapshot creation row */}
        <div className="config-row main-actions-row">
          <label className="label-inline">Insert description (max 80 chars):</label>
          <input
              type="text"
              className="text-input"
              value={snapshotDescriptionInput}
              onChange={handleDescriptionChange}
              placeholder="Snapshot description"
              maxLength={MAX_CHARS}
              disabled={!isAccessGranted}
          />
          <button type="button" className="send-button configuration-button" onClick={handleTakeSnapshot} disabled={!isAccessGranted}>Take
            snapshot
          </button>
        </div>

        {/* Snapshot creation result line */}
        <div className={`config-row small-result ${snapshotResultType}`}>
          {snapshotResult}
        </div>

        {/* Snapshot selection and actions */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Select snapshot:</label>
            <select
                className="select-field"
                value={selectedSnapshot}
                onChange={(e) => setSelectedSnapshot(e.target.value)}
                disabled={!isAccessGranted}
            >
              {snapshotList.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="aligned-group description-display-group">
            <label className="label-inline">Description:</label>
            <div className="snapshot-desc">{selectedSnapshotDescription()}</div>
          </div>

          <div className="snapshot-actions">
            <button type="button" className="rollback-button configuration-button" onClick={handleRollback} disabled={!isAccessGranted}>Rollback
            </button>
            <button
                type="button"
                className="delete-button delete configuration-button"
                onClick={handleDeleteSnapshot}
                disabled={!isAccessGranted || !selectedSnapshot || selectedSnapshot === 'snapshot0'}
            >
              Delete snapshot
            </button>
          </div>
        </div>

        {/* Action result line */}
        <div className={`config-row small-result ${actionResultType}`}>
          {actionResult}
        </div>
      </div>
    </div>
  );
}