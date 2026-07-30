import { useState, useCallback } from "react";

export const sendChatRequest = async (url, payload, files = []) => {
  
    const formData = new FormData();
    Object.keys(payload).forEach(key => {
        if (payload[key] !== null && payload[key] !== undefined) {
        formData.append(key, payload[key]);
        }
    });

  files.forEach(file => formData.append("files", file));

  const response = await fetch(url, { method: "POST", body: formData });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Backend error");
  }
  return await response.json();
};

export const useAgentChat = (username, reservation_id, defaultRole) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState(null);
  const [savedChats, setSavedChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
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
    availableModels, selectedModel, setSelectedModel,
    resetBaseChat, fetchSessions, loadHistory, deleteChat, downloadChat
  };
};