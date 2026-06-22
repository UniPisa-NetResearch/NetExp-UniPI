import React, { useState, useEffect } from "react";
import "./style/experimentNegotiation.css";

const ExperimentNegotiation = ({ username, reservation_id }) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);

  const [savedChats, setSavedChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);

  useEffect(() => {
    const fetchSessions = async () => {
      if (!username || !reservation_id) return;
      try {
        const response = await fetch(
          `/api/agent_server/sessions?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}`
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
  }, [username, reservation_id]);

  // load the chat history for a specific chat_id
  const loadHistory = async (chatId) => {
    try {
      const response = await fetch(
        `/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}`
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

  const startNewChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setSelectedFiles([]);
    setError(null);
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    setSelectedFiles(files);
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
      if (trimmed) {
        formData.append("message", trimmed);
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
        setSavedChats((prev) => [...prev, data.chat_id]);
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
        <div className="en-message-content">{message.content}</div>
      </div>
    );
  };

  return (
    <div className="experiment-negotiation-container">
      <div className="experiment-negotiation-header">
        <h1>Negotiation Agent</h1>
        <p className="en-fixed-message">
            Describe the network experiment you want to run. You can also attach
            files (topologies, configurations, diagrams).
        </p>
      </div>
      {/* Agent response area */}
      <div className="experiment-negotiation-main">
        <div className="experiment-negotiation-sidebar">
          <button className="en-new-chat-btn" onClick={startNewChat}>
            ➕ New Chat
          </button>
          <h3>Recent Chats</h3>
          {savedChats.length === 0 ? (
            <p className="en-sidebar-empty">No previous conversations.</p>
          ) : (
            <ul className="en-chat-list">
              {savedChats.map((chatId) => (
                <li key={chatId}>
                  <button
                    className={`en-chat-list-btn ${activeChatId === chatId ? "active" : ""}`}
                    onClick={() => loadHistory(chatId)}
                  >
                    Chat {chatId.substring(0, 8)}...
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="experiment-negotiation-chat">
          <div className="en-chat-window">
            {messages.map((msg) => renderMessage(msg))}
          </div>

          <form className="en-input-area" onSubmit={handleSubmit} autoComplete="off">
            <div className="en-files-row">
              <input id="en-file-input" type="file" multiple onChange={handleFileChange} className="en-file-input-hidden"/>
              <button type="button" className="en-file-button"
                  onClick={() => {
                      const input = document.getElementById("en-file-input");
                      if (input) {input.click();}
                  }}
              >
              +
              </button>
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
                placeholder="Describe the experiment you want to run..."
                rows={3}
              />
              <button
                type="submit"
                className={`en-send-button ${isSending ? "en-send-button-disabled" : ""}`}
                disabled={isSending}
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

export default ExperimentNegotiation;