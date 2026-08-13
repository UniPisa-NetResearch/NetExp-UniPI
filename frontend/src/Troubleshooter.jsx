import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import "./style/llmAgent.css";

import { ChatSidebar, FileUploader, ChatHeader } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequest, sendChatRequestStream } from "./LLMAgents/useAgentChat";


// common wrapper component for execution log and code fragments in agent messages
const CollapsibleMessageWrapper = ({ title, btnTextOpen, btnTextClosed, wrapperClass, renderContent }) => {
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

const ExecutionLogViewer = ({ message }) => {

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
          const splitIndex = report.indexOf(' |');
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
          const cmdPart = report.substring(0, splitIndex).trim();
          const outputPart = report.substring(splitIndex + 2).trim();
          
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

const MarkdownMessageViewer = ({ message, username, isUser }) => {
  const displayContent = message.content;
  const hasCodeBlocks = displayContent.includes("```");
  const title = isUser ? username : "Troubleshooter Agent";
  const wrapperClass = isUser ? 'en-message-user' : 'en-message-assistant';

  // if there are not code blocks, normally render the message
  if (!hasCodeBlocks) {
    return (
      <div className={`en-message-bubble ${wrapperClass}`}>
        <div className="en-message-role">{title}</div>
        <div className="en-message-content">
          <div className="en-markdown-layout">
            <ReactMarkdown>{displayContent}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  // if there are code blocks, use interactive wrapper
  return (
    <CollapsibleMessageWrapper
      title={title}
      btnTextOpen="Open all outputs"
      btnTextClosed="Close all outputs"
      wrapperClass={wrapperClass}
      renderContent={(allOpen) => (
        <div className="en-markdown-layout">
          <ReactMarkdown
            components={{
              pre({ children }) {
                return (
                  <details className="en-execution-log-details en-markdown-details" open={allOpen}>
                    <summary className="en-markdown-summary">
                      <span className="en-execution-icon">▶</span> Code Snippet
                    </summary>
                    <pre className="en-markdown-pre">{children}</pre>
                  </details>
                );
              }
            }}
          >
            {displayContent}
          </ReactMarkdown>
        </div>
      )}
    />
  );
};

const Troubleshooter = ({ username, reservation_id }) => {
  const chat = useAgentChat(username, reservation_id, "troubleshooter_chat");
  const chatEndRef = useRef(null);
  const reasoningRef = useRef(null);

  // modal window states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [safeCommandsBuffer, setSafeCommandsBuffer] = useState([]);
  const [currentContext, setCurrentContext] = useState("");
  const [commandDecisions, setCommandDecisions] = useState({});
  // execution progress states
  const [troubleshooterPhases, setTroubleshooterPhases] = useState([]);
  const [currentProgressPhase, setCurrentProgressPhase] = useState(null);
  // one agent is reasoning
  const [activeReasoning, setActiveReasoning] = useState("");

  const phaseDescriptions = [
    "Request analysis and problem identification...",
    "Scheduling diagnostic commands to run...",
    "Reading network status from devices...",
    "Preparation and generation of the final report..."
  ];

  // fetch of previous sessions
  useEffect(() => {

    chat.fetchSessions("troubleshooter_chat").then(data => {
      if(data && data.troubleshooter_phases_order){
        setTroubleshooterPhases(data.troubleshooter_phases_order);
      }
    });
  }, [chat.fetchSessions]);

  // automatic scroll when new text piece arrives
  useEffect(() => {
    if (reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [activeReasoning]);

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

  const formatPhaseName = (phaseString, index) => {
    if (!phaseString) return "";

    // use predefined sentences for known phases, otherwise format the string dynamically
    if (phaseDescriptions[index]) {
      return phaseDescriptions[index];
    }

    return phaseString.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  const runTroubleshooterPipeline = async (initialPayload, initialFiles) => {
    let payload = { ...initialPayload };
    let currentFiles = initialFiles;
    chat.setIsSending(true);

    try {
      while (payload.current_phase) {
        setCurrentProgressPhase(payload.current_phase);
        setActiveReasoning("");

        const data = await sendChatRequestStream("/api/agent_server/troubleshooter/chat", payload, currentFiles,
          (thoughtChunk) => {
            setActiveReasoning((prev) => prev + thoughtChunk); // collect reasoning tokens and append to the previous collected to recreate the entire reasoning
          }
        );
        currentFiles = []; // files are sent only in the intent phase

        if (data.chat_id && !payload.chat_id) {
          payload.chat_id = data.chat_id;
          chat.setActiveChatId(data.chat_id);

          chat.setSavedChats((prev) => [...new Set([data.chat_id, ...prev])]);
        }

        if (data.requires_approval) {
          setPendingCommands(data.commands);
          setSafeCommandsBuffer(data.safe_commands || []);
          setCurrentContext(data.context || "");
          setIsModalOpen(true);
          setCommandDecisions({});
          chat.setIsSending(false); 
          return; 
        }

        // show agent reply and execution log if are present (last iteration or intent request rejected)
        if (data.execution_log) chat.appendMessage("execution_log", data.execution_log);
        if (data.reply) chat.appendMessage("assistant", data.reply);

        // payload for next step
        if (data.next_phase) {
          payload.current_phase = data.next_phase;
          if (data.context) payload.context = data.context;
          if (data.safe_commands) payload.safe_commands = JSON.stringify(data.safe_commands);
          if (data.execution_report) payload.execution_report = data.execution_report;
        } else {
          payload.current_phase = null; // end of the cycle
        }
      }
    } catch (err) {
      chat.setError(err.message || "Unexpected error");
      setActiveReasoning("");
    } finally {
      chat.setIsSending(false);
      setCurrentProgressPhase(null);
      setActiveReasoning("");
    }
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();

    const textToSend = chat.inputValue.trim();
    if (!textToSend && chat.selectedFiles.length === 0) return;

    chat.setError(null);
    chat.appendMessage("user", textToSend || "[Attached file]");
    chat.setInputValue("");
    
    const initialPayload = {message: textToSend, username, reservation_id, chat_id: chat.activeChatId, llm_model: chat.selectedModel, current_phase: "diagnostic_intent"};

    await runTroubleshooterPipeline(initialPayload, chat.selectedFiles);
    chat.setSelectedFiles([]);

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
    // restart execution from execution phase with approved commands
    setCurrentProgressPhase("execution");

    const userApprovedCommands = pendingCommands.filter((_, idx) => commandDecisions[idx] === "accepted");
    
    const resumePayload = {
      username, 
      reservation_id, 
      chat_id: chat.activeChatId, 
      llm_model: chat.selectedModel,
      current_phase: "execution",
      context: currentContext,
      safe_commands: JSON.stringify(safeCommandsBuffer),
      approved_commands: JSON.stringify(userApprovedCommands)
    };

    await runTroubleshooterPipeline(resumePayload, []);
  };
  
  const renderMessage = (message) => {
    const isUser = message.role === "user";
    let displayContent = message.content;

    if (isUser && typeof displayContent === "string" && displayContent) {
      const fileRegex = /<attached_file name="([^"]+)">[\s\S]*?<\/attached_file>/g;
      displayContent = displayContent.replace(fileRegex, "\n[Attached file: $1]\n");
    }
    
    if (message.role === "execution_log") {

      return <ExecutionLogViewer key={message.id} message={message} />;
      
    }

    const useMarkdown = !isUser && typeof displayContent === "string" && (displayContent.includes("DIAGNOSTIC REPORT") || displayContent.includes("CONFIGURATION REPORT") || displayContent.includes("READ REPORT"));

    if (useMarkdown) {
      return <MarkdownMessageViewer isUser={isUser} key={message.id} message={message} username={username}/>;
    }

    return (
      <div key={message.id} className={`en-message-bubble ${isUser ? 'en-message-user' : 'en-message-assistant'}`}>
        <div className="en-message-role">{isUser ? username : "Troubleshooter Agent"}</div>
        <div className="en-message-content">
              <span className="en-plain-text">{displayContent}</span>
        </div>
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
            {chat.isSending && currentProgressPhase && troubleshooterPhases.length > 0 && (
              <div className="en-message-bubble en-message-assistant en-progress-bubble">
                <div className="en-message-role">Troubleshooter Agent</div>
                <div className="en-message-content">
                  <p className="en-progress-title">
                    Analyzing testbed, please wait...
                  </p>
                  <div className="en-troubleshooter-progress">
                    {troubleshooterPhases.map((phaseKey, idx) => {
                      const currentIndex = troubleshooterPhases.indexOf(currentProgressPhase);
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