import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import "./style/llmAgent.css";
import { UniversalPipelineChat } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequestStream } from "./LLMAgents/useAgentChat";

const InteractiveAssistant = ({ username, reservation_id, activeReservationExpiration }) => {
  const chat = useAgentChat(username, reservation_id, "interactive_negotiator");
  const chatEndRef = useRef(null);
  const reasoningRef = useRef(null);

  const [currentProgressPhase, setCurrentProgressPhase] = useState(null);
  const [activeReasoning, setActiveReasoning] = useState("");
  
  // interactive pipeline phases
  const interactivePhases = ["interactive_negotiator", "execution"];

  // retrieve historic at mount
  useEffect(() => {
    chat.fetchSessions("interactive_negotiator");
  }, [chat.fetchSessions]);

  //reasoning box aoutoscroll
  useEffect(() => {
    if (reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [activeReasoning]);

  const startNewChat = () => {
    chat.resetBaseChat();
  };

  const handleLoadHistory = async (chatId) => {
    await chat.loadHistory(chatId, "interactive_negotiator");
  };

  const handleDeleteChat = async (chatId, e) => {
    if(e) e.stopPropagation();
    chat.deleteChat(chatId, (deletedId) => {
      if (chat.activeChatId === deletedId) startNewChat();
    });
  };

  const handleDownloadChat = async (chatId, e) => {
    if (e) e.stopPropagation();
    chat.downloadChat(chatId, "interactive_negotiator");
  };

  const formatPhaseName = (phaseString, index) => {
    const descriptions = {
      "interactive_negotiator": "Analyzing request & generating commands...",
      "execution": "Executing commands on testbed..."
    };
    return descriptions[phaseString] || chat.agentNames[phaseString] || phaseString.toUpperCase();
  };

  const runInteractivePipeline = async (initialPayload) => {
    chat.setIsSending(true);
    setActiveReasoning("");
    setCurrentProgressPhase(initialPayload.current_phase);
    let currentChatId = initialPayload.chat_id;

    try {
      await sendChatRequestStream("/api/agent_server/interactiveAssistant/chat", initialPayload, chat.selectedFiles,
        (thoughtChunk) => {
          setActiveReasoning((prev) => prev + thoughtChunk);
        },
        (resultData) => {
          if (resultData.chat_id && !currentChatId) {
            currentChatId = resultData.chat_id;
            chat.setActiveChatId(resultData.chat_id);
            chat.setSavedChats((prev) => [...new Set([resultData.chat_id, ...prev])]);
          }

          // append message
          if (resultData.reply) {
            chat.appendMessage("assistant", resultData.reply);
          }

          // format execution report as markdown
          if (resultData.execution_report) {
            const reportContent = `### Execution Report\n\n${resultData.execution_report}`;
            chat.appendMessage("execution_log", reportContent);
          }

          if (resultData.next_phase) {
            setCurrentProgressPhase(resultData.next_phase);
            setActiveReasoning("");
          }
        }
      );
    } catch (err) {
      chat.setError(err.message || "Unexpected error");
    } finally {
      chat.setIsSending(false);
      setCurrentProgressPhase(null);
      setActiveReasoning("");
    }
  };

  const handleSubmit = async (e, overrideMessage = null) => {
    if(e) e.preventDefault();
    chat.setError(null);

    // check reservation expiration
    if (activeReservationExpiration) {
      const expiresAt = new Date(activeReservationExpiration).getTime();
      const minutesLeft = (expiresAt - Date.now()) / 60000;
      if (minutesLeft < chat.preventionThreshold) {
        chat.setError(`Operation denied: less than ${chat.preventionThreshold} minutes remaining.`);
        return;
      }
    }

    const textToSend = overrideMessage !== null ? overrideMessage : chat.inputValue.trim();
    if (!textToSend && chat.selectedFiles.length === 0) return;

    chat.appendMessage("user", textToSend);
    if (overrideMessage === null) chat.setInputValue("");
    chat.setIsSending(true);

    const initialPayload = {
        message: textToSend, 
        username, 
        reservation_id, 
        chat_id: chat.activeChatId, 
        llm_model: chat.selectedModel, 
        current_phase: "interactive_negotiator"
    };

    await runInteractivePipeline(initialPayload);
    chat.setSelectedFiles([]);
  };

  // Funzione chiamata dal tasto "Approve & Execute"
  const handleApprove = () => {
    handleSubmit(null, "The commands are approved, please execute them.");
  };

  const renderMessage = (message, index) => {
    const isUser = message.role === "user";
    let displayContent = message.content;

    // user messages rendering
    if (isUser) {
        const fileRegex = /--- Start attached file content: (.*?) ---[\s\S]*?--- End attached file content: \1 ---/g;
        if (typeof displayContent === "string") {
            displayContent = displayContent.replace(fileRegex, "\n[Attached file: $1]\n");
        }
        return (
        <div key={message.id || index} className="en-message-bubble en-message-user">
            <div className="en-message-role">{username}</div>
            <div className="en-message-content">
            <span className="en-plain-text">{displayContent}</span>
            </div>
        </div>
        );
    }

    // execution log rendering
    if (message.role === "execution_log") {
        return (
            <div key={message.id || index} className="en-message-bubble en-message-assistant" style={{ borderLeft: "4px solid #4CAF50" }}>
              <div className="en-message-role">System Execution</div>
              <div className="en-message-content en-markdown-layout">
                <ReactMarkdown>{String(displayContent)}</ReactMarkdown>
              </div>
            </div>
          );
    }

    // json parsing
    let parsed = null;
    try {
      if (typeof displayContent === "string") {
         const jsonMatch = displayContent.match(/\{[\s\S]*\}/);
         if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } else {
         parsed = displayContent;
      }
    } catch (e) {}

    const isLastMessage = index === chat.messages.length - 1;

    return (
      <div key={message.id || index} className="en-message-bubble en-message-assistant">
        <div className="en-message-role">Command Assistant</div>
        <div className="en-message-content">
          {parsed ? (
            <div>
              {parsed.response && (
                  <div className="en-markdown-layout">
                      <ReactMarkdown>{parsed.response}</ReactMarkdown>
                  </div>
              )}
              {parsed.proposed_commands && parsed.proposed_commands.length > 0 && (
                  <div className="en-backend-message" style={{ marginTop: "15px" }}>
                      <strong className="en-backend-message-header">Proposed Commands:</strong>
                      <div className="en-backend-message-list-plain" style={{ backgroundColor: "#1e1e1e", padding: "10px", borderRadius: "5px" }}>
                          {parsed.proposed_commands.map((cmd, i) => (
                              <div key={i} style={{ color: "#d4d4d4", fontFamily: "monospace" }}>{cmd}</div>
                          ))}
                      </div>
                      
                      {/* button visible only after the last message */}
                      {(parsed.status === "AWAITING_APPROVAL" || parsed.status === "AWAITING_CLARIFICATIONS") && isLastMessage && !chat.isSending && (
                          <button 
                            type="button" 
                            className="en-transition-btn en-primary-transition-btn" 
                            onClick={handleApprove} 
                            style={{ marginTop: "15px", width: "100%" }}
                          >
                              ✓ Approve & Execute Commands
                          </button>
                      )}
                  </div>
              )}
            </div>
          ) : (
            <div className="en-markdown-layout">
              <ReactMarkdown>{typeof displayContent === "string" ? displayContent : JSON.stringify(displayContent)}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    );
  };

  const isInputEmpty = chat.inputValue.trim() === "" && chat.selectedFiles.length === 0;
  const isChatLocked = chat.isSending;
  const isButtonDisabled = chat.isSending || isChatLocked || isInputEmpty;

  return (
    <UniversalPipelineChat 
      mode="interactiveassistant"
      chat={chat}
      title="Interactive Command Assistant"
      phases={interactivePhases}
      currentProgressPhase={currentProgressPhase}
      activeReasoning={activeReasoning}
      isChatLocked={isChatLocked}
      isButtonDisabled={isButtonDisabled}
      onSubmit={handleSubmit}
      formatPhaseName={formatPhaseName}
      renderMessage={renderMessage}
      sessionLabel="Config Session"
      startNewChat={startNewChat}
      handleDownloadChat={handleDownloadChat}
      handleDeleteChat={handleDeleteChat}
      inputPlaceholder={chat.isSending ? "Processing request..." : "Ask me to configure something or run commands..."}
      onLoadHistory={handleLoadHistory}
      chatEndRef={chatEndRef}
      reasoningRef={reasoningRef}
    />
  );
};

export default InteractiveAssistant;