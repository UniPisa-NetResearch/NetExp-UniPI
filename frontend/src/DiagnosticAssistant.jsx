import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import "./style/llmAgent.css";

import { UniversalPipelineChat, CollapsibleMessageWrapper, CommandApprovalModal, ExecutionLogViewer } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequestStream } from "./LLMAgents/useAgentChat";




const MarkdownMessageViewer = ({ message, username, isUser }) => {
  let displayContent = message.content;

  if (typeof displayContent === 'string') {
    // filter ansible execution status from the output
    displayContent = displayContent.replace(/\[SUCCESS]:?[ \t]*\n?/g, '').replace(/\[FAILED: Return code \d+\][ \t]*\n?/g, '').replace(/\[STDOUT]:[ \t]*\n?/g, '').replace(/\[STDERR]:[ \t]*\n?/g, '').replace(/===[ \t]*/g, '');
  
  }

  const hasCodeBlocks = displayContent.includes("```");
  const title = isUser ? username : "Diagnostic Assistant";
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

const DiagnosticAssistant = ({ username, reservation_id, activeReservationExpiration }) => {
  const chat = useAgentChat(username, reservation_id, "diagnostic_assistant_chat");
  const chatEndRef = useRef(null);
  const reasoningRef = useRef(null);

  // modal window states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [safeCommandsBuffer, setSafeCommandsBuffer] = useState([]);
  const [currentContext, setCurrentContext] = useState("");
  const [commandDecisions, setCommandDecisions] = useState({});
  // execution progress states
  const [diagnosticAssistantPhases, setDiagnosticAssistantPhases] = useState([]);
  const [currentProgressPhase, setCurrentProgressPhase] = useState(null);
  // one agent is reasoning
  const [activeReasoning, setActiveReasoning] = useState("");
  // conditions to disable send button
  const isButtonDisabled = chat.isSending || (!chat.inputValue.trim() && chat.selectedFiles.length === 0);
  // phase from which resume pipeline when commands approval is required
  const [resumeDiagnosisPhase, setResumeDiagnosisPhase] = useState("diagnostic_intent");

  const phaseDescriptions = [
    "Request analysis and problem identification...",
    "Scheduling diagnostic commands to run...",
    "Reading network status from devices...",
    "Preparation and generation of the final report..."
  ];

  // placcehlder shown in the chat
  let inputPlaceholder = chat.isSending ? "Processing phase, please wait..." : "Type your message...";

  // fetch of previous sessions
  useEffect(() => {

    chat.fetchSessions("diagnostic_assistant_chat").then(data => {
      if(data && data.diagnostic_assistant_phases_order){
        setDiagnosticAssistantPhases(data.diagnostic_assistant_phases_order);
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
    chat.downloadChat(chatId, "diagnostic_assistant_chat");

  };

  const formatPhaseName = (phaseString, index) => {
    if (!phaseString) return "";

    // use predefined sentences for known phases, otherwise format the string dynamically
    if (phaseDescriptions[index]) {
      return phaseDescriptions[index];
    }

    return phaseString.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  const runDiagnosticAssistantPipeline = async (initialPayload, initialFiles) => {
    chat.setIsSending(true);
    setActiveReasoning("");
    setCurrentProgressPhase(initialPayload.current_phase);
    let currentChatId = initialPayload.chat_id;

    try {
      
        await sendChatRequestStream("/api/agent_server/diagnosticAssistant/chat", initialPayload, initialFiles,
          (thoughtChunk) => {
            setActiveReasoning((prev) => prev + thoughtChunk); // collect reasoning tokens and append to the previous collected to recreate the entire reasoning
          },
          (resultData) => {
            if (resultData.chat_id && !currentChatId) {
              currentChatId = resultData.chat_id;
              chat.setActiveChatId(resultData.chat_id);
              chat.setSavedChats((prev) => [...new Set([resultData.chat_id, ...prev])]);
            }

            if (resultData.requires_approval) {
              setPendingCommands(resultData.commands);
              setSafeCommandsBuffer(resultData.safe_commands || []);
              setCurrentContext(resultData.context || "");
              setResumeDiagnosisPhase(resultData.next_phase || diagnosticAssistantPhases[2] || "execution");
              setIsModalOpen(true);
              setCommandDecisions({});
              return; 
            }

            // show agent reply and execution log if are present (last iteration or intent request rejected)
            if (resultData.execution_log) chat.appendMessage("execution_log", resultData.execution_log);

            if (resultData.reply) chat.appendMessage("assistant", resultData.reply);

            if (resultData.next_phase) {
              setResumeDiagnosisPhase(resultData.next_phase);
              setCurrentProgressPhase(resultData.next_phase);
              setActiveReasoning(""); 
            }
          }
        );

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

    // check remaining time for user request
    if (activeReservationExpiration) {
      const expiresAt = new Date(activeReservationExpiration).getTime();
      const minutesLeft = (expiresAt - Date.now()) / 60000;
      
      if (minutesLeft < chat.preventionThreshold) {
        chat.setError(`Operation denied: less than ${chat.preventionThreshold} minutes remaining for this reservation.`);
        return; // block the execution completely
      }
    }

    const textToSend = chat.inputValue.trim();
    if (!textToSend && chat.selectedFiles.length === 0) return;

    chat.setError(null);
    chat.appendMessage("user", textToSend || "[Attached file]");
    chat.setInputValue("");
    
    const initialPayload = {message: textToSend, username, reservation_id, chat_id: chat.activeChatId, llm_model: chat.selectedModel, current_phase: diagnosticAssistantPhases.length > 0 ? diagnosticAssistantPhases[0] : "diagnostic_intent"};

    await runDiagnosticAssistantPipeline(initialPayload, chat.selectedFiles);
    chat.setSelectedFiles([]);

  };

  const handleSubmitApproval = async () => {
    setIsModalOpen(false);
    chat.setIsSending(true);
    // restart execution from execution phase with approved commands
    const execPhase = resumeDiagnosisPhase || (diagnosticAssistantPhases.length > 2 ? diagnosticAssistantPhases[2] : "execution");
    setCurrentProgressPhase(execPhase);

    const userApprovedCommands = pendingCommands.filter((_, idx) => commandDecisions[idx] === "accepted");
    
    const resumePayload = {
      username, 
      reservation_id, 
      chat_id: chat.activeChatId, 
      llm_model: chat.selectedModel,
      current_phase: execPhase,
      context: currentContext,
      safe_commands: JSON.stringify(safeCommandsBuffer),
      approved_commands: JSON.stringify(userApprovedCommands)
    };

    await runDiagnosticAssistantPipeline(resumePayload, []);
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
        <div className="en-message-role">{isUser ? username : "Diagnostic Assistant"}</div>
        <div className="en-message-content">
              <span className="en-plain-text">{displayContent}</span>
        </div>
      </div>
    );
  };

  return (
    <>
      <UniversalPipelineChat 
        mode="diagnosticassistant"
        chat={chat}
        title="Diagnostic Assistant"
        phases={diagnosticAssistantPhases}
        currentProgressPhase={currentProgressPhase}
        activeReasoning={activeReasoning}
        isChatLocked={false}
        isButtonDisabled={isButtonDisabled} 
        onSubmit={handleSubmit}
        formatPhaseName={formatPhaseName}
        renderMessage={renderMessage}
        sessionLabel="Session"
        startNewChat={startNewChat}
        handleDownloadChat={handleDownloadChat}
        handleDeleteChat={handleDeleteChat}
        inputPlaceholder={inputPlaceholder}
        chatEndRef={chatEndRef}
        reasoningRef={reasoningRef}
      />

      <CommandApprovalModal 
        isOpen={isModalOpen}
        pendingCommands={pendingCommands}
        commandDecisions={commandDecisions}
        setCommandDecisions={setCommandDecisions}
        onSubmitApproval={handleSubmitApproval}
      />

    </>
  );
};

export default DiagnosticAssistant;