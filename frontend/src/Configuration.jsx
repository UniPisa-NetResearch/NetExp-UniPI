// Configuration.jsx
import React, {useState, useRef, useEffect} from 'react';
import './style/style.css';
import './style/configuration.css';

const fetchAvailabilityStatus = async (username, reservation_id) => {
    try {
        const response = await fetch(`/api/controller/checkAvailability?username=${username}&reservation_id=${reservation_id}`);

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
    e.target.value = null;
  };
  const reset = () => {
    setFile(null);
    setFileType('');
  }
  return { ref, file, fileType, choose, onChange, fileName: file ? file.name : '', reset };
}

function handleUpload({ descriptors, setOutput, setOutputType, requireAny = true }) {
  const errors = [];
  let errorMessage

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

  if (errors.length > 0) {
    setOutput(errorMessage);
    setOutputType('error');
    return false;
  }

  const anySelected = descriptors.some(d => d.file);
  if (requireAny && !anySelected) {
    setOutput('No files selected');
    setOutputType('error');
    return false;
  }

  const names = descriptors.reduce((acc, d) => {
    if (d.file) acc.push(`${d.label}: ${d.file.name}`);
    return acc;
  }, []);

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

export default function Configuration({username, reservation_id}) {
  // files: playbook, template and test files
  const template = useFileInput(['.zip']);
  const playbook = useFileInput(['.yml', '.yaml']);
  // template output
  const [templateOutput, setTemplateOutput] = useState('');
  const [templateOutputType, setTemplateOutputType] = useState(''); // 'success' |'error' | 'wait'
  // playbook output
  const [playbookOutput, setPlaybookOutput] = useState('');
  const [playbookOutputType, setPlaybookOutputType] = useState(''); // 'success' |'error' | 'wait'
  // test execution output
  const [testOutput, setTestOutput] = useState('');
  const [testOutputType, setTestOutputType] = useState(''); // 'success' | 'error' | 'wait'

  // snapshot management
  const [snapshotList, setSnapshotList] = useState([{ name: 'snapshot0', description: 'Original network state, no configurations applied' },]);
  const [selectedSnapshot, setSelectedSnapshot] = useState('snapshot0');
  const [snapshotDescriptionInput, setSnapshotDescriptionInput] = useState('');
  const [snapshotResult, setSnapshotResult] = useState('');
  const [snapshotResultType, setSnapshotResultType] = useState(''); // 'success' | 'error' | 'wait'

  // result for rollback/delete
  const [actionResult, setActionResult] = useState('');
  const [actionResultType, setActionResultType] = useState(''); // 'success' | 'error' | 'wait'
  // unlock functionalities when account creation is completed
  const [isAccessGranted, setIsAccessGranted] = useState(false);

// when true all buttons are disabled until operation completes
const [waitOperation, setWaitOperation] = useState(false);

const [jobId, setJobId] = useState(null);
const [polling, setPolling] = useState(false);

const downloadFile= async (file_type) =>{
  console.log("file type: ", file_type);

  if (file_type === "playbook") {
    setPlaybookOutput("Downloading playbook template...");
    setPlaybookOutputType("wait");
    setWaitOperation(true);
    try {
      const payload = { reservation_id: reservation_id};

      const resp = await fetch("/api/validator/downloadPlaybook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        let errMsg;
        const j = await resp.json();
        errMsg = j.message || JSON.stringify(j);

        setPlaybookOutput(errMsg);
        setPlaybookOutputType("error");
        setWaitOperation(false);
        return;
      }
      // read file as ArrayBuffer, create Blob and start download
      const arrayBuffer = await resp.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: "text/yaml" });

      // retrieve filename from header Content-Disposition if exists
      let filename = `res_${reservation_id}_playbook_template.yml`;
      const cd = resp.headers.get("Content-Disposition");
      if (cd) {
        const m = cd.match(/filename\*=UTF-8''(.+)$|filename="?([^";]+)"?/);
        if (m) filename = decodeURI(m[1] || m[2]);
      }

      createDownload(blob, filename);

      setPlaybookOutput(`Downloaded playbook: ${filename}`);
      setPlaybookOutputType("success");
      setWaitOperation(false);
    } catch (e) {
      setPlaybookOutput(`Error: ${e}`);
      setPlaybookOutputType("error");
      setWaitOperation(false);
    }
  } else if (file_type === "template") {
    setTemplateOutput("Downloading running configs zip...");
    setTemplateOutputType("wait");
    setWaitOperation(true);
    try {
      const payload = { reservation_id: reservation_id };

      const resp = await fetch("/api/validator/downloadTemplate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        // try to parse JSON error body, fall back to text
        let errMsg = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          errMsg = j.message || JSON.stringify(j);
        } catch (parseErr) {
          try {
            errMsg = await resp.text();
          } catch (_) { /* ignore */ }
        }
        setTemplateOutput(errMsg);
        setTemplateOutputType("error");
        setWaitOperation(false);
        return;
      }

      // read file as ArrayBuffer, create Blob and start download
      const arrayBuffer = await resp.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: "application/zip" });

      // default filename
      let filename = `res_${reservation_id}running_configs.zip`;
      // retrieve filename from header Content-Disposition if exists
      const cd = resp.headers.get("Content-Disposition");
      if (cd) {
        // common filename patterns
        const encodedMatch = cd.match(/filename\*=UTF-8''([^;]+)/);
        const plainMatch = cd.match(/filename="?([^";]+)"?/);
        if (encodedMatch && encodedMatch[1]) {
          try {
            filename = decodeURIComponent(encodedMatch[1]);
          } catch (_) {
            filename = encodedMatch[1];
          }
        } else if (plainMatch && plainMatch[1]) {
          filename = plainMatch[1];
        }
      }

      // create object URL and start download
       createDownload(blob, filename);

      setTemplateOutput(`Downloaded template: ${filename}`);
      setTemplateOutputType("success");
      setWaitOperation(false);
    } catch (e) {
      setTemplateOutput(`Error: ${e}`);
      setTemplateOutputType("error");
      setWaitOperation(false)
    }
  }
}

const runTest = () =>{
   console.log("run test");
}

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
        const command = await fetchAvailabilityStatus(username, reservation_id);

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
  const handleTemplateFile = async () => {
    const ok = handleUpload({
      descriptors: [
        {file: template.file, fileType: template.fileType, label: 'Template'}
      ],
      setOutput: setTemplateOutput,
      setOutputType: setTemplateOutputType,
      requireAny: true
    });
    setActionResult('');
    setSnapshotResult('');
    setSnapshotDescriptionInput('');

    if (!template.file) {
      setTemplateOutput('No configuration folder selected');
      setTemplateOutputType('error');
      return;
    }

    // prepare form data
    const form = new FormData();
    form.append('template', template.file);
    form.append('username', username);
    form.append('reservation_id', reservation_id);

    setWaitOperation(true); // disable all buttons/inputs
    setTemplateOutput('Running configurations, please wait...');
    setTemplateOutputType('wait');

    let data;

    try {
      const resp = await fetch('/api/validator/runTemplate', {
        method: 'POST',
        body: form
      });

    try {
        // try parse JSON response if possible
        data = await resp.json();
    } catch(e){
        try {
        const txt = await resp.text();
        data = { __raw_text: txt };
      } catch (_) {
        data = null;
      }
    }
      let results;

      if (resp.ok) {
        // success status code: prefer message from JSON if present
        const msg = (data && data.message) ? data.message : 'Template executed successfully';
        results = (data && typeof data.results !== 'undefined') ? data.results : '';
        setTemplateOutput(msg + '\n' + 'results: ' + results);
        setTemplateOutputType('success');
      } else {
        // non-200 code
        let errMsg = `HTTP ${resp.status}`;
        if (data) {
          if (data.message) errMsg = data.message;
          if (typeof data.results !== 'undefined') results = data.results;
        } else {
            errMsg = `HTTP ${resp.status}`;
        }
        setTemplateOutput(errMsg + '\n' + 'results: ' + results);
        setTemplateOutputType('error');
      }
    } catch (e) {
      setTemplateOutput(`Network or client error: ${e}`);
      setTemplateOutputType('error');
    } finally {
      template.reset();
      setWaitOperation(false);
    }
  };

  const handlePlaybookFile = async () => {
    handleUpload({
      descriptors: [
        {file: playbook.file, fileType: playbook.fileType, label: 'Playbook'},
      ],
      setOutput: setPlaybookOutput,
      setOutputType: setPlaybookOutputType,
      requireAny: true
    });
    setActionResult('');
    setSnapshotResult('');
    setSnapshotDescriptionInput('');

    if (!playbook.file) {
      setPlaybookOutput('No playbook file selected');
      setPlaybookOutputType('error');
      return;
    }

    // prepare form data
    const form = new FormData();
    form.append('playbook', playbook.file);
    form.append('username', username);
    form.append('reservation_id', reservation_id);

    setWaitOperation(true); // disable all buttons/inputs
    setPlaybookOutput('Running playbook, please wait...');
    setPlaybookOutputType('wait');

    let data;

    try {
      const resp = await fetch('/api/validator/runPlaybook', {
        method: 'POST',
        body: form
      });

    try {
        // try parse JSON response if possible
        data = await resp.json();
    } catch(e){
        try {
        const txt = await resp.text();
        data = { __raw_text: txt };
      } catch (_) {
        data = null;
      }
    }
      let stdout;
      let stderr;

      if (resp.ok) {
        // success status code: prefer message from JSON if present
        const msg = (data && data.message) ? data.message : 'Playbook executed successfully';
        stdout = (data && typeof data.stdout !== 'undefined') ? data.stdout : '';
        stderr = (data && typeof data.stderr !== 'undefined') ? data.stderr : '';
        setPlaybookOutput(msg + '\n' + 'stdout: ' + stdout + '\n' + 'stderr: ' + stderr);
        setPlaybookOutputType('success');
      } else {
        // non-200 code
        let errMsg = `HTTP ${resp.status}`;
        if (data) {
          if (data.message) errMsg = data.message;
          else if (data.error) errMsg = data.error;
          else if (data.__raw_text) errMsg = data.__raw_text;

          if (typeof data.stdout !== 'undefined') stdout = data.stdout;
          if (typeof data.stderr !== 'undefined') stderr = data.stderr;
        } else {
            errMsg = `HTTP ${resp.status}`;
        }
        setPlaybookOutput(errMsg + '\n' + 'stdout: ' + stdout + '\n' + 'stderr: ' + stderr);
        setPlaybookOutputType('error');
      }
    } catch (e) {
      setPlaybookOutput(`Network or client error: ${e}`);
      setPlaybookOutputType('error');
    } finally {
      playbook.reset();
      setWaitOperation(false);
    }
  };

  return (
    <div className="home-content-wrapper configuration-wrapper">
      {/* Conditional message: can be hidden by passing showWait={false} */}
      {!isAccessGranted && (
        <div className="wait-message">Wait account creation on devices...</div>
      )}

      <div className="card configuration-card">
        <h2 className="title">⚙️ Configure devices</h2>

        {/* Row for running-config download and load */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Download running-config zip:</label>
            <button type="button" className="template-button configuration-button"
                    onClick={() => downloadFile("template")} disabled={!isAccessGranted || waitOperation}>Download</button>
            <label className="label-inline">Load running-config zip:</label>
            <button type="button" className="template-button configuration-button choose-button" onClick={template.choose} disabled={!isAccessGranted || waitOperation}>Choose zip
            </button>
            <div className={`selected-file-name file-status-${template.fileType}`}>{template.fileName}</div>
            <input ref={template.ref} type="file" style={{display: 'none'}} onChange={template.onChange} disabled={!isAccessGranted || waitOperation}/>
            <button type="button" className="send-button configuration-button" onClick={handleTemplateFile} disabled={!isAccessGranted || waitOperation}>Load file
            </button>
          </div>
        </div>

        {/* Output line */}
        <div className="output-row">
          <div className="aligned-group">
            <label className="label-inline label-output">Output:</label>
            <textarea readOnly className={`output-field ${templateOutputType}`} value={templateOutput}
                      placeholder="Output will appear here after file loading"/>
          </div>
        </div>

        {/* Row for playbook download and load */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Download playbook template:</label>
            <button type="button" className="playbook-button configuration-button"
                    onClick={() => downloadFile("playbook")} disabled={!isAccessGranted || waitOperation}>Download</button>
            <label className="label-inline">Load Ansible playbook:</label>
            <button type="button" className="playbook-button configuration-button choose-button" onClick={playbook.choose} disabled={!isAccessGranted || waitOperation}>Choose
              playbook
            </button>
            <div className={`selected-file-name file-status-${playbook.fileType}`}>{playbook.fileName}</div>
            <input ref={playbook.ref} type="file" style={{display: 'none'}} onChange={playbook.onChange} disabled={!isAccessGranted || waitOperation}/>
            <button type="button" className="send-button configuration-button" onClick={handlePlaybookFile} disabled={!isAccessGranted || waitOperation}>Run playbook
            </button>
          </div>
        </div>

        {/* Output line */}
        <div className="output-row">
          <div className="aligned-group">
            <label className="label-inline label-output">Output:</label>
            <textarea readOnly className={`output-field ${playbookOutputType}`} value={playbookOutput}
                      placeholder="Output will appear here after playbook execution"/>
          </div>
        </div>

        {/* line for test */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Run ping all test:</label>
            <button type="button" className="send-button configuration-button" onClick={runTest} disabled={!isAccessGranted || waitOperation}>Run test</button>
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
              disabled={!isAccessGranted || waitOperation}
          />
          <button type="button" className="send-button configuration-button" onClick={handleTakeSnapshot} disabled={!isAccessGranted || waitOperation}>Take
            snapshot
          </button>
        </div>

        {/* Snapshot creation result line */}
        <div className={`config-row small-result ${snapshotResultType}`}>
          {snapshotResult}
        </div>

        {/* Snapshot selection and actions */}
        <div className="config-row main-actions-row">
          <div className="aligned-group-snapshot">
            <label className="label-inline">Select snapshot:</label>
            <select
                className="select-field"
                value={selectedSnapshot}
                onChange={(e) => setSelectedSnapshot(e.target.value)}
                disabled={!isAccessGranted || waitOperation}
            >
              {snapshotList.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="aligned-group-snapshot description-display-group">
            <label className="label-inline">Description:</label>
            <div className="snapshot-desc">{selectedSnapshotDescription()}</div>
          </div>

          <div className="snapshot-actions">
            <button type="button" className="rollback-button configuration-button" onClick={handleRollback} disabled={!isAccessGranted || waitOperation}>Rollback
            </button>
            <button
                type="button"
                className="delete-button delete configuration-button"
                onClick={handleDeleteSnapshot}
                disabled={!isAccessGranted || !selectedSnapshot || selectedSnapshot === 'snapshot0' || waitOperation}
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