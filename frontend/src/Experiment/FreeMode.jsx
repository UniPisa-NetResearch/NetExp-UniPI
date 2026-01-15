// FreeMode.jsx
import React from 'react';

export default function FreeMode({
    experimentDescription,
    freePlaybookFiles,
    setFreePlaybookFiles,
    freeModeFileRef,
    templateValidation,
    setTemplateValidation,
    runningExperiment,
    waitOperation,
    setWaitOperation,
    reservation_id,
    refreshExperiments,
    createDownload
}) {
    const [selectedFileName, setSelectedFileName] = React.useState('');
    const [fileExtensionValid, setFileExtensionValid] = React.useState(true);
    // download experiment template
    const downloadExperimentTemplate = async () => {
        setWaitOperation(true);
        try {
            const response = await fetch(`http://localhost:5004/api/experimenter/downloadTemplate`, {
                method: 'GET',
            });

            if (!response.ok) {
                console.error('Failed to download template');
            }

            const blob = await response.blob();
            createDownload(blob, 'experiment_template_package.zip');
        } catch (error) {
            console.error('Error downloading template:', error);
        } finally {
            setWaitOperation(false);
        }
    };
    // add loaded playbook files to the list
    const handleFreePlaybookFiles = (e) => {
        const files = Array.from(e.target.files || []);

        const validFiles = files.filter(f => {
            const name = f.name.toLowerCase();
            return name.endsWith('.yml') || name.endsWith('.yaml');
        });

        setFreePlaybookFiles(prev => [...prev, ...validFiles]);
        e.target.value = null;
    };
    // remove a loaded playbook from the list
    const removeFreePlaybookFile = (index) => {
        setFreePlaybookFiles(prev => prev.filter((_, i) => i !== index));

    };

    const chooseFreePlaybooks = () => {
        freeModeFileRef.current?.click();
    };
    // validate loaded template
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
                setTemplateValidation({ message: 'Template and playbook loaded', type: 'success' });
                await refreshExperiments();
            } else {
                let errorMsg = 'Invalid format';
                if (data.error === 'missing_playbooks') {
                    errorMsg = `Missing playbooks: ${data.missing.join(', ')}`;
                } else if (data.details) {
                    errorMsg = data.details;
                }

                setTemplateValidation({ message: errorMsg, type: 'error' });
            }
        } catch (error) {
            console.error('Error validating template:', error);
            setTemplateValidation({ message: 'Validation error', type: 'error' });
        } finally {
            setWaitOperation(false);
        }
    };
    // validate template when loading it
    const handleExperimentDescriptionChange = (e) => {
        const f = e.target.files[0] || null;

        if (!f) {
            setSelectedFileName('');
            setFileExtensionValid(true);
            setTemplateValidation({ message: '', type: '' });
            experimentDescription.onChange(e);
            return;
        }

        const nameLower = f.name.toLowerCase();
        const isValid = ['.yml', '.yaml'].some(ext => nameLower.endsWith(ext));

        setSelectedFileName(f.name);
        setFileExtensionValid(isValid);

        experimentDescription.onChange(e);
    };

    return (
        <div className="experiment-section mode-content">
            <div className="section-content">
                <div className="config-row">
                    <label className="label-inline label-fixed-width">Download description template package:</label>
                    <button type="button" className="template-button configuration-button"
                            onClick={downloadExperimentTemplate} disabled={runningExperiment || waitOperation}>Download
                    </button>
                    <label className="label-inline label-fixed-width additional-margin">Load experiment description:</label>
                    <button type="button" className="template-button configuration-button choose-button"
                            onClick={() => document.getElementById('experiment_description_input').click()} disabled={runningExperiment || waitOperation}>Choose
                        description
                    </button>
                    <input id="experiment_description_input" type="file" style={{display: 'none'}}
                           accept=".yml,.yaml"
                           onChange={handleExperimentDescriptionChange}
                           disabled={runningExperiment}/>


                    <span className={`selected-filename ${fileExtensionValid ? 'valid-extension ' : 'invalid-extension'} ${!selectedFileName ? 'hidden' : ''}`} >{selectedFileName}</span>

                    <button
                        type="button"
                        className="configuration-button send-button upload-button"
                        onClick={() => validateExperimentTemplate(experimentDescription.file)}
                        disabled={runningExperiment || waitOperation || !experimentDescription.file}
                    >
                        Upload Template
                    </button>

                </div>

                <div className="config-row">
                    <label className="label-inline label-fixed-width">Load playbooks:</label>
                    <button type="button" className="playbook-button configuration-button choose-button"
                            onClick={chooseFreePlaybooks} disabled={runningExperiment || waitOperation}>Choose playbooks
                    </button>
                    <input ref={freeModeFileRef} type="file" multiple accept=".yml,.yaml"
                           style={{display: 'none'}} onChange={handleFreePlaybookFiles}
                           disabled={runningExperiment}/>
                    {templateValidation.message && (
                        <span className={`validation-message ${templateValidation.type}`}>
                            {templateValidation.message}
                        </span>
                    )}
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
    );
}