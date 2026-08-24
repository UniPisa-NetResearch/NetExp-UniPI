import React from "react";

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
    mode, // "llmagent" or "troubleshooter"
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
                        <div className="en-troubleshooter-progress">
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