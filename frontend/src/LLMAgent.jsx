import React, { useState, useEffect } from "react";
import "./style/llmAgent.css";

const LLMAgent = ({ username, reservation_id, mode }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  // State to hold saved chat sessions
  const [savedChats, setSavedChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  // Determine if the user input is empty (no text and no files)
  const isInputEmpty = inputValue.trim() === "" && selectedFiles.length === 0;
  const isButtonDisabled = isSending || isInputEmpty;
  // state for commands/playbook upload
  const [playbooks, setPlaybooks] = useState([{ id: 1, content: ""}]);

  const handleAddPlaybook = () => {
    const nextId = playbooks.length > 0 ? Math.max(...playbooks.map(p => p.id)) + 1 : 1;
    setPlaybooks([...playbooks, { id: nextId, content: "" }]);
  };

  const handleRemovePlaybook = (id) => {
    setPlaybooks(playbooks.filter((p) => p.id !== id));
  };

  const handlePlaybookChange = (id, newContent) => {
    setPlaybooks(playbooks.map((p) => (p.id === id ? { ...p, content: newContent } : p)));
  };

  
  const startNewChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setSelectedFiles([]);
    setPlaybooks([{ id: 1, content: "" }]);
    setError(null);
  };
  // reset all fields between different agents
  useEffect(() =>{

    startNewChat();

  }, [mode]);

  useEffect(() => {
    const fetchSessions = async () => {
      if (!username || !reservation_id) return;
      try {
        const response = await fetch(
          `/api/agent_server/sessions?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&agent_role=${encodeURIComponent(mode)}`
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
  }, [username, reservation_id, mode]);

  // load the chat history for a specific chat_id
  const loadHistory = async (chatId) => {
    try {
      const response = await fetch(
        `/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=${encodeURIComponent(mode)}`
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    const trimmed = inputValue.trim();
    if (!trimmed && selectedFiles.length === 0) {
      return;
    }

    if (trimmed) {
      appendMessage("user", trimmed);
    }

    setIsSending(true);

    try {
      const formData = new FormData();

      let messageToSend = trimmed;
      
      if (mode === "safety") {
        const combinedPlaybooks = playbooks.filter(p => p.content.trim() !== "").map((p, index) => `--- File/Script ${index + 1} ---\n${p.content}`).join("\n\n");
        if (combinedPlaybooks !== "") {
          messageToSend = `PLAYBOOK/COMMANDS TO ANALYZE:\n${combinedPlaybooks}\n\nREQUEST:\n${trimmed}`;
        }
      }  
        
      if(messageToSend){
        formData.append("message", messageToSend)
      }
      if(mode){
        formData.append("agent_role", mode);
      }
      if (username) {
        formData.append("username", username);
      }
      if (reservation_id) {
        formData.append("reservation_id", reservation_id);
      }
      if (activeChatId) {
        formData.append("chat_id", activeChatId);
      }

      selectedFiles.forEach((file) => {
        formData.append("files", file);
      });

      const response = await fetch("/api/agent_server/chat", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Error in backend call");
      }

      const data = await response.json();
      if (data.reply) {
        appendMessage("assistant", data.reply);
      }

      if (data.chat_id && !activeChatId) {
        setActiveChatId(data.chat_id);
        setSavedChats((prev) => [data.chat_id, ...prev]);
      }

      setInputValue("");
      setSelectedFiles([]);
    } catch (err) {
      console.error("Error sending message:", err);
      setError(err.message || "Unexpected error occurred while sending the message.");
      appendMessage(
        "assistant",
        "An error occurred while negotiating the experiment."
      );
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
          {isUser ? "You" : "LLM Agent"}
        </div>
        <div className="en-message-content">{displayContent}</div>
      </div>
    );
  };

  return (
    <div className="experiment-negotiation-container">
      <div className="experiment-negotiation-header">
        <h1>{mode === "negotiation" ? "Negotiation Agent" : "Safety Check Agent"}</h1>
        <p className="en-fixed-message">
          {mode === "negotiation"
            ? "Describe the network experiment you want to run. You can also attach files (topologies, configurations, diagrams)."
            : "Paste the execution plan/playbook and describe the topology."
          }
        </p>
      </div>
      {/* Agent response area */}
      <div className="experiment-negotiation-main">
        <div className="experiment-negotiation-sidebar">
          <button className="en-new-chat-btn" onClick={startNewChat}>
            New Chat
          </button>
          <h3>Recent Chats</h3>
          {savedChats.length === 0 ? (
            <p className="en-sidebar-empty">No previous conversations.</p>
          ) : (
            <ul className="en-chat-list">
              {savedChats.map((chatId, index) => (
                <li key={chatId}>
                  <button
                    className={`en-chat-list-btn ${activeChatId === chatId ? "active" : ""}`}
                    onClick={() => loadHistory(chatId)}
                  >
                    Conversation {savedChats.length - index}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {mode === "safety" && (
          <div className="experiment-negotiation-playbooks-section">
            <div className="en-playbooks-header">
              <h3>Playbooks / Scripts</h3>
              <button type="button" onClick={handleAddPlaybook} className="en-add-playbook-btn">
                + Add Field
              </button>
            </div>
            <div className="en-playbooks-list">
              {playbooks.map((playbook, index) => (
                <div key={playbook.id} className="en-playbook-item">
                  <div className="en-playbook-item-header">
                    <span>File {index + 1}</span>
                    {playbooks.length > 1 && (
                      <button type="button" onClick={() => handleRemovePlaybook(playbook.id)} className="en-remove-playbook-btn" title="Remove">
                        ×
                      </button>
                    )}
                  </div>
                  <textarea 
                    className="en-safety-playbook" 
                    placeholder="Paste the generated Ansible playbook or bash commands here..." 
                    value={playbook.content} 
                    onChange={(e) => handlePlaybookChange(playbook.id, e.target.value)}
                    rows={8}
                  />
                </div>
              ))}
            </div>
          </div>    
        )}

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
                <input id="en-file-input" type="file" multiple onChange={handleFileChange} className="en-file-input-hidden"/>
                <button type="button" className="en-file-button"
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
                placeholder={mode === "negotiation" ? "Describe the experiment you want to run..." : "Describe the topology and insert all requested information..."}
                rows={3}
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
        </div>
      </div>
    </div>
  );
};

export default LLMAgent;