import React, { useState, useEffect } from "react";
import "./style/llmAgent.css";
import { ChatSidebar, FileUploader, ChatHeader } from "./LLMAgents/SharedChatComponents";
import { useAgentChat, sendChatRequest } from "./LLMAgents/useAgentChat";

const LLMAgent = ({ username, reservation_id}) => {
  const chat = useAgentChat(username, reservation_id, "negotiation");

  const [currentPhase, setCurrentPhase] = useState('negotiation');
  // current phase during an active experiment
  const [activePipelinePhase, setActivePipelinePhase] = useState('negotiation');

  const [negotiationQuestions, setNegotiationQuestions] = useState([]);
  const [negotiationAnswers, setNegotiationAnswers] = useState({});

  const [canAdvance, setCanAdvance] = useState(false);
  const [needsClarification, setNeedsClarification] = useState(false);

  // to distinguish experiment running or chat visualization after experiment
  const [isReadOnly, setIsReadOnly] = useState(false);
  // pipeline phases (each phase corresponds to an agent)
  const [phases, setPhases] = useState([]);

  // visualizing a past phase during an active experiment
  const isViewingPastPhase = !isReadOnly && currentPhase !== activePipelinePhase;

  // input enabled only for negotiation phase and safety phase in case of clarification is needed
  const isInputDisabled = chat.isSending || isReadOnly || isViewingPastPhase || canAdvance || currentPhase === 'planning' || currentPhase === 'execution' || (currentPhase === 'safety' && !needsClarification);
  
  // determine if the user input is empty (no text and no files)
  const isInputEmpty = chat.inputValue.trim() === "" && chat.selectedFiles.length === 0;

  // check if there are questions and if the user has written every answer
  const hasUnansweredQuestions = negotiationQuestions.length > 0 && !negotiationQuestions.every((_, i) => (negotiationAnswers[i] || "").trim() !== "");

  const isButtonDisabled = chat.isSending ||  isInputDisabled || (negotiationQuestions.length > 0 ? hasUnansweredQuestions : isInputEmpty);

  // phases states to use navigation buttons
  const currentPhaseIndex = phases.indexOf(currentPhase);
  const hasPreviousPhase = currentPhaseIndex > 0;
  const hasNextPhase = currentPhaseIndex !== -1 && currentPhaseIndex < phases.length - 1;
  const previousPhase = hasPreviousPhase ? phases[currentPhaseIndex - 1] : null;
  const nextPhase = hasNextPhase ? phases[currentPhaseIndex + 1] : null;

  // states for the ACTIVE pipeline
  const activePhaseIndex = phases.indexOf(activePipelinePhase);
  const hasNextActivePhase = activePhaseIndex !== -1 && activePhaseIndex < phases.length - 1;
  const nextActivePhase = hasNextActivePhase ? phases[activePhaseIndex + 1] : null;
  // approved or rejected
  const [executionStatus, setExecutionStatus] = useState(null);                     
  // rollback states
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [showRollbackModal, setShowRollbackModal] = useState(false);
  // serial or parallel
  const [executionMode, setExecutionMode] = useState("serial");

  // show "Go back to planning" if execution is rejected and iterations are not ended
  const isExecutionLoopActive = activePipelinePhase === 'execution' && executionStatus === 'REJECTED';

  const executeRollback = async () => {
    if (!chat.activeChatId) return;                                  // if there are no active chat, rollback is unnecessary
    
    chat.setIsSending(true);                                         // lock UI during rollback
    try {
      const response = await fetch("/api/agent_server/experimentRollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, reservation_id: reservation_id, chat_id: chat.activeChatId}),
      });

      if (!response.ok) {
        console.error("Error during testbed rollback");
      }

    } catch (err) {
      console.error("Network error duringrollback:", err);
    } finally {
      chat.setIsSending(false);
    }
  };

  const startNewChat = async (skipModal = false) => {

    // reset only if we pass explicitly
    const forceReset = skipModal === true;

    // rollback performed only if there is an active chat and we are not in history mode
    if (!forceReset && chat.activeChatId && !isReadOnly && executionStatus !== null) {

      setShowRollbackModal(true);
      return;   
  
    } 

    chat.resetBaseChat();
    setExecutionMode("serial");
    setNegotiationQuestions([]);
    setNegotiationAnswers({});
    setCanAdvance(false);
    setCurrentPhase('negotiation');
    setActivePipelinePhase('negotiation');
    setIsReadOnly(false);
    setExecutionStatus(null);

    
  };

  const handleConfirmRollback = async () => {
    
    setShowRollbackModal(false);   
    setIsRollingBack(true);    
    await executeRollback();
    setIsRollingBack(false);
    await startNewChat(true);

  };

  const handleDeclineRollback = async () => {
    setShowRollbackModal(false);
    await startNewChat(true);
  };

  // reset all fields when a new chat is started (either from the button or after the execution phase)
  useEffect(() =>{ startNewChat(); }, []);

  useEffect(() => {
    chat.fetchSessions("negotiation").then(data => {
      
      if (data && data.phases_order && phases.length === 0) { setPhases(data.phases_order);}

    });
    
  }, [chat.fetchSessions, phases.length]);

  // load the chat history for a specific chat_id and phase
  const loadLLMHistory = async (chatId, phase, fromSidebar = false) => {
    const loadedMessages = await chat.loadHistory(chatId, phase);
    if (loadedMessages) {
      setCurrentPhase(phase);
          
      // advance with buttons in history mode
      if (fromSidebar) {
        // if we are loading from the sidebar or going ahead in the history
        setIsReadOnly(true); 
        // we enable the advancing in the historical case
        setCanAdvance(true);
      }
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

  const handleInputChange = (e) => {
    chat.setInputValue(e.target.value);
  };

  // parse a JSON string returned by the backend and update UI state, so the user can proceed to the next phase when allowed
  const parseLLMResponse = (reply, phase) => {
    // ignore empty values or non-string payloads to keep parsing predictable
    if (!reply || typeof reply !== "string") return;

    try {
      // backend responses are normalized as JSON strings
      const parsed = JSON.parse(reply);

      // normalize status checks to avoid case-sensitivity issues
      const status = (parsed.status || "").toUpperCase();

      // negotiation and planning can advance only after an approved status
      if (phase === 'negotiation' || phase === 'planning') {

        if (status.includes("APPROVED")) { 
          
          setCanAdvance(true);
          // hide the form if the status is approved
          setNegotiationQuestions([]);

        } else if (phase === 'negotiation') {
          // extract clarifying questions
          const questions = parsed.clarifying_questions;
          if (Array.isArray(questions) && questions.length > 0 && String(questions[0]).toLowerCase() !== "none") {
            setNegotiationQuestions(questions);
            
            const initialAnswers = {};
            questions.forEach((_, i) => { initialAnswers[i] = ""; });
            setNegotiationAnswers(initialAnswers);

          } else {
            setNegotiationQuestions([]); // no questions, show the chat
          }
        }

      // safety may either approve the plan or require more user input  
      } else if (phase === 'safety') {

        if (status.includes("APPROVED")) {

          setCanAdvance(true);
          setNeedsClarification(false);

        } else {
          setNeedsClarification(true);
        }

        // any clarification question keeps the input enabled for the user
        const questions = parsed.clarifying_questions;
        if (questions && String(questions).toLowerCase() !== "none") {

          setNeedsClarification(true);

        }

      // execution is the terminal phase, so completion unlocks the final action
      } else if (phase === 'execution') {
        setCanAdvance(true);
        setExecutionStatus(status);
      }
    } catch (e) {
      console.error("Failed to parse JSON response:", e);
    }
  };

  // move the current conversation to the next agent phase, in read-only mode, this only loads stored history from Redis
  const handleAdvance = async (overrideNextPhase = null) => {
    // overrideNextPhase has value when the current phase is execution and a new planning is needed
    const actualNextPhase = overrideNextPhase || (isReadOnly ? nextPhase : nextActivePhase);
    
    // advance only if a next phase exists
    if (actualNextPhase) {

      if (isReadOnly) {

        // load only history of next phase on redis in history mode
        loadLLMHistory(chat.activeChatId, actualNextPhase, true);

      } else {

        // switch the UI immediately to the next phase and show a loading state
        setCurrentPhase(actualNextPhase);
        setActivePipelinePhase(actualNextPhase);
        setCanAdvance(false);
        chat.setMessages([]); // clean chat for new view
        setNegotiationQuestions([]);
        setNegotiationAnswers({});
        chat.setIsSending(true);

        try {
          // ask the backend to forward the validated context to the next agent
          const response = await fetch("/api/agent_server/advance", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
              username: username,
              reservation_id: reservation_id,
              chat_id: chat.activeChatId,
              current_agent: currentPhase,
              next_agent: actualNextPhase,
              llm_model: chat.selectedModel,
              execution_mode: executionMode
            }),
          });

          const data = await response.json();

          if (response.ok) {
            // show the auto-forwarded context so the user can see what was passed downstream
            if (data.context_sent) {
              chat.appendMessage("user", `[System: Auto-forwarded context from ${currentPhase}]\n\n${data.context_sent}`);
            }

            // safety may return multiple correction iterations; render each one separately
            if (data.reasoning_steps && data.reasoning_steps.length > 0) {

              data.reasoning_steps.forEach((step) => {chat.appendMessage(step.role || "assistant", `[Iteration ${step.iteration}]\n${step.content}`);});

            } else if (data.reply) {
              // other phases return a single final reply
              chat.appendMessage("assistant", data.reply);
            }

            // use the last reasoning step as the authoritative result when present
            const finalReply = (data.reasoning_steps && data.reasoning_steps.length > 0) ? data.reasoning_steps[data.reasoning_steps.length - 1].content : data.reply;

            parseLLMResponse(finalReply, actualNextPhase);
            
          } else {
            console.error("Error advancing:", data.error);
            chat.setError(data.error || "Failed to advance to the next agent.");
          }
        } catch (err) {
          console.error("Network error advancing:", err);
          chat.setError("Network error advancing.");
        } finally {
          chat.setIsSending(false);
        }
      }
    } else {
      startNewChat(); // return at negotiation phase after execution (both live and history)
    }
  };

  // go to the previous phase in history navigation
  const handleGoBackHistory = async () => {
    if (!isReadOnly || !chat.activeChatId || !hasPreviousPhase) return;
    loadLLMHistory(chat.activeChatId, previousPhase, true);
  };

  // terminate experiment and return to negotiation phase (click End Experiment session)
  const handleCancelPipeline = () => {
    if (chat.isSending) return;
    startNewChat();
  };

  const handleStepperClick = (clickedPhase) => {
    // click is ignored if there is not an active chat, if the system is sending a request to the LLM, or if the user click the voice of the menu of the current phase
    if (!chat.activeChatId || currentPhase === clickedPhase || chat.isSending) return;

    // in History Mode the menu is not active
    if (isReadOnly) return;
    
    // load history for the clicked phase (it automatically set isReadOnly = true)
    loadLLMHistory(chat.activeChatId, clickedPhase, false);
  };

  // send a user message and optional files to the current agent
  const handleSubmit = async (e, autoText = null, autoPhase = null) => {
    if(e) e.preventDefault();
    chat.setError(null);

    let textToSend = chat.inputValue.trim();

    // if there are questions, create formatted text and ignore the inputValue
    if (currentPhase === 'negotiation' && negotiationQuestions.length > 0) {
      textToSend = negotiationQuestions.map((q, i) => `${i + 1}. ${q}\nAnswer: ${negotiationAnswers[i]}`).join('\n\n');
    }

    if (!textToSend && chat.selectedFiles.length === 0) return;

    chat.appendMessage("user", textToSend);
    
    chat.setIsSending(true);

    try {
      // build a multipart request because the payload may include uploaded files

      const data = await sendChatRequest("/api/agent_server/chat", {
        message: textToSend, username, reservation_id, chat_id: chat.activeChatId,
        agent_role: currentPhase, is_manual_chat: "true", llm_model: chat.selectedModel
      }, chat.selectedFiles);
      
      // safety can emit multiple self-correction iterations before producing a final outcome
      if (currentPhase === 'safety' && data.reasoning_steps) {

         data.reasoning_steps.forEach((step) => {
            chat.appendMessage(step.role || "assistant", `[Iteration ${step.iteration}]\n${step.content}`);
         });

      } else if (data.reply) {
        // other agents return only one message
        chat.appendMessage("assistant", data.reply);
      }

      // persist the generated chat id so later phases and history use the same session
      if (data.chat_id && !chat.activeChatId) {
        chat.setActiveChatId(data.chat_id);
        if (currentPhase === 'negotiation') chat.setSavedChats((prev) => [data.chat_id, ...prev]);
      }

      chat.setInputValue("");
      chat.setSelectedFiles([]);
      setNegotiationQuestions([]);
      setNegotiationAnswers({});

      // analyze response to unlock next phase
      const finalReply = (data.reasoning_steps && data.reasoning_steps.length > 0) ? data.reasoning_steps[data.reasoning_steps.length - 1].content : data.reply;

      parseLLMResponse(finalReply, currentPhase);

    } catch (err) {
      console.error("Error sending message:", err);
      chat.setError(err.message || "Unexpected error occurred while sending the message.");
      chat.appendMessage("assistant", "An error occurred.");
    } finally {
      chat.setIsSending(false);
    }
  };

  // render structured JSON responses in a readable key/value layout
  const renderStructuredContent = (parsed) => {
    // list of fields to show without numbers
    const plainCommandFields = ["execution_plan", "verification", "executable_plan", "verification_plan"];
    return (
      <div>
        {Object.entries(parsed).map(([key, value]) => (
          <div key={key} className="en-backend-message">
            {/* convert keys into readable section labels */}
            <strong className="en-backend-message-header"> {key.replace(/_/g, " ")} </strong>
            {/* add None for empty arrays or a list of items */}
            {Array.isArray(value) ? (
              value.length === 0 ? (
                <p className="en-backend-message-key">None</p>
              ) : plainCommandFields.includes(key) ? (
                <div className="en-backend-message-list-plain">
                  {value.map((item, i) => (
                    <div key={i} className="en-backend-message-list-element">{item}</div>
                  ))}
                </div>
              ) : (
                <div className="en-backend-message-numbered-list">
                  {value.map((item, i) => (
                    <div key={i} className="en-backend-message-numbered-row">
                      <span className="en-backend-message-number">{i + 1}.</span>
                      <span className="en-backend-message-list-element">{item}</span>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <p className="en-backend-message-key">{String(value)}</p>
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
      // remove file content from the user message and replace with a placeholder
      const fileRegex = /--- Start attached file content: (.*?) ---[\s\S]*?--- End attached file content: \1 ---/g;
      // show the file name in the user message and remove the content for better readability
      displayContent = displayContent.replace(fileRegex, "\n[Attached file: $1]\n");
      
      return (
        <div key={message.id} className="en-message-bubble en-message-user">
          <div className="en-message-role">{username}</div>
          <div className="en-message-content">{displayContent}</div>
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
          {`LLM ${currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1)} Agent`}
        </div>
        <div className="en-message-content">
          {formattedContent ? (
            formattedContent
            ) : (
              <span style={{ whiteSpace: "pre-wrap" }}>
                {typeof displayContent === "string" ? displayContent : JSON.stringify(displayContent, null, 2)}
              </span>
            )}
        </div>
      </div>
    );
  };

  return (
    <div className="experiment-negotiation-container">

      <div className={`en-stepper ${isReadOnly ? 'history-mode' : ''}`}>
        {phases.map((phase, idx) => {
          // true if the current step is active
          const isActive = currentPhase === phase;

          // if history mode, completed steps are computed respect to currentPhase. While if active, completed steps are computed respect to activePipelinePhase
          const isCompleted = isReadOnly ? phases.indexOf(currentPhase) > idx : phases.indexOf(activePipelinePhase) > idx;
          // yellow shown only in active mode
          const isPipelineActive = !isReadOnly && phase === activePipelinePhase && currentPhase !== activePipelinePhase;

          // cickable if: active experiment, not loading, not the visualized current phase
          const isClickable = !isReadOnly && !chat.isSending && currentPhase !== phase;

          return (
            <div key={phase} className={`en-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''} ${isPipelineActive ? 'pipeline-active' : ''} ${isClickable ? 'clickable' : ''}`}
              onClick={() => handleStepperClick(phase)}>
              {phase.toUpperCase()}
            </div>
          );
        })}
      </div>

      <ChatHeader 
        title={`${currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1)} Agent`}
        availableModels={chat.availableModels}
        selectedModel={chat.selectedModel}
        onModelChange={chat.setSelectedModel}
        isDisabled={chat.isSending || isReadOnly}
      />

      {/* Agent response area */}
      <div className="experiment-negotiation-main">
        <ChatSidebar
          savedChats={chat.savedChats}
          activeChatId={chat.activeChatId}
          isSending={chat.isSending}
          disableListActions={chat.activeChatId !== null}
          onNewChat={startNewChat}
          onDownloadChat={handleDownloadChat}
          onLoadHistory={(id) => loadLLMHistory(id, 'negotiation', true)}
          onDeleteChat={handleDeleteChat}
          sessionLabel="Conversation"
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
                {chat.messages.map((msg) => renderMessage(msg))}
                {chat.isSending && (
                  <div className="en-message-bubble en-message-assistant">
                    <div className="en-message-role">LLM Agent</div>
                    <div className="en-message-content">Computing response, please wait...</div>
                  </div>
                )}
              </>
            )}
          </div>

          <form className="en-input-area" onSubmit={handleSubmit} autoComplete="off">
            <div className="en-input-actions-wrapper">
              <FileUploader
                selectedFiles={chat.selectedFiles}
                isInputDisabled={isInputDisabled}
                onFileChange={chat.handleFileChange}
                onRemoveFile={chat.handleRemoveFile}
              />

              <div className="en-execution-toggle-container">
                  <span className="en-toggle-label">Select execution type: </span>
                  
                  <label className="en-switch">
                    <input
                      type="checkbox"
                      checked={executionMode === 'parallel'}
                      disabled={!(currentPhase === 'safety' && canAdvance) || isReadOnly}
                      onChange={(e) => setExecutionMode(e.target.checked ? 'parallel' : 'serial')}
                    />
                    <span className="en-slider"></span>
                  </label>
                  <span className={`en-toggle-status ${executionMode === 'parallel' ? 'parallel' : ''}`}>{executionMode === 'parallel' ? 'Parallel' : 'Serial'}</span>
              </div>
            </div>

            <div className="en-input-row">
              {currentPhase === 'negotiation' && negotiationQuestions.length > 0 && !isReadOnly && currentPhase === activePipelinePhase ? (
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
                  onChange={handleInputChange}
                  placeholder={currentPhase === "negotiation" ? "Describe the experiment you want to run..." : "Describe the topology and insert all requested information..."}
                  rows={3}
                  disabled={isInputDisabled}
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
              {chat.error && (<div className="en-error-message">{chat.error}</div>)}
          </form>
          
          <div className="en-transition-actions">
            {/* transition buttons to navigate in the history*/}
            {isReadOnly ? (
              <>
                <button
                  className={`en-transition-btn en-secondary-transition-btn ${(!hasPreviousPhase || chat.isSending) ? "en-transition-btn-disabled" : ""}`}
                  onClick={handleGoBackHistory}
                  disabled={!hasPreviousPhase || chat.isSending}
                >
                  {hasPreviousPhase ? `View ${previousPhase.toUpperCase()} History` : "No Previous History"}
                </button>

                <button
                  className={`en-transition-btn en-primary-transition-btn ${(!canAdvance || chat.isSending) ? "en-transition-btn-disabled" : ""}`}
                  onClick={() => handleAdvance()}
                  disabled={!canAdvance || chat.isSending}
                >
                  {hasNextPhase ? `View ${nextPhase.toUpperCase()} History` : "Back to NEGOTIATION"}
                </button>
              </>
            ) : (
              <>
                {/* transition buttons to navigate during experiment*/}
                <button
                  className={`en-transition-btn en-secondary-transition-btn ${chat.isSending ? "en-transition-btn-disabled" : ""}`}
                  onClick={handleCancelPipeline}
                  disabled={chat.isSending}
                >
                  End Experiment Session
                </button>

                {isExecutionLoopActive && currentPhase === 'execution' ? (
                  <button
                      className={`en-transition-btn en-primary-transition-btn ${(chat.isSending) ? "en-transition-btn-disabled" : ""}`}
                      onClick={() => handleAdvance('planning')}
                      disabled={chat.isSending}
                  >
                      Go back to PLANNING
                  </button>
                ) : (
                  <button
                    className={`en-transition-btn en-primary-transition-btn ${(!canAdvance || chat.isSending || isViewingPastPhase) ? "en-transition-btn-disabled" : ""}`}
                    onClick={() => handleAdvance ()}
                    disabled={!canAdvance || chat.isSending || isViewingPastPhase}
                  >
                    {hasNextPhase ? `Proceed to ${nextPhase.toUpperCase()}` : "Finish & Return to Start"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {showRollbackModal && (
        <div className="en-modal-overlay">
          <div className="en-modal-content">
            <div className="en-modal-header">
              <h3>Rollback Experiment</h3>
              <p>An execution phase was detected for this session. Do you want to rollback the configurations applied to the testbed?</p>
            </div>
            <div className="en-modal-footer">
              <button className="en-btn-cancel" onClick={handleDeclineRollback}>No, skip rollback</button>
              <button className="en-btn-confirm" onClick={handleConfirmRollback}>Yes, run rollback</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LLMAgent;