import React, { useState, useEffect, useRef } from "react";
import "./style/llmAgent.css";

const Troubleshooter = ({ username, reservation_id }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  
  const [activeChatId, setActiveChatId] = useState(null);
  const chatEndRef = useRef(null);

  // modal window states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [safeCommandsBuffer, setSafeCommandsBuffer] = useState([]);
  const [currentContext, setCurrentContext] = useState("");
  const [commandDecisions, setCommandDecisions] = useState({});
  // chat list
  const [savedChats, setSavedChats] = useState([]);

  const [selectedFiles, setSelectedFiles] = useState([]);

  const handleFileChange = (e) => {
    const newFiles = Array.from(e.target.files || []);
    setSelectedFiles((prev) => {
      const existingFileNames = prev.map((f) => f.name);
      const uniqueNewFiles = newFiles.filter((f) => !existingFileNames.includes(f.name));
      return [...prev, ...uniqueNewFiles];
    });
    e.target.value = null;
  };

  const handleRemoveFile = (fileName) => {
    setSelectedFiles((prev) => prev.filter((f) => f.name !== fileName));
  };

  // fetch of previous sessions
  useEffect(() => {
    const fetchSessions = async () => {
      if (!username || !reservation_id) return;
      try {
        const response = await fetch(
          `/api/agent_server/sessions?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&agent_role=troubleshooter_chat`
        );
        if (response.ok) {
          const data = await response.json();
          setSavedChats(data.chat_ids || []);
        }
      } catch (err) {
        console.error("Error fetching sessions:", err);
      }
    };
    fetchSessions();
  }, [username, reservation_id]);

  const startNewChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setSelectedFiles([]);
    setError(null);
  };

  const loadHistory = async (chatId) => {
    try {
      const response = await fetch(
        `/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=troubleshooter_chat`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.messages) {
          const formattedMessages = data.messages.map((msg, index) => ({
            id: index + 1,
            role: msg.role,
            content: msg.content,
          }));
          setMessages(formattedMessages);
          setActiveChatId(chatId);
          setError(null);
        }
      }
    } catch (err) {
      console.error("Error loading history:", err);
    }
  };

  const handleDeleteChat = async (chatId, e) => {
    if(e) e.stopPropagation();
    try {
      const response = await fetch("/api/agent_server/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, reservation_id, chat_id: chatId }),
      });
      if (response.ok) {
        setSavedChats((prev) => prev.filter((id) => id !== chatId));
        if (activeChatId === chatId) startNewChat();
      }
    } catch (err) {
      console.error("Error deleting chat:", err);
    }
  };

  const handleDownloadChat = async (chatId, e) => {
    if (e) e.stopPropagation();
    try {
      const url = chatId
        ? `/api/agent_server/download?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=troubleshooter_chat`
        : `/api/agent_server/download?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&agent_role=troubleshooter_chat`;

      const response = await fetch(url);
      if (response.ok) {
        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition");
        let filename = chatId ? `troubleshooter_chat_${chatId}.zip` : `troubleshooter_all_chats.zip`;
        if (disposition) {
          const match = disposition.match(/filename="?([^"]+)"?/);
          if (match) filename = match[1];
        }
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
      }
    } catch (err) {
      console.error("Error downloading chat:", err);
    }
  };

  const handleInputChange = (e) => setInputValue(e.target.value);

  const appendMessage = (role, content) => {
    setMessages((prev) => [...prev, { id: prev.length + 1, role, content }]);
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    const textToSend = inputValue.trim();
    if (!textToSend && selectedFiles.length === 0) return;

    setError(null);

    if (textToSend || selectedFiles.length > 0) {
       appendMessage("user", textToSend || "[Attached file]");
    }

    setInputValue("");
    setIsSending(true);

    try {
      const formData = new FormData();
      formData.append("message", textToSend);
      if (username) formData.append("username", username);
      if (reservation_id) formData.append("reservation_id", reservation_id);
      if (activeChatId) formData.append("chat_id", activeChatId);

      selectedFiles.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/agent_server/troubleshooter/chat", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Errore chiamata Backend");
      const data = await response.json();

      if (data.chat_id && !activeChatId) {
        setActiveChatId(data.chat_id);
        setSavedChats((prev) => [data.chat_id, ...prev]);
      }

      setSelectedFiles([]);

      // check if diagnostic_intent requires more information
      if (data.requires_approval) {
        setPendingCommands(data.commands);
        setSafeCommandsBuffer(data.safe_commands || []);
        setCurrentContext(data.context || "");
        setIsModalOpen(true);
        setCommandDecisions({});
        
      } else {
        appendMessage("assistant", data.reply);
      }
    } catch (err) {
      setError(err.message || "Unexpected error");
    } finally {
      setIsSending(false);
    }
  };

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

  const handleSubmitApproval = async () => {
    setIsModalOpen(false);
    setIsSending(true);

    const userApprovedCommands = pendingCommands.filter((_, idx) => commandDecisions[idx] === "accepted");
    const finalCommandsToExecute = [...safeCommandsBuffer, ...userApprovedCommands];

    try {
      const response = await fetch("/api/agent_server/troubleshooter/execute_approved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approved_commands: finalCommandsToExecute,
          context: currentContext,
          username: username,
          reservation_id: reservation_id,
          chat_id: activeChatId
        }),
      });

      if (!response.ok) throw new Error("Error during command execution");
      
      const data = await response.json();
      appendMessage("assistant", data.reply);
      
    } catch (err) {
      setError("Error during command execution");
    } finally {
      setIsSending(false);
    }
  };

  const renderMessage = (message) => {
    const isUser = message.role === "user";
    let displayContent = message.content;

    if (isUser && typeof displayContent === "string" && displayContent) {
      const fileRegex = /<attached_file name="([^"]+)">[\s\S]*?<\/attached_file>/g;
      displayContent = displayContent.replace(fileRegex, "\n[Attached file: $1]\n");
    }

    return (
      <div key={message.id} className={`en-message-bubble ${isUser ? 'en-message-user' : 'en-message-assistant'}`}>
        <div className="en-message-role">{isUser ? username : "Troubleshooter Agent"}</div>
        <div className="en-message-content">{displayContent}</div>
      </div>
    );
  };

  return (
    <div className="experiment-negotiation-container">
      <div className="experiment-negotiation-header">
        <h1>Diagnostic Troubleshooter</h1>
      </div>

      <div className="experiment-negotiation-main">
        <div className="experiment-negotiation-sidebar">
          <button className="en-new-chat-btn" onClick={startNewChat} disabled={isSending}>New Chat</button>
          {savedChats.length > 0 && (
            <div className="en-add-files-row">
              <span className="en-download-label">Download all sessions</span>
              <button
                className="en-download-chat-btn"
                onClick={(e) => handleDownloadChat(null, e)}
                title="Download All Chats"
                disabled={isSending}
              >
                <img src="/downloadButton.png" alt="Download" className="en-download-icon-img" />
              </button>
            </div>
          )}

          <div className={isSending ? 'sidebar-disabled' : ''}>
            <h3 className="sidebar-title">Recent Chats</h3>
            {savedChats.length === 0 ? (
              <p className="en-sidebar-empty">No previous conversations.</p>
            ) : (
              <ul className="en-chat-list">
                {savedChats.map((chatId, index) => (
                  <li key={chatId} className="en-chat-item-container">
                    <button className="en-download-chat-btn" onClick={(e) => handleDownloadChat(chatId, e)} title="Download Chat Logs" disabled={isSending}>
                      <img src="/downloadButton.png" alt="Download" className="en-download-icon-img" />
                    </button>
                    <button
                      className={`en-chat-list-btn ${activeChatId === chatId ? "active" : ""}`}
                      onClick={() => loadHistory(chatId)}
                      disabled={isSending}
                    >
                      Session {savedChats.length - index}
                    </button>
                    <button
                      className="en-delete-chat-btn"
                      onClick={(e) => handleDeleteChat(chatId, e)}
                      disabled={isSending}
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

        <div className="experiment-negotiation-chat">
          <div className="en-chat-window">
            {messages.map(renderMessage)}
            {isSending && (
              <div className="en-message-bubble en-message-assistant">
                <div className="en-message-role">Troubleshooter Agent</div>
                <div className="en-message-content">Analyzing testbed, please wait...</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form className="en-input-area" onSubmit={handleSubmit} autoComplete="off">
            <div className="en-files-row">
              <div className="en-add-files-row">               
                <input id="en-file-input"  type="file"  disabled={isSending} multiple onChange={handleFileChange} className="en-file-input-hidden"/>
                <button type="button" className={`en-file-button ${isSending ? 'en-send-button-disabled' : ''}`} disabled={isSending}
                  onClick={() => {
                    const input = document.getElementById("en-file-input");
                    if (input) input.click();
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
                      <button type="button" className="en-file-remove" onClick={() => handleRemoveFile(f.name)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="en-input-row">
              <textarea
                className="en-textarea"
                value={inputValue}
                onChange={handleInputChange}
                placeholder="E.g., Verify if h1 can ping h2 or check BGP on sw1..."
                rows={3}
                disabled={isSending}
              />
              <button
                type="submit"
                className={`en-send-button ${((!inputValue.trim() && selectedFiles.length === 0) || isSending) ? "en-send-button-disabled" : ""}`}
                disabled={(!inputValue.trim() && selectedFiles.length === 0) || isSending}
              >
                <span className="en-send-icon">↑</span>
              </button>
            </div>
            {error && <div className="en-error-message">{error}</div>}
          </form>
        </div>
      </div>

      {/* Approval modal */}
      {isModalOpen && (
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
                onClick={handleSubmitApproval}
                disabled={!isAllDecided}>
                Confirm selection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Troubleshooter;