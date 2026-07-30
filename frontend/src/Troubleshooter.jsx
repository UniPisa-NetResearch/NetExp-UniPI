import React, { useState, useEffect, useRef } from "react";
import "./style/llmAgent.css";

import { ChatSidebar, FileUploader, ChatHeader } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequest } from "./LLMAgents/useAgentChat";

const Troubleshooter = ({ username, reservation_id }) => {
  const chat = useAgentChat(username, reservation_id, "troubleshooter_chat");
  const chatEndRef = useRef(null);

  // modal window states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [safeCommandsBuffer, setSafeCommandsBuffer] = useState([]);
  const [currentContext, setCurrentContext] = useState("");
  const [commandDecisions, setCommandDecisions] = useState({});
  
  // fetch of previous sessions
  useEffect(() => {

    chat.fetchSessions();

  }, [chat.fetchSessions]);

  const startNewChat = () => chat.resetBaseChat();

  const handleDeleteChat = (chatId, e) => {
    
    if(e) e.stopPropagation();

    chat.deleteChat(chatId, (deletedId) => {
      if (chat.activeChatId === deletedId) startNewChat();
    });
    
  };

  const handleDownloadChat = (chatId, e) => {
    
    if (e) e.stopPropagation();
    chat.downloadChat(chatId, "troubleshooter_chat");

  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    const textToSend = chat.inputValue.trim();
    if (!textToSend && chat.selectedFiles.length === 0) return;

    chat.setError(null);
    chat.appendMessage("user", textToSend || "[Attached file]");
    chat.setInputValue("");
    chat.setIsSending(true);

    try {

      const data = await sendChatRequest("/api/agent_server/troubleshooter/chat", {
        message: textToSend, username, reservation_id, chat_id: chat.activeChatId,
        llm_model: chat.selectedModel
      }, chat.selectedFiles);

      if (data.chat_id && !chat.activeChatId) {
        chat.setActiveChatId(data.chat_id);
        chat.setSavedChats((prev) => [data.chat_id, ...prev]);
      }

      chat.setSelectedFiles([]);

      // check if diagnostic_intent requires more information
      if (data.requires_approval) {
        setPendingCommands(data.commands);
        setSafeCommandsBuffer(data.safe_commands || []);
        setCurrentContext(data.context || "");
        setIsModalOpen(true);
        setCommandDecisions({});
        
      } else {
        chat.appendMessage("assistant", data.reply);
      }
    } catch (err) {
      chat.setError(err.message || "Unexpected error");
    } finally {
      chat.setIsSending(false);
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
    chat.setIsSending(true);

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
          chat_id: chat.activeChatId,
          llm_model: chat.selectedModel
        }),
      });

      if (!response.ok) throw new Error("Error during command execution");
      
      const data = await response.json();
      chat.appendMessage("assistant", data.reply);
      
    } catch (err) {
      chat.setError("Error during command execution");
    } finally {
      chat.setIsSending(false);
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
      <ChatHeader 
        title="Diagnostic Troubleshooter"
        availableModels={chat.availableModels}
        selectedModel={chat.selectedModel}
        onModelChange={chat.setSelectedModel}
        isDisabled={chat.isSending}
      />

      <div className="experiment-negotiation-main">
        <ChatSidebar
          savedChats={chat.savedChats}
          activeChatId={chat.activeChatId}
          isSending={chat.isSending}
          disableListActions={false}
          onNewChat={startNewChat}
          onDownloadChat={handleDownloadChat}
          onLoadHistory={(id) => chat.loadHistory(id)}
          onDeleteChat={handleDeleteChat}
          sessionLabel="Session"
        />

        <div className="experiment-negotiation-chat">
          <div className="en-chat-window">
            {chat.messages.map(renderMessage)}
            {chat.isSending && (
              <div className="en-message-bubble en-message-assistant">
                <div className="en-message-role">Troubleshooter Agent</div>
                <div className="en-message-content">Analyzing testbed, please wait...</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <form className="en-input-area" onSubmit={handleSubmit} autoComplete="off">
            <FileUploader
              selectedFiles={chat.selectedFiles}
              isInputDisabled={chat.isSending}
              onFileChange={chat.handleFileChange}
              onRemoveFile={chat.handleRemoveFile}
            />

            <div className="en-input-row">
              <textarea
                className="en-textarea"
                value={chat.inputValue}
                onChange={(e) => chat.setInputValue(e.target.value)}
                placeholder="E.g., Verify if h1 can ping h2 or check BGP on sw1..."
                rows={3}
                disabled={chat.isSending}
              />
              <button
                type="submit"
                className={`en-send-button ${((!chat.inputValue.trim() && chat.selectedFiles.length === 0) || chat.isSending) ? "en-send-button-disabled" : ""}`}
                disabled={(!chat.inputValue.trim() && chat.selectedFiles.length === 0) || chat.isSending}
              >
                <span className="en-send-icon">↑</span>
              </button>
            </div>
            {chat.error && <div className="en-error-message">{chat.error}</div>}
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