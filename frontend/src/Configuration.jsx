// Configuration.jsx
import React, {useState, useRef, useEffect} from 'react';
import './style/style.css';
import './style/configuration.css';

// apiClient.js (esempi)
export async function submitPlaybook({ username, reservation_id, playbookFile, templateFile=null}) {
  const url = `/api/validator/submitPlaybook`;
  const fd = new FormData();
  fd.append("username", username);
  if (reservation_id) fd.append("reservation_id", reservation_id);
  fd.append("playbook", playbookFile); // required
  if (templateFile) fd.append("template", templateFile);

  const resp = await fetch(url, {
    method: "POST",
    body: fd
  });

  if (resp.status === 202) {
    const data = await resp.json();
    return { ok: true, job_id: data.job_id, message: data.message };
  } else {
    const err = await resp.json();
    return { ok: false, message: err.message || "Upload failed" };
  }
}

export async function getJobStatus(jobId) {
  const resp = await fetch(`/api/validator/jobStatus?job_id=${encodeURIComponent(jobId)}`);
  if (!resp.ok) {
    return { ok: false, message: `HTTP ${resp.status}` };
  }

  return await resp.json(); // contains status and possibly result
}

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

export default function Configuration({username, reservation_id}) {
  // files: playbook, template and test files
  const template = useFileInput(['.zip']);
  const playbook = useFileInput(['.yml', '.yaml']);
  // template output
  const [templateOutput, setTemplateOutput] = useState('');
  const [templateOutputType, setTemplateOutputType] = useState(''); // 'success' |'error'
  // playbook output
  const [playbookOutput, setPlaybookOutput] = useState('');
  const [playbookOutputType, setPlaybookOutputType] = useState(''); // 'success' |'error'
  // test execution output
  const [testOutput, setTestOutput] = useState('');
  const [testOutputType, setTestOutputType] = useState(''); // 'success' | 'error'

  // snapshot management
  const [snapshotList, setSnapshotList] = useState([{ name: 'snapshot0', description: 'Original network state, no configurations applied' },]);
  const [selectedSnapshot, setSelectedSnapshot] = useState('snapshot0');
  const [snapshotDescriptionInput, setSnapshotDescriptionInput] = useState('');
  const [snapshotResult, setSnapshotResult] = useState('');
  const [snapshotResultType, setSnapshotResultType] = useState(''); // 'success' | 'error'

  // result for rollback/delete
  const [actionResult, setActionResult] = useState('');
  const [actionResultType, setActionResultType] = useState(''); // 'success' | 'error'
  // unlock functionalities when account creation is completed
  const [isAccessGranted, setIsAccessGranted] = useState(false);

const [jobId, setJobId] = useState(null);
const [polling, setPolling] = useState(false);

const downloadFile= async (file_type) =>{
  console.log("file type: ", file_type);

  if (file_type === "playbook") {
    try {
      const payload = { reservation_id: reservation_id };

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
      console.log("after download");
      // remove URL to free memory
      window.URL.revokeObjectURL(url);
      setPlaybookOutput(`Downloaded playbook: ${filename}`);
      setPlaybookOutputType("success");
    } catch (e) {
      setPlaybookOutput(`Error: ${e}`);
      setPlaybookOutputType("error");
    }
  }
}

const runTest = () =>{
   console.log("run test");
}
const submitConfiguration = async () => {

  setPlaybookOutput("Job queued, waiting for worker...");
  setPlaybookOutputType(""); // neutral or 'info'
  const resp = await submitPlaybook({
    username,
    reservation_id: reservation_id,
    playbookFile: playbook.file,
  });
  if (!resp.ok) {
    setPlaybookOutput(`Error: ${resp.message}`);
    setPlaybookOutputType('error');
    return;
  }
  setJobId(resp.job_id);
  // start polling
  startPollingJob(resp.job_id, setPlaybookOutput, setPlaybookOutputType, setPolling);
};

// funzione di polling semplice
function startPollingJob(jobId, setOutput, setOutputType, setPolling) {
  if (!jobId) return;
  setPolling(true);
  const interval = 3000; // 3s
  const pid = setInterval(async () => {
    try {
      const res = await getJobStatus(jobId);
      if (res.status === 'finished' && res.result) {
        const r = res.result;
        setOutput(`Return code: ${r.rc}\n\nSTDOUT:\n${r.stdout}\n\nSTDERR:\n${r.stderr}`);
        setOutputType(r.rc === 0 ? 'success' : 'error');
        clearInterval(pid);
        setPolling(false);
      } else if (res.status === 'failed') {
        setOutput(`Job failed!`);
        setOutputType('error');
        clearInterval(pid);
        setPolling(false);
      }
    } catch (e) {
      setOutput(`Error retrieving job status: ${e.message}`);
      setOutputType('error');
      clearInterval(pid);
      setPolling(false);
    }
  }, interval);
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

    if (!ok) {
      // handleUpload has set the error
      return;
    }

    setTemplateOutputType('Job queued, waiting for worker...');
    setTemplateOutput('');

    await submitConfiguration({username, reservation_id, templateFile: template.file || null});

  };

  const handlePlaybookFile = () => {
    handleUpload({
      descriptors: [
        { file: playbook.file, fileType: playbook.fileType, label: 'Playbook' },
      ],
      setOutput: setPlaybookOutput,
      setOutputType: setPlaybookOutputType,
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

        {/* Row for running-config download and load */}
        <div className="config-row main-actions-row">
          <div className="aligned-group">
            <label className="label-inline">Download running-config zip:</label>
            <button type="button" className="template-button configuration-button"
                    onClick={() => downloadFile("template")} disabled={!isAccessGranted}>Download</button>
            <label className="label-inline">Load running-config zip:</label>
            <button type="button" className="template-button configuration-button choose-button" onClick={template.choose} disabled={!isAccessGranted}>Choose zip
            </button>
            <div className={`selected-file-name file-status-${template.fileType}`}>{template.fileName}</div>
            <input ref={template.ref} type="file" style={{display: 'none'}} onChange={template.onChange} disabled={!isAccessGranted}/>
            <button type="button" className="send-button configuration-button" onClick={handleTemplateFile} disabled={!isAccessGranted}>Load file
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
                    onClick={() => downloadFile("playbook")} disabled={!isAccessGranted}>Download</button>
            <label className="label-inline">Load Ansible playbook:</label>
            <button type="button" className="playbook-button configuration-button choose-button" onClick={playbook.choose} disabled={!isAccessGranted}>Choose
              playbook
            </button>
            <div className={`selected-file-name file-status-${playbook.fileType}`}>{playbook.fileName}</div>
            <input ref={playbook.ref} type="file" style={{display: 'none'}} onChange={playbook.onChange} disabled={!isAccessGranted}/>
            <button type="button" className="send-button configuration-button" onClick={handlePlaybookFile} disabled={!isAccessGranted}>Run playbook
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
            <button type="button" className="send-button configuration-button" onClick={runTest} disabled={!isAccessGranted}>Run test</button>
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
          <div className="aligned-group-snapshot">
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

          <div className="aligned-group-snapshot description-display-group">
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