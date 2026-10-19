import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import "./style/llmAgent.css";
import { UniversalPipelineChat, CommandApprovalModal, ExecutionLogViewer, CollapsibleMessageWrapper, renderStructuredContent, processSafetyHistory } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequestStream } from "./LLMAgents/useAgentChat";

const InteractiveAssistant = ({ username, reservation_id, activeReservationExpiration, isSafeMode = false }) => {
  const redisRole = isSafeMode ? "safe_interactive_negotiator" : "interactive_negotiator";
  const chat = useAgentChat(username, reservation_id, redisRole);
  const [interactivePhases, setInteractivePhases] = useState([]);
  const chatEndRef = useRef(null);
  const reasoningRef = useRef(null);

  const [currentProgressPhase, setCurrentProgressPhase] = useState(null);
  const [activeReasoning, setActiveReasoning] = useState("");

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [commandDecisions, setCommandDecisions] = useState({});

  // retrieve historic at mount
  useEffect(() => {
    const rootRole = isSafeMode ? "safe_interactive_negotiator" : "interactive_negotiator";
    chat.fetchSessions(rootRole).then(data => {
      if (data) {
        const phases = isSafeMode ? data.safe_interactive_assistant_phases_order : data.interactive_assistant_phases_order;
        if (phases) setInteractivePhases(phases);
      }
    });
  }, [chat.fetchSessions, isSafeMode]);

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
    const rolesToFetch = isSafeMode ? "safe_interactive_negotiator,safety,interactive_reporter" : "interactive_negotiator,interactive_reporter";

    try {

      const response = await fetch(`/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=${rolesToFetch}`);

      if (response.ok) {
        const data = await response.json();
        const allMsgs = data.messages || [];

        const filteredMessages = processSafetyHistory(allMsgs, 3); 

        let detectedPhase = interactivePhases.length > 0 ? interactivePhases[0] : (isSafeMode ? "safe_interactive_negotiator" : "interactive_negotiator");

        if (filteredMessages.length > 0) {
          const lastMsg = filteredMessages[filteredMessages.length - 1];
          if (lastMsg.agent_phase) {
            detectedPhase = lastMsg.agent_phase;
          }
        }

        chat.setMessages(filteredMessages);
        chat.setActiveChatId(chatId);
      }
    } catch(err) {
      console.error(err);
    }
    
  };

  const handleDeleteChat = async (chatId, e) => {
    if(e) e.stopPropagation();
    chat.deleteChat(chatId, (deletedId) => {
      if (chat.activeChatId === deletedId) startNewChat();
    });
  };

  const handleDownloadChat = async (chatId, e) => {
    if (e) e.stopPropagation();
    const roleToFetch = isSafeMode ? "safe_interactive_negotiator,safety,interactive_reporter" : "interactive_negotiator,interactive_reporter";
    chat.downloadChat(chatId, roleToFetch);
  };

  const formatPhaseName = (phaseString, index) => {
    const descriptions = {
      "interactive_negotiator": "Negotiating commands...",
      "execution": "Executing on testbed...",
      "interactive_reporter": "Evaluating results..."
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
            chat.appendMessage("execution_log", resultData.execution_report);
          }

          if (resultData.requires_approval) {
            setPendingCommands(resultData.commands);
            setIsModalOpen(true);
            setCommandDecisions({});
            return;
          }

          if (resultData.next_phase) {
            setCurrentProgressPhase(resultData.next_phase);
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
    
    let startingPhase = "interactive_negotiator";
    let isAnsweringQuestion = false;
    
    if (isSafeMode && chat.messages.length > 0) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg.role === "assistant" && lastMsg.role === "safety") {
        try {
          const parsed = typeof lastMsg.content === 'string' ? JSON.parse(lastMsg.content) : lastMsg.content;
          if (parsed && parsed.status && String(parsed.status).toUpperCase().includes('AWAITING_CLARIFICATIONS')) {
            isAnsweringQuestion = true;
            startingPhase = "safety";
          }
        } catch (e) {}
      }
    }

    const initialPayload = {
        message: textToSend, 
        username, 
        reservation_id, 
        chat_id: chat.activeChatId, 
        llm_model: chat.selectedModel, 
        current_phase: startingPhase,
        pipeline_mode: isSafeMode ? "safe" : "standard",
        is_manual_chat: isAnsweringQuestion ? "true" : "false"
    };

    await runInteractivePipeline(initialPayload);
    chat.setSelectedFiles([]);
  };

  const handleSubmitApproval = () => {
    setIsModalOpen(false);

    const rejectedCommands = pendingCommands.filter((_, idx) => commandDecisions[idx] === "rejected");
    
    if (rejectedCommands.length > 0) {
        let chatText = "I have rejected the following commands:\n";
        rejectedCommands.forEach(cmd => { chatText += `- ${cmd}\n`; });
        chatText += "\nPlease remove them from the execution plan.";
        
        chat.setInputValue(chatText);
    } else {
        chat.setInputValue("I have manually reviewed and approved the plan. Please proceed with execution.");
    }
  };

  const renderMessage = (message, index) => {
    const isUser = message.role === "user";
    let displayContent = message.content;

    // user messages rendering
    if (isUser) {
        const fileRegex = /<attached_file name="([^"]+)">[\s\S]*?<\/attached_file>/g;
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
        return <ExecutionLogViewer key={message.id || index} message={message} />;
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

    const isSafetyMessage = parsed && (parsed.issues !== undefined || parsed.executable_plan !== undefined);

    if (parsed && parsed.status === "APPROVED" && !isSafetyMessage) {
      return null;
    }

    // extract the text
    const contentText = parsed ? parsed.response : (typeof displayContent === "string" ? displayContent : "");
    
    // verify if there are proposed commands
    const hasCommands = parsed && parsed.proposed_commands && parsed.proposed_commands.length > 0;
    
    // if tehre is Markdown code and there are not commands to propose use code elements
    if (typeof contentText === "string" && contentText.includes("```") && !hasCommands && !isSafetyMessage) {
      return (
        <CollapsibleMessageWrapper
          key={message.id || index}
          title="Command Assistant"
          btnTextOpen="Open all snippets"
          btnTextClosed="Close all snippets"
          wrapperClass="en-message-assistant"
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
                {contentText}
              </ReactMarkdown>
            </div>
          )}
        />
      );
    }

    return (
      <div key={message.id || index} className="en-message-bubble en-message-assistant">
        <div className="en-message-role">{message.agent_phase ? (chat.agentNames[message.agent_phase] || message.agent_phase) : "Command Assistant"}</div>
        <div className="en-message-content">
          {parsed ? (
            <div>
              {isSafetyMessage ? (
                renderStructuredContent(parsed)
              ) : (
                <>
                  {parsed.response && (
                    
                    <div className="en-markdown-layout">
                        <ReactMarkdown>{parsed.response}</ReactMarkdown>
                    </div>
                  )}
            
                  {hasCommands && (
                      
                    <div className="en-backend-message interactive-command-message">
                          <div className="en-backend-message-header">
                              <strong>Proposed Commands</strong>
                          </div>
                          <div className="en-backend-message-list-plain interactive-command-list">
                              {parsed.proposed_commands.map((cmd, i) => (
                                  <div key={i} className="en-backend-message-list-element interactive-command-list-element">
                                      {cmd}
                                  </div>
                              ))}
                          </div>
                      </div>        
                  )}
                </>
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
    <>
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

    {!isSafeMode && (
      <CommandApprovalModal 
        isOpen={isModalOpen}
        pendingCommands={pendingCommands}
        commandDecisions={commandDecisions}
        setCommandDecisions={setCommandDecisions}
        onSubmitApproval={handleSubmitApproval}
      />
    )}
    </>
  );
};

export default InteractiveAssistant;