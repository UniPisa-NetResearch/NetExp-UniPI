import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import "./style/llmAgent.css";
import { UniversalPipelineChat } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequestStream } from "./LLMAgents/useAgentChat";

// component exclusively for Admins: read-only view of historical JSON messages
const AdminReadOnlyDebugger = ({ username, reservation_id, activeChatId, phases, renderMessage, agentNames }) => {
  const [debugPhase, setDebugPhase] = useState(phases.length > 0 ? phases[0] : 'negotiation');
  const [debugMessages, setDebugMessages] = useState([]);
  const [isExpanded, setIsExpanded] = useState(false);

  // synchronizes the debug view phase if the available phases change
  useEffect(() => {
    if (phases.length > 0 && !phases.includes(debugPhase)) {
        setDebugPhase(phases[0]);
    }
  }, [phases]);

  // fetches the unfiltered historical messages for the selected phase directly from the backend whenever the chat ID, phase, or expanded state changes
  useEffect(() => {
    if (!activeChatId || !isExpanded) return;
    
    const fetchPhaseHistory = async () => {
      try {
        const response = await fetch(`/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(activeChatId)}&agent_role=${encodeURIComponent(debugPhase)}`);
        if (response.ok) {
          const data = await response.json();

          const messagesWithIds = (data.messages || []).map((msg, idx) => ({
              ...msg,
              id: msg.id || `debug-${debugPhase}-${idx}`
          }));

          setDebugMessages(messagesWithIds);
        }
      } catch (err) {
        console.error("Error loading debug history:", err);
      }
    };

    fetchPhaseHistory();

  }, [debugPhase, activeChatId, isExpanded, username, reservation_id]);
  
  // cycles through the available phases (forward or backward) when the admin clicks the transition buttons.
  const handlePhaseChange = (direction) => {
      const currentIndex = phases.indexOf(debugPhase);
      if (direction === 'next' && currentIndex < phases.length - 1) {
          setDebugPhase(phases[currentIndex + 1]);
      } else if (direction === 'prev' && currentIndex > 0) {
          setDebugPhase(phases[currentIndex - 1]);
      }
  };

  return (
    <div className="admin-debugger-container">
      <div className="admin-debugger-main">
        <div className="admin-debugger-header">
          <h3 className="admin-debugger-title">🛠️ Admin Debug View</h3>
          <button onClick={() => setIsExpanded(!isExpanded)} className="en-download-chat-btn admin-debugger-btn" disabled={!activeChatId}>
              {isExpanded ? 'Hide Debugger' : 'Expand Debugger'}
          </button>
        </div>

        {isExpanded && activeChatId && (
            <div className="admin-debugger-content">
                <div className="en-stepper history-mode admin-debugger-stepper">
                    {phases.map((phase) => (
                        <div 
                            key={phase} 
                            className={`en-step ${debugPhase === phase ? 'active' : ''} clickable`}
                            onClick={() => setDebugPhase(phase)}
                        >
                            {(agentNames[phase] || phase).toUpperCase()}
                        </div>
                    ))}
                </div>

                <div className="experiment-negotiation-chat admin-debugger-chat">
                    {debugMessages.length === 0 ? (
                        <p className="admin-debugger-empty">No history found for {agentNames[debugPhase] || debugPhase.toUpperCase()} phase.</p>
                    ) : (
                        debugMessages.map(renderMessage)
                    )}
                </div>

                <div className="en-transition-actions admin-debugger-actions">
                    <button 
                        className="en-transition-btn en-secondary-transition-btn"
                        onClick={() => handlePhaseChange('prev')}
                        disabled={phases.indexOf(debugPhase) === 0}
                    >
                        Previous Phase
                    </button>
                    <button 
                        className="en-transition-btn en-primary-transition-btn"
                        onClick={() => handlePhaseChange('next')}
                        disabled={phases.indexOf(debugPhase) === phases.length - 1}
                    >
                        Next Phase
                    </button>
                </div>
            </div>
        )}
        {isExpanded && !activeChatId && (
            <div className="admin-debugger-content">
                <p className="admin-debugger-empty">Start a chat or select a previous session to view debug info.</p>
            </div>
        )}
      </div>
    </div>
  );
};

const LLMAgent = ({ username, reservation_id, isAdmin, activeReservationExpiration}) => {
  const chat = useAgentChat(username, reservation_id, "negotiation");

  const chatEndRef = useRef(null);
  const reasoningRef = useRef(null);

  const [currentProgressPhase, setCurrentProgressPhase] = useState(null);
  const [activeReasoning, setActiveReasoning] = useState("");

  // to know from which phase restart when the pipeline is blocked
  const [resumePhase, setResumePhase] = useState("negotiation");

  // serial or parallel
  const [executionMode, setExecutionMode] = useState("serial");

  const [negotiationQuestions, setNegotiationQuestions] = useState([]);
  const [negotiationAnswers, setNegotiationAnswers] = useState({});

  // pipeline phases (each phase corresponds to an agent)
  const [LLMAgentPhases, setLLMAgentPhases] = useState([]);

  // check if there are questions and if the user has written every answer
  const hasUnansweredQuestions = negotiationQuestions.length > 0 && !negotiationQuestions.every((_, i) => (negotiationAnswers[i] || "").trim() !== "");

  // number of safety iterations
  const [safetyIterations, setSafetyIterations] = useState(3);

  // rollback states
  const [isRollingBack, setIsRollingBack] = useState(false);

  // status of the execution phase
  const [executionStatus, setExecutionStatus] = useState(null);

  const isInputEmpty = chat.inputValue.trim() === "" && chat.selectedFiles.length === 0;

  const isExperimentTerminated = () => executionStatus === 'APPROVED' || executionStatus === 'TERMINATED';
  const isPendingRetry = executionStatus === 'REJECTED';
  
  // different placeholders for chat
  let inputPlaceholder = "Type your message...";
  if (chat.isSending) inputPlaceholder = "Processing phase, please wait...";
  else if (isExperimentTerminated()) inputPlaceholder = "Experiment terminated. Chat is closed.";
  else if (isPendingRetry) inputPlaceholder = "Execution failed. Choose an action above to continue or terminate.";

  const isChatLocked = chat.isSending || isExperimentTerminated() || isPendingRetry;

  const isButtonDisabled = chat.isSending || isChatLocked || (negotiationQuestions.length > 0 ? hasUnansweredQuestions : isInputEmpty);

  const [isRollbackModalOpen, setIsRollbackModalOpen] = useState(false);

  // extracts the execution status (e.g., APPROVED, REJECTED, TERMINATED) from a given assistant message payload to update the UI accordingly
  const extractExecutionStatus = (msg) => {
    if (!msg || msg.role !== 'assistant') return null;

    try {
      const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
      // execution agent is the only one that returns a json with "report" as a field
      if (parsed && parsed.report !== undefined && parsed.status !== undefined) {
        const status = String(parsed.status).toUpperCase();

        // return extracted execution status
        if (status.includes('APPROVED')) return 'APPROVED';
        else if (status.includes('TERMINATED')) return 'TERMINATED';
        else if (status.includes('REJECTED')) return 'REJECTED';
      }
    } catch (e) {
      // fallback: manually match predefined termination strings if JSON parsing fails
      const contentStr = String(msg.content);
      if (contentStr.includes('"status": "TERMINATED"')) return 'TERMINATED';
    }
    return null;
  };

  // watches the chat messages and automatically updates the global execution status whenever a new message is appended
  useEffect(() => {
    if (chat.messages.length > 0) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      const status = extractExecutionStatus(lastMsg);
      
      if (status) setExecutionStatus(status);
    }
  }, [chat.messages]);

  // fetches the available sessions on component mount, establishing the phase order and safety constraints from the backend configuration
  useEffect(() => {
    chat.fetchSessions("negotiation").then(data => {
      
      if (data && data.phases_order && LLMAgentPhases.length === 0) { 
        setLLMAgentPhases(data.phases_order);
      }

      if (data && data.safety_iterations) {
        setSafetyIterations(data.safety_iterations);
      }

    });
    
  }, [chat.fetchSessions, LLMAgentPhases.length]);

  // Auto-scrolls the reasoning/thought window to the bottom to ensure the latest streamed tokens are always visible
  useEffect(() => {
    if (reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [activeReasoning]);

  const startNewChat = () => {

    chat.resetBaseChat();
    setExecutionMode("serial");
    setNegotiationQuestions([]);
    setNegotiationAnswers({});
    setExecutionStatus(null);
    setResumePhase(LLMAgentPhases.length > 0 ? LLMAgentPhases[0] : "negotiation");
  };

  // fetches and loads the message history for a specific chat ID
  const handleLoadHistory = async (chatId) => {

    // load messages of the chat
    try {
      const response = await fetch(`/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=all_llm_agents`);
      
      let combinedMessages = [];
      if (response.ok) {
        const data = await response.json();
        const allMsgs = data.messages || [];

        // find last active phase
        let detectedPhase = LLMAgentPhases.length > 0 ? LLMAgentPhases[0] : "negotiation";
        if (allMsgs.length > 0) {
          const lastMsg = allMsgs[allMsgs.length - 1];
          if (lastMsg.agent_phase) {
            detectedPhase = lastMsg.agent_phase;
          }
        }
        // set the phase from which resume execution
        setResumePhase(detectedPhase);

        // counter for consecutive rejected safety messages
        let rejectedCount = 0;

        const filteredMessages = allMsgs.filter(m => {
          // show all negotiation phase messages
          if (m.agent_phase === "negotiation") return true;
          // show only assistant messages for execution phase
          if (m.agent_phase === "execution" && m.role === "assistant") return true;
          // show only approved or last rejected assistant message for safety phase
          if (m.agent_phase === "safety" && m.role === "assistant") {

            try {
              const parsed = typeof m.content === 'string' ? JSON.parse(m.content) : m.content;
              const status = String(parsed.status).toUpperCase();
              
              if (status.includes("REJECTED")) {
                  
                rejectedCount++;
                  
                  // if we reached N rejected messages, we show the message generated in teh last turn
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
        });

        combinedMessages = filteredMessages.map((m, i) => ({
            ...m, 
            id: m.id || `hist-${i}`
        }));
      }

      chat.setMessages(combinedMessages);
      chat.setActiveChatId(chatId);
      setExecutionStatus(null);
      
      // reconstruct the clarification form state if the last negotiation message asked questions
      if (combinedMessages.length > 0) {
        const lastAssistantMsg = combinedMessages.slice().reverse().find(m => m.role === 'assistant');
        const status = extractExecutionStatus(lastAssistantMsg);
        if (status) setExecutionStatus(status);
        
        let hasQuestions = false;

        // get last assistant message of negotioation
        if (lastAssistantMsg && (lastAssistantMsg.agent_phase === 'negotiation')) {
          try {
            const parsed = typeof lastAssistantMsg.content === 'string' ? JSON.parse(lastAssistantMsg.content) : lastAssistantMsg.content;

            //if there are questions and staus is not APPROVED, show form
            if (parsed && parsed.clarifying_questions && Array.isArray(parsed.clarifying_questions) && parsed.clarifying_questions.length > 0 && parsed.status !== "APPROVED") {
              setNegotiationQuestions(parsed.clarifying_questions);
              
              const initialAnswers = {};
              parsed.clarifying_questions.forEach((_, i) => { initialAnswers[i] = ""; });
              setNegotiationAnswers(initialAnswers);
              hasQuestions = true;
            }
          } catch (e) {
            console.log("Message parsing failed");
          }
        }

        if (!hasQuestions) {
          setNegotiationQuestions([]);
          setNegotiationAnswers({});
        }
      } else {
        setNegotiationQuestions([]);
        setNegotiationAnswers({});
      }
    } catch (err) {
        console.error("Error loading combined history:", err);
        setExecutionStatus(null);
        setNegotiationQuestions([]);
        setNegotiationAnswers({});
    }
  };

  const handleDeleteChat = async (chatId, e) => {
    if(e) e.stopPropagation(); // avoid chat loading after button click

    chat.deleteChat(chatId, (deletedId) => {
      if (chat.activeChatId === deletedId) startNewChat();
    });
  };

  const handleDownloadChat = async (chatId, e) => {
    if (e) e.stopPropagation(); // avoid opening the chat by clicking the button

    chat.downloadChat(chatId, null);
    
  };

  // calls the backend API to physically rollback the lab testbed to its initial state, bypassing normal chat transitions. Resets the UI upon completion.
  const executeRollback = async () => {
    
    chat.setIsSending(true);               // lock UI during rollback
    setIsRollingBack(true);

    try {
      const response = await fetch("/api/agent_server/experimentRollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, reservation_id: reservation_id, chat_id: chat.activeChatId || ""}),
      });

      if (!response.ok) {
        console.error("Error during testbed rollback");
      }

    } catch (err) {
      console.error("Network error during rollback:", err);
    } finally {
      chat.setIsSending(false);
      setIsRollingBack(false);
      startNewChat();
    }
  };

  const handleRollbackClick = () => {
    // open the modal window to confirm rollback execution
    setIsRollbackModalOpen(true);
  };

  // maps an internal phase key to a user-friendly string description
  const formatPhaseName = (phaseString, index) => {
    const descriptions = [
        "Negotiating experiment details...",
        "Planning network configuration...",
        "Validating plan safety...",
        "Generationg report after commands execution on testbed..."
    ];
    return descriptions[index] || chat.agentNames[phaseString] || phaseString.toUpperCase();
  };

  // core orchestrator for the multi-agent pipeline. It continuously connects to the SSE stream endpoint, manages phase transitions, and aggregates reasoning and final output
  const runExperimentPipeline = async (initialPayload, initialFiles) => {
    chat.setIsSending(true);
    setActiveReasoning("");
    setCurrentProgressPhase(initialPayload.current_phase);
    let currentChatId = initialPayload.chat_id;

    try {
      
      // send the single HTTP request, backend will loop internally and stream everything
      await sendChatRequestStream("/api/agent_server/experiment/stream", initialPayload, initialFiles,
        (thoughtChunk) => {
          // add current chucnk to the previous collected chunks
          setActiveReasoning((prev) => prev + thoughtChunk);
        },
        
        (resultData) => {
          // if it's a new chat, update the application state with the new chat_id
          if (resultData.chat_id && !currentChatId) {
            currentChatId = resultData.chat_id;
            chat.setActiveChatId(resultData.chat_id);
            chat.setSavedChats((prev) => [...new Set([resultData.chat_id, ...prev])]);
          }

          // handle negotiation clarification questions
          if (resultData.requires_answers) {
            chat.appendMessage("assistant", resultData.reply);
            setNegotiationQuestions(resultData.questions || []);
            const initialAnswers = {};
            (resultData.questions || []).forEach((_, i) => { initialAnswers[i] = ""; });
            setNegotiationAnswers(initialAnswers);
          } 
          // after the execution the experimenti is not correct
          else if (resultData.execution_rejected) {
            setExecutionStatus("REJECTED");
            chat.appendMessage("assistant", resultData.reply || "The plan failed to execute correctly.");
          }
          // standard flow: print the agent's finalized JSON payload to the chat
          else if (resultData.reply) chat.appendMessage("assistant", resultData.reply);
          
          if (resultData.next_phase) {
            setResumePhase(resultData.next_phase);
            setCurrentProgressPhase(resultData.next_phase);
            setActiveReasoning(""); 
          } else { 
            // if we arrive here, the pipeline is completed with success
              setExecutionStatus("APPROVED");
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
  
  // send a user message and optional files to the current agent
  const handleSubmit = async (e) => {
    if(e) e.preventDefault();
    chat.setError(null);

    // check remaining time for new user requests
    if (activeReservationExpiration) {
      const expiresAt = new Date(activeReservationExpiration).getTime();
      const minutesLeft = (expiresAt - Date.now()) / 60000;
      
      if (minutesLeft < chat.preventionThreshold) {
        chat.setError(`Operation denied: less than ${chat.preventionThreshold} minutes remaining for this reservation.`);
        return; // block the execution completely
      }
    }

    let textToSend = chat.inputValue.trim();

    // if there are questions, create formatted text and ignore the inputValue
    if (negotiationQuestions.length > 0) {
      const allAnswered = negotiationQuestions.every((_, i) => (negotiationAnswers[i] || "").trim() !== "");
      if (!allAnswered) {
        chat.setError("Please answer all clarifying questions before proceeding.");
        return;
      }
      textToSend = negotiationQuestions.map((q, i) => `${i + 1}. ${q}\nAnswer: ${negotiationAnswers[i]}`).join('\n\n');
    }

    if (!textToSend && chat.selectedFiles.length === 0) return;

    chat.appendMessage("user", textToSend);
    chat.setInputValue("");
    setNegotiationQuestions([]);
    setNegotiationAnswers({});
    chat.setIsSending(true);

    // determines if this submission is a direct reply to the safety agent's manual clarification requests
    let isAnsweringQuestion = false;
    if (chat.messages.length > 0) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg.role === "assistant") {
        try {
          const parsed = typeof lastMsg.content === 'string' ? JSON.parse(lastMsg.content) : lastMsg.content;
          if (parsed && parsed.status && String(parsed.status).toUpperCase().includes('AWAITING_CLARIFICATIONS')) {
            isAnsweringQuestion = true;
          }
        } catch (e) {}
      }
    }

    // build the request payload. In case of manual safety intervention, apply the special flag
    const initialPayload = {
        message: textToSend, 
        username, 
        reservation_id, 
        chat_id: chat.activeChatId, 
        llm_model: chat.selectedModel, 
        current_phase: resumePhase,
        is_manual_chat: (resumePhase === (LLMAgentPhases.length > 2 ? LLMAgentPhases[2] : "safety") && !isAnsweringQuestion) ? "true" : "false",
        execution_mode: executionMode
    };

    await runExperimentPipeline(initialPayload, chat.selectedFiles);
    chat.setSelectedFiles([]);
  };

  // recovers a failed execution state by requesting a new plan from the planning
  const handleRetryPlanning = async () => {
    setExecutionStatus(null);
    console.log("retry planning from: ", resumePhase);
    const retryPayload = {
        message: "RETRY_PLANNING",
        username, reservation_id, chat_id: chat.activeChatId, 
        llm_model: chat.selectedModel, current_phase: LLMAgentPhases.length > 1 ? LLMAgentPhases[1] : "planning",
        execution_mode: executionMode
    };
    await runExperimentPipeline(retryPayload, []);
  };

  // aborts the failed experiment permanently, updating both the local UI state and notifying the backend via a dedicated endpoint
  const handleTerminateExperiment = async () => {
    setExecutionStatus('TERMINATED');
    chat.appendMessage("assistant", '{"status": "TERMINATED", "report": "The experiment was manually terminated after an execution failure."}');

    fetch("/api/agent_server/terminate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, reservation_id, chat_id: chat.activeChatId })
    });
  };

  // render structured JSON responses in a readable key/value layout
  const renderStructuredContent = (parsed) => {
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

  // render user and assistant messages with phase-aware formatting
  const renderMessage = (message) => {
    const isUser = message.role === "user";

    let displayContent = message.content;

    if (isUser && typeof displayContent === "string" && displayContent) {

      displayContent = displayContent.replace(
        /<(device_report|execution_results|execution_report)>([\s\S]*?)<\/\1>/g,
        (match, tag, innerContent) => {
          // remove === inside specified tags
          const cleaned = innerContent.replace(/ ===\n/g, "\n").replace(/ ===/g, "");
          return `<${tag}>${cleaned}</${tag}>`;
        }
      );

      // remove file content from the user message and replace with a placeholder
      const fileRegex = /--- Start attached file content: (.*?) ---[\s\S]*?--- End attached file content: \1 ---/g;
      // show the file name in the user message and remove the content for better readability
      displayContent = displayContent.replace(fileRegex, "\n[Attached file: $1]\n");

      // the content between these xml tags is formatted as markdown, other fields as normal text
      const regex = /(<(?:experiment_context|device_report|execution_results|execution_report)>)([\s\S]*?)(<\/(?:experiment_context|device_report|execution_results|execution_report)>)/g;
      const parts = displayContent.split(regex);
      
      return (
        <div key={message.id} className="en-message-bubble en-message-user">
          <div className="en-message-role">{username}</div>
          <div className="en-message-content">
            {parts.map((part, index) => {
              // skip empty strings
              if (!part) return null;
              
              // in a split with 3 groups (<...>), ([\s\S]*?), (<\/ ...>)   
              // even indexes always correspond to internal content
              if (index % 4 === 2) {
                const markdownText = part.replace(/\n/g, '  \n');
                return (
                  <div key={index} className="en-markdown-layout"><ReactMarkdown>{markdownText}</ReactMarkdown></div>
                );
              }
            
              return (
                <span key={index} className="en-plain-text">{part}</span>
              );
            })}
          </div>
        </div>
      );
    }

    let formattedContent = null;

    // support legacy/object payloads defensively, even though backend responses are expected as strings
    if (!isUser && displayContent && typeof displayContent === "object") {
      formattedContent = renderStructuredContent(displayContent);
    }

    try {
      // extract and parse JSON assistant output, render raw text if parsing fails
      if (typeof displayContent === "string") {
        const jsonMatch = displayContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedData = JSON.parse(jsonMatch[0]);
          formattedContent = renderStructuredContent(parsedData);
        }
      }
    } catch (e) {
      // reasoning traces or malformed payloads are shown as plain text fallback
      formattedContent = null;
    }

    return (
      <div key={message.id} className="en-message-bubble en-message-assistant">
        <div className="en-message-role">
          {message.agent_phase && chat.agentNames[message.agent_phase] 
            ? chat.agentNames[message.agent_phase] 
            : "System Agent"}
        </div>
        <div className="en-message-content">
          {formattedContent ? (
            formattedContent
            ) : (
              <div className="en-markdown-layout">
                <ReactMarkdown>{typeof displayContent === "string" ? displayContent : JSON.stringify(displayContent, null, 2)}</ReactMarkdown>
              </div>
            )}
        </div>
      </div>
    );
  };

  return (
    <>
      <UniversalPipelineChat 
        mode="llmagent"
        chat={chat}
        title="Experiment LLM Agent"
        phases={LLMAgentPhases}
        currentProgressPhase={currentProgressPhase}
        activeReasoning={activeReasoning}
        isChatLocked={isChatLocked}
        isRollingBack={isRollingBack}
        isButtonDisabled={isButtonDisabled}
        executionMode={executionMode}
        setExecutionMode={setExecutionMode}
        onRollback={handleRollbackClick}
        onSubmit={handleSubmit}
        formatPhaseName={formatPhaseName}
        renderMessage={renderMessage}
        negotiationQuestions={negotiationQuestions}
        negotiationAnswers={negotiationAnswers}
        setNegotiationAnswers={setNegotiationAnswers}
        sessionLabel="Experiment"
        startNewChat={startNewChat}
        handleDownloadChat={handleDownloadChat}
        handleDeleteChat={handleDeleteChat}
        isPendingRetry={isPendingRetry}
        onRetryPlanning={handleRetryPlanning}
        onTerminateExperiment={handleTerminateExperiment}
        inputPlaceholder={inputPlaceholder}
        onLoadHistory={handleLoadHistory}
        chatEndRef={chatEndRef}
        reasoningRef={reasoningRef}
      />

      {/* Admin Debugger View */}
      {isAdmin && (
        <AdminReadOnlyDebugger 
            username={username}
            reservation_id={reservation_id}
            activeChatId={chat.activeChatId}
            phases={LLMAgentPhases}
            renderMessage={renderMessage}
            agentNames={chat.agentNames}
        />
      )}
      {/*rollback confirmation window*/}
      {isRollbackModalOpen && (
        <div className="en-modal-overlay">
          <div className="en-modal-content">
            <div className="en-modal-header">
              <h3>Confirm Rollback</h3>
              <p>Are you sure you want to rollback the experiment? This will revert the testbed to the initial snapshot and reset the current chat.</p>
            </div>
            <div className="en-modal-footer">
              <button className="en-btn-cancel" onClick={() => setIsRollbackModalOpen(false)}>Cancel</button>
              <button className="en-btn-confirm" onClick={() => {setIsRollbackModalOpen(false); executeRollback();}}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default LLMAgent;