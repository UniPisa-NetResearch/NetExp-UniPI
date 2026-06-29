import React, { useState, useEffect } from "react";
import "./style/llmAgent.css";

// pipeline phases (each phase corresponds to an agent)
const PHASES = ['negotiation', 'planning', 'safety', 'execution'];

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
  const [extractedPayload, setExtractedPayload] = useState("");
  const [needsClarification, setNeedsClarification] = useState(false);

  // to distinguish experiment running or chat visualization after experiment
  const [isReadOnly, setIsReadOnly] = useState(false);
  // input enabled only for negotiation phase and safety phase in case of clarification is needed
  const isInputDisabled = isReadOnly || currentPhase === 'planning' || currentPhase === 'execution' || (currentPhase === 'safety' && !needsClarification);
  
  // determine if the user input is empty (no text and no files)
  const isInputEmpty = inputValue.trim() === "" && selectedFiles.length === 0;
  const isButtonDisabled = isSending || isInputEmpty || isInputDisabled;
  
  const startNewChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setSelectedFiles([]);
    setError(null);
    setCanAdvance(false);
    setCurrentPhase('negotiation');
    setIsReadOnly(false);
  };
  // reset all fields between different agents
  useEffect(() =>{

    startNewChat();

  }, []);

  useEffect(() => {
    const fetchSessions = async () => {
      if (!username || !reservation_id) return;
      try {
        const response = await fetch(
          `/api/agent_server/sessions?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&agent_role=${encodeURIComponent(currentPhase)}`
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
  }, [username, reservation_id, currentPhase]);

  // load the chat history for a specific chat_id
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

          // if we are loading from the sidebar or going ahead in the history
          setIsReadOnly(true); 
          
          // we enable the advancing in the historical case (not for the execution phase)
          if (phase !== 'execution') {
            setCanAdvance(true);
          }
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

  const parseLLMResponse = (reply, phase) => {
    if (!reply) return;
    let payload = "";

    const isApproved = /###\s*STATUS[\s\S]*?APPROVED/i.test(reply);

    if (phase === 'negotiation' && isApproved) {

      setCanAdvance(true);

      const match = reply.match(/###\s*CONTEXT FOR PLANNING AGENT([\s\S]*)/i);
      if (match) payload = match[1].trim();

    } else if (phase === 'planning' && isApproved) {

      setCanAdvance(true);

      let executionPlan = "";
      let safetyContext = "";
      
      const matchExecution = reply.match(/###\s*EXECUTION PLAN[\s\S]*?(?=###\s*VERIFICATION|###\s*STATUS|###\s*CONTEXT|$)/i);
      if (matchExecution) executionPlan = matchExecution[0].trim();

      
      const matchContext= reply.match(/###\s*CONTEXT FOR SAFETY AGENT[\s\S]*/i);
      if (matchContext) safetyContext = matchContext[0].trim();

      // merge two headers
      if (executionPlan || safetyContext) {
        payload = `${matchExecution}\n\n${matchContext}`;
      }

    } else if (phase === 'safety') {

      if (isApproved) {

        setCanAdvance(true);
        setNeedsClarification(false);

        const match = reply.match(/###\s*EXECUTABLE PLAN([\s\S]*?)(?=###\s*CLARIFYING QUESTIONS|$)/i);
        
        if (match){
          const planText = match[1].trim();
          
          // if the plan is not 'N/A', we extract it
          if (!/^N\/A$/i.test(planText)) {
            payload = planText;
          }
        }
      } else {
        // if not Approved, backend exausted each attempt, unlock user input
        setNeedsClarification(true);
      }

      const questionsMatch = reply.match(/###\s*CLARIFYING QUESTIONS([\s\S]*)/i);

      if (questionsMatch) {
        
        const questionsText = questionsMatch[1].trim();
        
        // enable user input if the section is not empty or "None"
        if (questionsText && !/^none$/i.test(questionsText)) {
          setNeedsClarification(true);
        }
      }
    }
    if (payload) setExtractedPayload(payload);
  };

  const handleAdvance = () => {
    const currentIndex = PHASES.indexOf(currentPhase);
    if (currentIndex < PHASES.length - 1) {
      const nextPhase = PHASES[currentIndex + 1];

      if (isReadOnly) {
      // MODALITÀ STORICO: Non chiamiamo l'LLM, carichiamo solo la history della fase successiva da Redis
      loadHistory(activeChatId, nextPhase);
      } else {
        setCurrentPhase(nextPhase);
        setCanAdvance(false);
        setMessages([]); // clean chat for new view
        
        // automatic change to next agent
        if (extractedPayload) {
          handleSubmit(null, extractedPayload, nextPhase);
        }
      }
    } else {
      startNewChat(); // return at negotiation phase after execution (both live and history)
    }
  };

  const handleSubmit = async (e, autoText = null, autoPhase = null) => {
    if(e) e.preventDefault();
    setError(null);

    const targetPhase = autoPhase || currentPhase;
    const textToSend = autoText !== null ? autoText : inputValue.trim();
    const filesToSend = autoText !== null ? [] : selectedFiles;

    if (!textToSend && filesToSend.length === 0) return;

    if (autoText !== null) {
      appendMessage("user", `${textToSend}`);
    } else if (textToSend) {
      appendMessage("user", textToSend);
    }

    setIsSending(true);

    try {
      const formData = new FormData();
      if (textToSend) formData.append("message", textToSend);
      formData.append("agent_role", targetPhase);
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
      
      if (targetPhase === 'safety' && data.reasoning_steps) {
         data.reasoning_steps.forEach((step, index) => {
            appendMessage("assistant", `[Iteration ${step.iteration}]\n${step.content}`);
         });
      } else if (data.reply) {
         appendMessage("assistant", data.reply);
      }

      if (data.chat_id && !activeChatId) {
        setActiveChatId(data.chat_id);
        if (targetPhase === 'negotiation') setSavedChats((prev) => [data.chat_id, ...prev]);
      }

      if (autoText === null) {
        setInputValue("");
        setSelectedFiles([]);
      }

      // analyze response to unlock next phase
      const finalReply = (data.reasoning_steps && data.reasoning_steps.length > 0)
      ? data.reasoning_steps[data.reasoning_steps.length - 1].content : data.reply;

      parseLLMResponse(finalReply, targetPhase);
      if (targetPhase === 'execution') setCanAdvance(true);

    } catch (err) {
      console.error("Error sending message:", err);
      setError(err.message || "Unexpected error occurred while sending the message.");
      appendMessage("assistant", "An error occurred.");
    } finally {
      setIsSending(false);
    }
  };

  const renderMessage = (message) => {
    const isUser = message.role === "user";

    let displayContent = message.content;

    if (isUser && displayContent) {
      // remove file content from the user message and replace with a placeholder
      const fileRegex = /--- Start attached file content: (.*?) ---[\s\S]*?--- End attached file content: \1 ---/g;
      // show the file name in the user message and remove the content for better readability
      displayContent = displayContent.replace(fileRegex, "\n[Attached file: $1]\n");
      
      displayContent = displayContent.trim();
    }

    return (
      <div
        key={message.id}
        className={`en-message-bubble ${
          isUser ? "en-message-user" : "en-message-assistant"
        }`}
      >
        <div className="en-message-role">
          {isUser ? `${username}` : `LLM ${currentPhase.charAt(0).toUpperCase() + currentPhase.slice(1)} Agent`}
        </div>
        <div className="en-message-content">{displayContent}</div>
      </div>
    );
  };

  return (
    <div className="experiment-negotiation-container">

      <div className="en-stepper">
        {PHASES.map((phase, idx) => (
          <div key={phase} className={`en-step ${currentPhase === phase ? 'active' : ''} ${PHASES.indexOf(currentPhase) > idx ? 'completed' : ''}`}>
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
          {canAdvance && (
            <button className="en-transition-btn" onClick={handleAdvance}>
                {currentPhase === 'execution' ? "Finish & Return to Start" : (isReadOnly ? `View ${PHASES[PHASES.indexOf(currentPhase) + 1].toUpperCase()} History` : `Proceed to ${PHASES[PHASES.indexOf(currentPhase) + 1].toUpperCase()}`)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default LLMAgent;