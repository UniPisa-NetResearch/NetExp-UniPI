import { useState, useCallback } from "react";

// Sends a POST request streams SSE from the backend. Calls onThought(chunk) for every "thought" delta to update the UI in real time, resolves with the final "result" payload when the stream ends
export const sendChatRequestStream = async (url, payload, files = [], onThought) => {
  // build FormData from the payload object, skipping null/undefined values
  const formData = new FormData();
  Object.keys(payload).forEach(key => {
    if (payload[key] !== null && payload[key] !== undefined) formData.append(key, payload[key]);
  });

  // append all files under the same "files" field name
  files.forEach(file => formData.append("files", file));

  // start the streaming POST request
  const response = await fetch(url, { method: "POST", body: formData });
  
  if (!response.body) throw new Error("ReadableStream not supported");
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  // accumulator for partial SSE text until we find complete events
  let buffer = "";
  // hold the final result object once the "result" event is received
  let finalResult = null;

  // read chuncks until the stream ends
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    // SSE events are separated by double newlines
    let boundary = buffer.indexOf("\n\n");
    
    // process all complete events currently in the buffer
    while (boundary !== -1) {
      // extract one complete SSE event line
      const chunkLine = buffer.slice(0, boundary).trim();
      // remove the processed event from the buffer
      buffer = buffer.slice(boundary + 2);
      // look for the next event
      boundary = buffer.indexOf("\n\n");
      
      if (chunkLine.startsWith("data: ")) {
        try {
          const data = JSON.parse(chunkLine.substring(6));
          if (data.type === "thought" && onThought) {
            // if this is a thought, show immediately on the GUI
            onThought(data.content);
          } else if (data.type === "result") {
            // capture the final structured result for the return value
            finalResult = data.data;
          }
        } catch (e) { console.error("Errore parsing SSE:", e); }
      }
    }
  }
  
  if (finalResult && finalResult.error) throw new Error(finalResult.error);
  return finalResult;
};

export const useAgentChat = (username, reservation_id, defaultRole) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  const [savedChats, setSavedChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [agentNames, setAgentNames] = useState({});
  // model selection
  const [availableModels, setAvailableModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("");

  const handleFileChange = (e) => {
    const newFiles = Array.from(e.target.files || []);
    setSelectedFiles((prev) => {
      const existingFileNames = prev.map((f) => f.name);
      const uniqueNewFiles = newFiles.filter((f) => !existingFileNames.includes(f.name));
      return [...prev, ...uniqueNewFiles];
    });
    e.target.value = null;
  };

  const handleRemoveFile = (fileName) => {
    setSelectedFiles((prev) => prev.filter((f) => f.name !== fileName));
  };

  const appendMessage = (role, content) => {
    setMessages((prev) => [...prev, { id: prev.length + 1, role, content }]);
  };

  const resetBaseChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setInputValue("");
    setSelectedFiles([]);
    setError(null);
  };

  const fetchSessions = useCallback(async (role = defaultRole) => {
    if (!username || !reservation_id) return null;
    try {
      const response = await fetch(`/api/agent_server/sessions?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&agent_role=${encodeURIComponent(role)}`);
      if (response.ok) {
        const data = await response.json();
        setSavedChats(data.chat_ids || []);
        // set available models list
        if (data.available_models) {
          setAvailableModels(data.available_models);
        }
        // select default model if no models are selected
        if (data.default_model && !selectedModel) {
          setSelectedModel(data.default_model);
        }

        // save the dynamic agent names mapping from backend
        if (data.agent_names) {
          setAgentNames(data.agent_names);
        }

        return data;
      }
    } catch (err) {
      console.error("Error fetching sessions:", err);
    }
    return null;
  }, [username, reservation_id, defaultRole, selectedModel]);

  const loadHistory = async (chatId, role = defaultRole) => {
    try {
      const response = await fetch(
        `/api/agent_server/history?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}&chat_id=${encodeURIComponent(chatId)}&agent_role=${encodeURIComponent(role)}`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.messages) {
          const formattedMessages = data.messages.map((msg, index) => ({
            id: index + 1, role: msg.role, content: msg.content,
          }));
          setMessages(formattedMessages);
          setActiveChatId(chatId);
          setError(null);
          return formattedMessages;
        }
      }
    } catch (err) {
      console.error("Error loading history:", err);
    }
    return null;
  };

  const deleteChat = async (chatId, onSuccess) => {
    try {
      const response = await fetch("/api/agent_server/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, reservation_id, chat_id: chatId }),
      });
      if (response.ok) {
        setSavedChats((prev) => prev.filter((id) => id !== chatId));
        if (onSuccess) onSuccess(chatId);
      }
    } catch (err) {
      console.error("Error deleting chat:", err);
    }
  };

  const downloadChat = async (chatId, role = null) => {
    try {
      let url = `/api/agent_server/download?username=${encodeURIComponent(username)}&reservation_id=${encodeURIComponent(reservation_id)}`;
      if (chatId) url += `&chat_id=${encodeURIComponent(chatId)}`;
      if (role) url += `&agent_role=${encodeURIComponent(role)}`; // used for diffent behaviour of the two pages

      const response = await fetch(url);
      if (response.ok) {
        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition");
        let filename = chatId ? `chat_${chatId}.zip` : `all_chats.zip`;
        if (disposition) {
          const match = disposition.match(/filename="?([^"]+)"?/);
          if (match) filename = match[1];
        }
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
      }
    } catch (err) {
      console.error("Error downloading chat:", err);
    }
  };

  return {
    messages, setMessages, appendMessage,
    inputValue, setInputValue,
    selectedFiles, setSelectedFiles, handleFileChange, handleRemoveFile,
    isSending, setIsSending,
    error, setError,
    savedChats, setSavedChats,
    activeChatId, setActiveChatId,
    availableModels, selectedModel, setSelectedModel, agentNames,
    resetBaseChat, fetchSessions, loadHistory, deleteChat, downloadChat
  };
};