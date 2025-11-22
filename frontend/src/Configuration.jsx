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

export default function Configuration({username}) {
  // files
  const playbookRef = useRef(null);
  const templateRef = useRef(null);
  const [playbookFile, setPlaybookFile] = useState(null);
  const [templateFile, setTemplateFile] = useState(null);
  const [playbookFileType, setPlaybookFileType] = useState(''); // 'valid' | 'invalid'
  const [templateFileType, setTemplateFileType] = useState(''); // 'valid' | 'invalid'

  // output for Load files
  const [loadOutput, setLoadOutput] = useState('');
  const [loadOutputType, setLoadOutputType] = useState(''); // 'success' |'error'

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
  const [pollIntervalId, setPollIntervalId] = useState(null);

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

    const checkStatus = async () => {
        const command = await fetchAvailabilityStatus(username);

        if (command === 'start_configuration') {
            setIsAccessGranted(true);

            if (pollIntervalId) {
                if (typeof pollIntervalId === 'number' && pollIntervalId > 0) {
                    clearInterval(pollIntervalId);
                    setPollIntervalId(null);
                } else if (pollIntervalId) {
                    clearInterval(pollIntervalId);
                    setPollIntervalId(null);
                }
            }

        } else if (command === 'wait_configuration') {
            setIsAccessGranted(false);

            if (!pollIntervalId) {
                const id = setInterval(checkStatus, POLL_INTERVAL);
                setPollIntervalId(id);
            }
        } else if (command === 'error') {
            console.error("Error orAPI response not valid. Continue polling");
        }
    };
}, [username, pollIntervalId]);

  // helpers
  const handleChoosePlaybook = () => playbookRef.current && playbookRef.current.click();
  const handleChooseTemplate = () => templateRef.current && templateRef.current.click();

  const onPlaybookChange = (e) => {
    const f = e.target.files[0] || null;
    setPlaybookFile(f);
    if (f) {
      const isValid = f.name.toLowerCase().endsWith('.yml') || f.name.toLowerCase().endsWith('.yaml');
      setPlaybookFileType(isValid ? 'valid' : 'invalid');
    } else {
      setPlaybookFileType('');
    }
  };
  const onTemplateChange = (e) => {
      const f = e.target.files[0] || null;
      setTemplateFile(f);
      if (f) {
        const isValid = f.name.toLowerCase().endsWith('.j2');
        setTemplateFileType(isValid ? 'valid' : 'invalid');
      } else {
        setTemplateFileType('');
      }
  };

  const handleLoadFiles = () => {
    const errors = [];
    if (playbookFileType === 'invalid') {
        errors.push("Playbook must be a .yml or .yaml file.");
    }
    if (templateFileType === 'invalid') {
        errors.push("Template must be a .j2 file.");
    }

    if (errors.length > 0) {
        let errorMessage = "File format error: ";

        if (errors.length === 2) {
            errorMessage += "Both files have the wrong format.";
        } else {
            errorMessage += errors[0];
        }

        setLoadOutput(errorMessage);
        setLoadOutputType('error');
        return;
    }

    // Simulate sending files. If none selected, inform user.
    if (!playbookFile && !templateFile) {
      setLoadOutput('No files selected');
      setLoadOutputType('error');
      return;
    }

    const names = [];
    if (playbookFile) names.push(`Playbook: ${playbookFile.name}`);
    if (templateFile) names.push(`Template: ${templateFile.name}`);

    const time = new Date().toLocaleString();
    setLoadOutput(`Files uploaded (${time}) — ${names.join(' | ')}`);
    setLoadOutputType('success');
    setActionResult("");
    setSnapshotResult("");
    setSnapshotDescriptionInput("");
  };

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
                    onClick={handleChoosePlaybook} disabled={!isAccessGranted}>Choose
              playbook
            </button>
            <div className={`selected-file-name file-status-${playbookFileType}`}>{playbookFile ? playbookFile.name : ''}</div>
            <input ref={playbookRef} type="file" style={{display: 'none'}} onChange={onPlaybookChange} disabled={!isAccessGranted}/>
            <label className="label-inline">Load Jinja template:</label>
            <button type="button" className="template-button configuration-button" onClick={handleChooseTemplate} disabled={!isAccessGranted}>Choose
              template
            </button>
            <div className={`selected-file-name file-status-${templateFileType}`}>{templateFile ? templateFile.name : ''}</div>
            <input ref={templateRef} type="file" style={{display: 'none'}} onChange={onTemplateChange} disabled={!isAccessGranted}/>
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