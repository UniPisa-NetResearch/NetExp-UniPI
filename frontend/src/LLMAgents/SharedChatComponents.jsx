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