import React, { useState, useEffect } from "react";
import "./style/llmAgent.css";

const LLMAgent = ({ username, reservation_id}) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  // State to hold saved chat sessions
  const [savedChats, setSavedChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);

  const [currentPhase, setCurrentPhase] = useState('negotiation');
  const [canAdvance, setCanAdvance] = useState(false);
  const [needsClarification, setNeedsClarification] = useState(false);

  // to distinguish experiment running or chat visualization after experiment
  const [isReadOnly, setIsReadOnly] = useState(false);
  // pipeline phases (each phase corresponds to an agent)
  const [phases, setPhases] = useState([]);
  // input enabled only for negotiation phase and safety phase in case of clarification is needed
  const isInputDisabled = isReadOnly || canAdvance ||currentPhase === 'planning' || currentPhase === 'execution' || (currentPhase === 'safety' && !needsClarification);
  
  // determine if the user input is empty (no text and no files)
  const isInputEmpty = inputValue.trim() === "" && selectedFiles.length === 0;
  const isButtonDisabled = isSending || isInputEmpty || isInputDisabled;

  // phases states to use navigation buttons
  const currentPhaseIndex = phases.indexOf(currentPhase);
  const hasPreviousPhase = currentPhaseIndex > 0;
  const hasNextPhase = currentPhaseIndex !== -1 && currentPhaseIndex < phases.length - 1;
  const previousPhase = hasPreviousPhase ? phases[currentPhaseIndex - 1] : null;
  const nextPhase = hasNextPhase ? phases[currentPhaseIndex + 1] : null;

  const [maxExecutionIterations, setMaxExecutionIterations] = useState(null);
  const [executionStatus, setExecutionStatus] = useState(null);                     // approved or rejected

  const [executionCount, setExecutionCount] = useState(0);                          // count the number of execution iterations, reset at every new chat

  // show "Go back to planning" if execution is rejected and iterations are not ended
  const isExecutionLoopActive = currentPhase === 'execution' && executionStatus === 'REJECTED' && executionCount < maxExecutionIterations;

  
  const startNewChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setSelectedFiles([]);
    setError(null);
    setCanAdvance(false);
    setCurrentPhase('negotiation');
    setExecutionCount(0);
    setIsReadOnly(false);
    setExecutionStatus(null);
  };
  // reset all fields when a new chat is started (either from the button or after the execution phase)
  useEffect(() =>{ startNewChat(); }, []);

  useEffect(() => {
    const fetchSessions = async () => {
      if (!username || !reservation_id) return;
      try {
        const response = await fetch(
          `/api/agent_server/sessions?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&agent_role=${encodeURIComponent("negotiation")}`
        );
        if (response.ok) {
          // retrieve the list of chats and the ist of ordered phases from the backend
          const data = await response.json();
          setSavedChats(data.chat_ids || []);
          
          if (data.phases_order && phases.length === 0) { setPhases(data.phases_order);}
          
          if (data.max_iterations) { setMaxExecutionIterations(data.max_iterations); }
        }
      } catch (err) {
        console.error("Error fetching sessions:", err);
      }
    };
    fetchSessions();
  }, [username, reservation_id]);

  // load the chat history for a specific chat_id and phase
  const loadHistory = async (chatId, phase) => {
    try {
      const response = await fetch(
        `/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=${encodeURIComponent(phase)}`
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
          setCurrentPhase(phase);

          if (phase === 'execution') {
            // update execution messages count based on number of user messages in the history
            const userMessageCount = data.messages.filter(msg => msg.role === 'user').length;
            setExecutionCount(userMessageCount);
          }

          // if we are loading from the sidebar or going ahead in the history
          setIsReadOnly(true); 
          
          // we enable the advancing in the historical case
          setCanAdvance(true);
        }
      }
    } catch (err) {
      console.error("Error loading history:", err);
    }
  };

  const handleDeleteChat = async (chatId, e) => {
    if(e) e.stopPropagation(); // avoid chat loading after button click
    
    if (currentPhase !== 'negotiation') return;

    try {
      const response = await fetch("/api/agent_server/history", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: username,
          reservation_id: reservation_id,
          chat_id: chatId
        }),
      });

      if (response.ok) {
        // remove the chat from the list
        setSavedChats((prev) => prev.filter((id) => id !== chatId));
        
        // if the removed chat is opened, we reset the interface
        if (activeChatId === chatId) {
          startNewChat();
        }
      } else {
        console.error("Failed to delete chat");
      }
    } catch (err) {
      console.error("Error deleting chat:", err);
    }
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  const handleFileChange = (e) => {
    const newFiles = Array.from(e.target.files || []);
   
    setSelectedFiles((prev) => {
      // array with already selected files to avoid duplicates
      const existingFileNames = prev.map((f) => f.name);
      
      // filtering new files, files already selected are not included
      const uniqueNewFiles = newFiles.filter(
        (f) => !existingFileNames.includes(f.name)
      );

      // merge of old and filtered new files
      return [...prev, ...uniqueNewFiles];
    });

    // reset input, browser will allow a new selection of a file that was removed
    e.target.value = null;
  };

  const handleRemoveFile = (fileName) => {
    setSelectedFiles((prev) => prev.filter((f) => f.name !== fileName));
};

  const appendMessage = (role, content) => {
    setMessages((prev) => [
      ...prev,
      {
        id: prev.length + 1,
        role,
        content,
      },
    ]);
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

        if (status.includes("APPROVED")) setCanAdvance(true);

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
    const actualNextPhase = overrideNextPhase || nextPhase;
    
    // advance only if a next phase exists
    if (actualNextPhase) {

      if (isReadOnly) {

        // load only history of next phase on redis in history mode
        loadHistory(activeChatId, actualNextPhase);

      } else {

        // switch the UI immediately to the next phase and show a loading state
        setCurrentPhase(actualNextPhase);
        setCanAdvance(false);
        setMessages([]); // clean chat for new view
        setIsSending(true);
        
        // increment execution counter
        if (actualNextPhase === 'execution') {
          setExecutionCount(prev => prev + 1);
        }

        try {
          // ask the backend to forward the validated context to the next agent
          const response = await fetch("/api/agent_server/advance", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              username: username,
              reservation_id: reservation_id,
              chat_id: activeChatId,
              current_agent: currentPhase,
              next_agent: actualNextPhase
            }),
          });

          const data = await response.json();

          if (response.ok) {
            // show the auto-forwarded context so the user can see what was passed downstream
            if (data.context_sent) {
              appendMessage("user", `[System: Auto-forwarded context from ${currentPhase}]\n\n${data.context_sent}`);
            }

            // safety may return multiple correction iterations; render each one separately
            if (data.reasoning_steps && data.reasoning_steps.length > 0) {

              data.reasoning_steps.forEach((step) => {appendMessage("assistant", `[Iteration ${step.iteration}]\n${step.content}`);});

            } else if (data.reply) {
              // other phases return a single final reply
              appendMessage("assistant", data.reply);
            }

            // use the last reasoning step as the authoritative result when present
            const finalReply = (data.reasoning_steps && data.reasoning_steps.length > 0) ? data.reasoning_steps[data.reasoning_steps.length - 1].content : data.reply;

            parseLLMResponse(finalReply, actualNextPhase);
            
          } else {
            console.error("Error advancing:", data.error);
            setError(data.error || "Failed to advance to the next agent.");
          }
        } catch (err) {
          console.error("Network error advancing:", err);
          setError("Network error advancing.");
        } finally {
          setIsSending(false);
        }
      }
    } else {
      startNewChat(); // return at negotiation phase after execution (both live and history)
    }
  };

  // go to the previous phase in history navigation
  const handleGoBackHistory = async () => {
    if (!isReadOnly || !activeChatId || !hasPreviousPhase) return;
    loadHistory(activeChatId, previousPhase);
  };

  // terminate experiment and return to negotiation phase
  const handleCancelPipeline = () => {
    if (isSending) return;
    startNewChat();
  };

  // send a user message and optional files to the current agent
  const handleSubmit = async (e, autoText = null, autoPhase = null) => {
    if(e) e.preventDefault();
    setError(null);

    const textToSend = inputValue.trim();
    const filesToSend = selectedFiles;

    if (!textToSend && filesToSend.length === 0) return;

    appendMessage("user", textToSend);
    
    setIsSending(true);

    try {
      // build a multipart request because the payload may include uploaded files
      const formData = new FormData();
      if (textToSend) formData.append("message", textToSend);
      formData.append("agent_role", currentPhase);
      if (username) formData.append("username", username);
      if (reservation_id) formData.append("reservation_id", reservation_id);
      if (activeChatId) formData.append("chat_id", activeChatId);

      filesToSend.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/agent_server/chat", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Error in backend call");
      }

      const data = await response.json();
      
      // safety can emit multiple self-correction iterations before producing a final outcome
      if (currentPhase === 'safety' && data.reasoning_steps) {

         data.reasoning_steps.forEach((step, index) => {
            appendMessage("assistant", `[Iteration ${step.iteration}]\n${step.content}`);
         });

      } else if (data.reply) {
        // other agents return only one message
         appendMessage("assistant", data.reply);
      }

      // persist the generated chat id so later phases and history use the same session
      if (data.chat_id && !activeChatId) {
        setActiveChatId(data.chat_id);
        if (currentPhase === 'negotiation') setSavedChats((prev) => [data.chat_id, ...prev]);
      }

      setInputValue("");
      setSelectedFiles([]);

      // analyze response to unlock next phase
      const finalReply = (data.reasoning_steps && data.reasoning_steps.length > 0) ? data.reasoning_steps[data.reasoning_steps.length - 1].content : data.reply;

      parseLLMResponse(finalReply, currentPhase);

    } catch (err) {
      console.error("Error sending message:", err);
      setError(err.message || "Unexpected error occurred while sending the message.");
      appendMessage("assistant", "An error occurred.");
    } finally {
      setIsSending(false);
    }
  };

  // render structured JSON responses in a readable key/value layout
  const renderStructuredContent = (parsed) => {
    // list of fields to show without numbers
    const plainCommandFields = ["execution_plan", "verification", "executable_plan"];
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

      <div className="en-stepper">
        {phases.map((phase, idx) => (
          <div key={phase} className={`en-step ${currentPhase === phase ? 'active' : ''} ${phases.indexOf(currentPhase) > idx ? 'completed' : ''}`}>
            {phase.toUpperCase()}
          </div>
        ))}
      </div>

      <div className="experiment-negotiation-header">
        <h1>{currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1)} Agent</h1>
        <p className="en-fixed-message">
        </p>
      </div>
      {/* Agent response area */}
      <div className="experiment-negotiation-main">
        <div className={`experiment-negotiation-sidebar ${currentPhase !== 'negotiation' ? 'sidebar-disabled' : ''}`}>
          <button className="en-new-chat-btn" onClick={startNewChat} disabled={currentPhase !== 'negotiation'}>
            New Chat
          </button>
          <h3>Recent Chats</h3>
          {savedChats.length === 0 ? (
            <p className="en-sidebar-empty">No previous conversations.</p>
          ) : (
            <ul className="en-chat-list">
              {savedChats.map((chatId, index) => (
                <li key={chatId} className="en-chat-item-container">
                  <button
                    className={`en-chat-list-btn ${activeChatId === chatId ? "active" : ""}`}
                    onClick={() => loadHistory(chatId, 'negotiation')}
                    disabled={currentPhase !== 'negotiation'}
                  >
                    Conversation {savedChats.length - index}
                  </button>
                  <button
                    className="en-delete-chat-btn"
                    onClick={(e) => handleDeleteChat(chatId, e)}
                    disabled={currentPhase !== 'negotiation'}
                    title="Delete Chat"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="experiment-negotiation-chat">
          <div className="en-chat-window">
            {messages.map((msg) => renderMessage(msg))}
            {isSending && (
               <div className="en-message-bubble en-message-assistant">
                 <div className="en-message-role">LLM Agent</div>
                 <div className="en-message-content">Computing response, please wait...</div>
               </div>
            )}
          </div>

          <form className="en-input-area" onSubmit={handleSubmit} autoComplete="off">
            <div className="en-files-row">
              <div className="en-add-files-row">               
                <input id="en-file-input" type="file" disabled={isInputDisabled} multiple onChange={handleFileChange} className="en-file-input-hidden"/>
                <button type="button" className={`en-file-button ${isInputDisabled ? 'en-send-button-disabled' : ''}`} disabled={isInputDisabled}
                    onClick={() => {
                        const input = document.getElementById("en-file-input");
                        if (input) {input.click();}
                    }}
                >
                +
                </button>
                <span>Add files</span> 
              </div>
              {selectedFiles.length > 0 && (
                  <div className="en-file-list">
                      {selectedFiles.map((f) => (
                          <span key={f.name} className="en-file-pill">
                              <span className="en-file-name">{f.name}</span>
                              <button
                                  type="button"
                                  className="en-file-remove"
                                  onClick={() => handleRemoveFile(f.name)}
                              >
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
                placeholder={currentPhase === "negotiation" ? "Describe the experiment you want to run..." : "Describe the topology and insert all requested information..."}
                rows={3}
                disabled={isInputDisabled}
              />
              <button
                type="submit"
                className={`en-send-button ${isButtonDisabled ? "en-send-button-disabled" : ""}`}
                disabled={isButtonDisabled}
                aria-label="Send"
              >
                <span className="en-send-icon">↑</span>
              </button>
            </div>
              {error && (<div className="en-error-message">{error}</div>)}
          </form>
          
          <div className="en-transition-actions">
            {/* transition buttons to navigate in the history*/}
            {isReadOnly ? (
              <>
                <button
                  className={`en-transition-btn en-secondary-transition-btn ${(!hasPreviousPhase || isSending) ? "en-transition-btn-disabled" : ""}`}
                  onClick={handleGoBackHistory}
                  disabled={!hasPreviousPhase || isSending}
                >
                  {hasPreviousPhase ? `View ${previousPhase.toUpperCase()} History` : "No Previous History"}
                </button>

                <button
                  className={`en-transition-btn en-primary-transition-btn ${(!canAdvance || isSending) ? "en-transition-btn-disabled" : ""}`}
                  onClick={() => handleAdvance()}
                  disabled={!canAdvance || isSending}
                >
                  {hasNextPhase ? `View ${nextPhase.toUpperCase()} History` : "Back to NEGOTIATION"}
                </button>
              </>
            ) : (
              <>
                {/* transition buttons to navigate during experiment*/}
                <button
                  className={`en-transition-btn en-secondary-transition-btn ${isSending ? "en-transition-btn-disabled" : ""}`}
                  onClick={handleCancelPipeline}
                  disabled={isSending}
                >
                  Back to NEGOTIATION
                </button>

                {isExecutionLoopActive ? (
                  <button
                      className={`en-transition-btn en-primary-transition-btn ${isSending ? "en-transition-btn-disabled" : ""}`}
                      onClick={() => handleAdvance('planning')}
                      disabled={isSending}
                  >
                      Go back to PLANNING
                  </button>
                ) : (
                  <button
                    className={`en-transition-btn en-primary-transition-btn ${(!canAdvance || isSending) ? "en-transition-btn-disabled" : ""}`}
                    onClick={() => handleAdvance ()}
                    disabled={!canAdvance || isSending}
                  >
                    {hasNextPhase ? `Proceed to ${nextPhase.toUpperCase()}` : "Finish & Return to Start"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LLMAgent;