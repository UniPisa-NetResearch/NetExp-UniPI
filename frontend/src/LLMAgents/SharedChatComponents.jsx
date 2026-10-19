import React, {useState} from "react";
import ReactMarkdown from "react-markdown";

 // render structured JSON responses in a readable key/value layout
export const renderStructuredContent = (parsed) => {
  // list of fields to show without numbers
  const plainCommandFields = ["execution_plan", "verification", "executable_plan", "verification_plan"];
  // list of fields that use markdown
  const markdownFields = ["summary", "topology_diagram", "report", "context", "context_for_planning"];
  return (
    <div>
      {Object.entries(parsed).map(([key, value]) => (
        <div key={key} className="en-backend-message">
          {/* convert keys into readable section labels */}
          <strong className="en-backend-message-header"> {key.replace(/_/g, " ")} </strong>
          {/* add None for empty arrays or a list of items */}
          {markdownFields.includes(key) ? (
              <div className="en-markdown-layout">
                <ReactMarkdown>{String(value)}</ReactMarkdown>
              </div>
          ) :Array.isArray(value) ? (
            value.length === 0 ? (
              <p className="en-backend-message-key">None</p>
            ) : plainCommandFields.includes(key) ? (
              <div className="en-backend-message-list-plain">
                {value.map((item, i) => (
                  <div key={i} className="en-backend-message-list-element">{typeof item === "string" ? item.trimStart() : item}</div>
                ))}
              </div>
            ) : (
              <div className="en-backend-message-numbered-list">
                {value.map((item, i) => (
                  <div key={i} className="en-backend-message-numbered-row">
                    <span className="en-backend-message-number">{i + 1}.</span>
                    <span className="en-backend-message-list-element">{typeof item === "string" ? item.trimStart() : item}</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="en-backend-message-key">{String(value)}</div>
          )}
        </div>
      ))}
    </div>
  );
};

export const processSafetyHistory = (rawMessages, safetyIterations = 3) => {
  // counter for consecutive rejected safety messages
  let rejectedCount = 0;
  
  return rawMessages.filter(m => {
    // show all negotiation phase messages
    if (m.agent_phase === "negotiation") return true;
    // show all interactive messages except safety messages
    if (m.agent_phase === "interactive_negotiator" || m.agent_phase == "safe_interactive_negotiator" || m.agent_phase === "interactive_reporter") return true;
    // show only assistant messages for execution phase
    if (m.agent_phase === "execution" && m.role === "assistant") return true;
    // show only approved or last rejected assistant message for safety phase
    if (m.agent_phase === "safety" && m.role === "assistant") {

      try {
        const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        const status = String(parsed.status).toUpperCase();
        
        if (status.includes("REJECTED")) {
            
          rejectedCount++;
            
            // if we reached N rejected messages, we show the message generated in the last turn
            if (rejectedCount === safetyIterations) {
                rejectedCount = 0; 
                return true;
            }
            
            // otherwise, hide previous failed messages
            return false;
        
          } else if (status.includes("AWAITING_DEVICE_READ")) {

            // remove reading command messages
            return false;
      
        } else {
            
          // if status is APPROVED or AWAITING_CLARIFICATIONS, the message is shown and reset the counter
            rejectedCount = 0;
            return true;
        }
      } catch (e) {
          return true;
      }
    }

    // fallback for messagges without agent_phase tag
    if (!m.agent_phase) return true; 
    
    // do not show other messages as default
    return false;

  }).map(m => {
    
    // filter safety messages, get only specific fields
    if (m.agent_phase === "safety" && m.role === "assistant") {
      
      try {
        const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
        
        // get only relevant fields
        const filtered = {
          status: parsed.status,
          executable_plan: parsed.executable_plan || [],
          verification_plan: parsed.verification_plan || []
        };
        
        // get issues from last rejected message (at this point there is at most only a rejected message)
        if (String(parsed.status).toUpperCase().includes("REJECTED") && parsed.issues) {
          filtered.issues = parsed.issues;
        }
        
        // get clarifying questions if present
        if (parsed.clarifying_questions && parsed.clarifying_questions.length > 0) {
          filtered.clarifying_questions = parsed.clarifying_questions;
        }
        
        return { ...m, content: JSON.stringify(filtered) };

      } catch (e) {
        return m;
      }
    }
    return m;
  }).map((m, i) => ({...m, id: m.id || `hist-${i}`}));
};

export const CommandApprovalModal = ({ 
  isOpen, 
  pendingCommands, 
  commandDecisions, 
  setCommandDecisions, 
  onSubmitApproval 
}) => {
  if (!isOpen) return null;

  const handleApproveAll = () => {
    const allDecided = {};
    pendingCommands.forEach((_, i) => allDecided[i] = "accepted");
    setCommandDecisions(allDecided);
  };

  const handleRejectAll = () => {
    const allDecided = {};
    pendingCommands.forEach((_, i) => allDecided[i] = "rejected");
    setCommandDecisions(allDecided);
  };

  // check if user has selected an option for every command
  const isAllDecided = pendingCommands.length > 0 && Object.keys(commandDecisions).length === pendingCommands.length;

  return (
    <div className="en-modal-overlay">
      <div className="en-modal-content">
        <div className="en-modal-header">
          <h3>Necessary Command Approval</h3>
          <p>The Agent requested commands that are not included in the whitelist. <strong>Select a choice for every command</strong> to continue.</p>
          <div className="en-modal-all-button">
            <button onClick={handleApproveAll} className="en-btn-accept">Accept all</button>
            <button onClick={handleRejectAll} className="en-btn-reject">Reject all</button>
          </div>
        </div>
        
        <ul className="en-command-approval-list">
          {pendingCommands.map((cmdString, idx) => (
            <li key={idx} className="en-command-approval-item">
              <span className="en-command-text">{cmdString}</span>
              <div className="en-command-actions">
                <button 
                  className={`en-btn-accept ${commandDecisions[idx] === 'accepted' ? 'active' : ''}`}
                  onClick={() => setCommandDecisions({...commandDecisions, [idx]: 'accepted'})}>
                  Accept
                </button>
                <button 
                  className={`en-btn-reject ${commandDecisions[idx] === 'rejected' ? 'active' : ''}`}
                  onClick={() => setCommandDecisions({...commandDecisions, [idx]: 'rejected'})}>
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
        
        <div className="en-modal-footer">
          <button 
            className={`en-btn-confirm ${!isAllDecided ? "en-send-button-disabled" : ""}`}
            onClick={onSubmitApproval}
            disabled={!isAllDecided}>
            Confirm selection
          </button>
        </div>
      </div>
    </div>
  );
};
  
// common wrapper component for execution log and code fragments in agent messages
export const CollapsibleMessageWrapper = ({ title, btnTextOpen, btnTextClosed, wrapperClass, renderContent }) => {
  const [allOpen, setAllOpen] = useState(false);

  const toggleAll = (e) => {
    e.preventDefault();
    setAllOpen(!allOpen);
  };

  return (
    <div className={`en-message-bubble ${wrapperClass}`}>
      <div className="en-message-role en-message-role-header">
        <span>{title}</span>
        <button 
          onClick={toggleAll} 
          className="en-toggle-all-btn" 
          title={allOpen ? btnTextClosed : btnTextOpen}
        >
          {allOpen ? btnTextClosed : btnTextOpen}
        </button>
      </div>
      <div className="en-message-content">
        {renderContent(allOpen)}
      </div>
    </div>
  );
};

export const ExecutionLogViewer = ({ message }) => {

  // divide report with a delimiter
  const reports = message.content.split(/[\r\n]*-{20,}[\r\n]*/).filter(Boolean);
  
  return (
    <CollapsibleMessageWrapper
      title="Device Execution Logs"
      btnTextOpen="Open all commands"
      btnTextClosed="Close all commands"
      wrapperClass="en-message-assistant en-message-execution-report"
      renderContent={(allOpen) =>
        reports.map((report, idx) => {
          // separate command from the output
          const splitIndex = report.indexOf('===');
          if (splitIndex === -1) {
            return (
              <details key={idx} className="en-execution-log-details" open={allOpen}>
                <summary>
                  <span className="en-execution-icon">▶</span>
                </summary>
                <pre>{report}</pre>
              </details>
            );
          }
          // first part is associated to real command
          const cmdPart = report.substring(0, splitIndex).trim();
          // second part after the three characters (===) is the output of the command
          let outputPart = report.substring(splitIndex + 3).trim();
          // filter ansible execution status from the output
          outputPart = outputPart.replace(/\[SUCCESS]:?[ \t]*\n?/g, '').replace(/\[FAILED: Return code \d+\][ \t]*\n?/g, '').replace(/\[STDOUT]:[ \t]*\n?/g, '').replace(/\[STDERR]:[ \t]*\n?/g, '').replace(/===[ \t]*/g, '').trim();
          
          return (
            <details key={idx} className="en-execution-log-details" open={allOpen}>
              <summary><span className="en-execution-icon">▶</span>{cmdPart}</summary>
              <pre>{outputPart}</pre>
            </details>
          );
        })
      }
    />
  );
};


// common sidebar with previous chats
export const ChatSidebar = ({savedChats, activeChatId, isSending, disableListActions, onNewChat, onDownloadChat, onLoadHistory, onDeleteChat, sessionLabel = "Session"}) => {
  return (
    <div className={`experiment-negotiation-sidebar ${isSending ? 'sidebar-disabled' : ''}`}>
      <button className="en-new-chat-btn" onClick={onNewChat} disabled={isSending}>
        New Chat
      </button>

      {savedChats.length > 0 && (
        <div className="en-add-files-row">
          <span className="en-download-label">Download all sessions</span>
          <button
            className="en-download-chat-btn"
            onClick={(e) => onDownloadChat(null, e)}
            title="Download All Chats"
            disabled={disableListActions || isSending}
          >
            <img src="/downloadButton.png" alt="Download" className="en-download-icon-img" />
          </button>
        </div>
      )}

      <div className={disableListActions ? 'sidebar-disabled' : ''}>
        <h3 className="sidebar-title">Recent Chats</h3>
        {savedChats.length === 0 ? (
          <p className="en-sidebar-empty">No previous conversations.</p>
        ) : (
          <ul className="en-chat-list">
            {savedChats.map((chatId, index) => (
              <li key={chatId} className="en-chat-item-container">
                <button 
                  className="en-download-chat-btn" 
                  onClick={(e) => onDownloadChat(chatId, e)} 
                  title="Download Chat Logs" 
                  disabled={isSending}
                >
                  <img src="/downloadButton.png" alt="Download" className="en-download-icon-img" />
                </button>
                <button
                  className={`en-chat-list-btn ${activeChatId === chatId ? "active" : ""}`}
                  onClick={() => onLoadHistory(chatId)}
                  disabled={disableListActions || isSending}
                >
                  {sessionLabel} {savedChats.length - index}
                </button>
                <button
                  className="en-delete-chat-btn"
                  onClick={(e) => onDeleteChat(chatId, e)}
                  disabled={disableListActions || isSending}
                  title="Delete Chat"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

// file uploader section
export const FileUploader = ({selectedFiles, isInputDisabled, onFileChange, onRemoveFile}) => {
  return (
    <div className="en-files-row">
      <div className="en-add-files-row">               
        <input 
          id="en-file-input" 
          type="file" 
          disabled={isInputDisabled} 
          multiple 
          onChange={onFileChange} 
          className="en-file-input-hidden"
        />
        <button 
          type="button" 
          className={`en-file-button ${isInputDisabled ? 'en-send-button-disabled' : ''}`} 
          disabled={isInputDisabled}
          onClick={() => {
              const input = document.getElementById("en-file-input");
              if (input) {input.click();}
          }}
        >
          +
        </button>
        <span className="en-file-label">Add files</span> 
      </div>
      
      {selectedFiles.length > 0 && (
          <div className="en-file-list">
              {selectedFiles.map((f) => (
                  <span key={f.name} className="en-file-pill">
                      <span className="en-file-name">{f.name}</span>
                      <button
                          type="button"
                          className="en-file-remove"
                          onClick={() => onRemoveFile(f.name)}
                      >
                          ×
                      </button>
                  </span>
              ))}
          </div>
      )}
    </div>
  );
};

export const ChatHeader = ({ title, availableModels, selectedModel, onModelChange, isDisabled}) => {
  return (
    <div className="experiment-negotiation-header">
      <h1>{title}</h1>
      
      {availableModels && availableModels.length > 0 && (
        <div className="en-model-container">
          <label className="en-model-label">Select LLM Model:</label>
          <select
            className="en-model-select"
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={isDisabled}
          >
            {availableModels.map(m => (<option key={m} value={m}>{m}</option>))}
          </select>
        </div>
      )}
    </div>
  );
};

export const UniversalPipelineChat = ({
    mode, // "llmagent" or "diagnosticassistant"
    chat, title, phases, currentProgressPhase, activeReasoning, isChatLocked,
    executionMode, setExecutionMode, onRollback, onSubmit, formatPhaseName,
    renderMessage, negotiationQuestions = [], negotiationAnswers = {},
    setNegotiationAnswers, sessionLabel = "Session", startNewChat, isRollingBack,
    isButtonDisabled, handleDownloadChat, handleDeleteChat, isPendingRetry, onRetryPlanning, 
    onTerminateExperiment, inputPlaceholder, onLoadHistory, chatEndRef, reasoningRef
    
  }) => {
    
    return (
      <div className="experiment-negotiation-container">
        <ChatHeader 
          title={title}
          availableModels={chat.availableModels}
          selectedModel={chat.selectedModel}
          onModelChange={chat.setSelectedModel}
          isDisabled={chat.isSending || isChatLocked}
        />
  
        <div className="experiment-negotiation-main">
          <ChatSidebar
            savedChats={chat.savedChats}
            activeChatId={chat.activeChatId}
            isSending={chat.isSending}
            disableListActions={false}
            onNewChat={startNewChat}
            onDownloadChat={handleDownloadChat}
            onLoadHistory={onLoadHistory ? onLoadHistory : ((id) => chat.loadHistory(id))}
            onDeleteChat={handleDeleteChat}
            sessionLabel={sessionLabel}
          />
  
          <div className="experiment-negotiation-chat">
            <div className="en-chat-window">
              {isRollingBack ? (
                <div className="en-message-bubble en-message-assistant">
                  <div className="en-message-role">System</div>
                  <div className="en-message-content">**[System]** Rollback execution on the testbed. Please wait...</div>
                </div>
              ) : (
                <>
                  {chat.messages.map(renderMessage)}
                  
                  {/* streaming progress */}
                  {chat.isSending && currentProgressPhase && phases && phases.length > 0 && (
                    <div className="en-message-bubble en-message-assistant en-progress-bubble">
                      <div className="en-message-role">System Agent</div>
                      <div className="en-message-content">
                        <p className="en-progress-title">
                          Processing phase, please wait...
                        </p>
                        <div className="en-diagnostic-assistant-progress">
                          {phases.map((phaseKey, idx) => {
                            const currentIndex = phases.indexOf(currentProgressPhase);
                            const isActive = idx === currentIndex;
                            const isCompleted = idx < currentIndex;
                            return (
                              <div key={idx} className={`en-progress-item ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}>
                                <span className="en-progress-icon">
                                  {isCompleted ? '✓' : isActive ? '●' : '○'}
                                </span>
                                <span className="en-progress-text">{formatPhaseName(phaseKey, idx)}</span>
                              </div>
                            );
                          })}
                        </div>
                        {/* real-time reasoning box */}
                        {activeReasoning && (
                          <div className="en-reasoning-box">
                            <div className="en-reasoning-box-header">
                              Agent Thinking Stream:
                            </div>
                            <div className="en-reasoning-box-content" ref={reasoningRef}>
                              {activeReasoning}
                              <span>▌</span>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
              <div ref={chatEndRef} />
            </div>
  
            <form className="en-input-area" onSubmit={onSubmit} autoComplete="off">
              <div className="en-input-actions-wrapper">
                <FileUploader
                  selectedFiles={chat.selectedFiles}
                  isInputDisabled={isChatLocked || chat.isSending}
                  onFileChange={chat.handleFileChange}
                  onRemoveFile={chat.handleRemoveFile}
                />
  
                {/* specific controls for LLMAgent mode */}
                {mode === 'llmagent' && (
                  <div className="en-execution-toggle-container">
                    {/* if the execution is failed, show inline buttons */}
                    {isPendingRetry && (
                        <div className="en-execution-button-container">
                            <button type="button" className="en-transition-btn en-secondary-transition-btn en-execution-button" onClick={onTerminateExperiment}>
                                Terminate Experiment
                            </button>
                            <button type="button" className="en-transition-btn en-primary-transition-btn en-execution-button" onClick={onRetryPlanning}>
                                Retry Planning
                            </button>
                        </div>
                    )}
                    <div className="en-rollback-button-container">
                      <button 
                        type="button"
                        className="en-transition-btn en-rollback-button" 
                        onClick={onRollback}
                        disabled={chat.isSending}
                      >
                        Rollback
                      </button>
                    </div>
                    <span className="en-toggle-label">Execution:</span>
                    <label className="en-switch">
                      <input
                        type="checkbox"
                        checked={executionMode === 'parallel'}
                        disabled={isChatLocked || chat.isSending}
                        onChange={(e) => setExecutionMode(e.target.checked ? 'parallel' : 'serial')}
                      />
                      <span className="en-slider"></span>
                    </label>
                    <span className={`en-toggle-status ${executionMode === 'parallel' ? 'parallel' : ''}`}>{executionMode === 'parallel' ? 'Parallel' : 'Serial'}</span>
                  </div>
                )}
              </div>
  
              <div className="en-input-row">
                {/* specific negotiation form for LLMAgent */}
                {mode === 'llmagent' && negotiationQuestions.length > 0 && !isChatLocked ? (
                  <div className="en-questions-form">
                    {negotiationQuestions.map((q, i) => (
                      <div key={i} className="en-question-item">
                        <label className="en-question-label">{i + 1}. {q}</label>
                        <textarea 
                          className="en-question-input"
                          value={negotiationAnswers[i] || ""} 
                          onChange={(e) => setNegotiationAnswers({...negotiationAnswers, [i]: e.target.value})}
                          placeholder="Type your answer here..."
                          rows={1}
                          disabled={chat.isSending}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <textarea
                    className="en-textarea"
                    value={chat.inputValue}
                    onChange={(e) => chat.setInputValue(e.target.value)}
                    placeholder={inputPlaceholder}
                    rows={3}
                    disabled={isChatLocked || chat.isSending}
                  />
                )}
                <button
                  type="submit"
                  className={`en-send-button ${isButtonDisabled ? "en-send-button-disabled" : ""}`}
                  disabled={isButtonDisabled}
                  aria-label="Send"
                >
                  <span className="en-send-icon">↑</span>
                </button>
              </div>
              {chat.error && <div className="en-error-message">{chat.error}</div>}
            </form>
          </div>
        </div>
      </div>
    );
  };