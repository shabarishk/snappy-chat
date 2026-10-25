const modelSelect = document.querySelector("#model-select");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const chatForm = document.querySelector("#chat-form");
const welcome = document.querySelector("#welcome");
const messagesElement = document.querySelector("#messages");
const connectionDot = document.querySelector("#connection-dot");
const connectionLabel = document.querySelector("#connection-label");
const newChatButton = document.querySelector("#new-chat");

let messages = [];
let isGenerating = false;
let activeController;

function setConnection(connected, label) {
  connectionDot.classList.toggle("is-connected", connected);
  connectionDot.classList.toggle("is-error", !connected);
  connectionLabel.textContent = label;
}

function updateSendButton() {
  sendButton.disabled = !isGenerating && (!modelSelect.value || !messageInput.value.trim());
}

function addMessage(role, content = "") {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "assistant" ? "✳" : "◦";

  const text = document.createElement("div");
  text.className = "message-content";
  text.textContent = content;
  message.append(avatar, text);
  messagesElement.append(message);
  message.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return text;
}

function setGenerating(generating) {
  isGenerating = generating;
  sendButton.innerHTML = generating ? "<span aria-hidden=\"true\">■</span>" : "<span aria-hidden=\"true\">↑</span>";
  sendButton.setAttribute("aria-label", generating ? "Stop generating" : "Send message");
  sendButton.title = generating ? "Stop generating" : "Send message";
  updateSendButton();
}

async function loadModels() {
  modelSelect.disabled = true;
  modelSelect.replaceChildren(new Option("Loading models…", ""));
  try {
    const response = await fetch("/api/models");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
    }
    modelSelect.replaceChildren();
    if (!data.models.length) {
      modelSelect.add(new Option("No models installed", ""));
      setConnection(false, "No Ollama models found");
      return;
    }
    for (const model of data.models) {
      modelSelect.add(new Option(model, model));
    }
    modelSelect.disabled = false;
    setConnection(true, "Ollama connected");
  } catch (error) {
    modelSelect.replaceChildren(new Option("Ollama unavailable", ""));
    setConnection(false, "Ollama unavailable");
    console.error("Could not load Ollama models:", error);
  }
  updateSendButton();
}

function handleStreamLine(line, assistantText) {
  if (!line.trim()) return;
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    throw new Error("Ollama sent an invalid response.");
  }
  if (data.error) {
    throw new Error(data.error);
  }
  if (typeof data.message?.content === "string") {
    assistantText.textContent += data.message.content;
    assistantText.parentElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

async function sendMessage(content) {
  messages.push({ role: "user", content });
  const userText = addMessage("user", content);
  userText.parentElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  welcome.hidden = true;
  messageInput.value = "";
  messageInput.style.height = "auto";

  const assistantMessage = { role: "assistant", content: "" };
  const assistantText = addMessage("assistant");
  const conversation = [...messages];
  messages.push(assistantMessage);
  const controller = new AbortController();
  activeController = controller;
  setGenerating(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelSelect.value, messages: conversation }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
    }
    if (!response.body) {
      throw new Error("The browser could not read the streamed response.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        handleStreamLine(line, assistantText);
      }
      if (done) break;
    }
    handleStreamLine(pending, assistantText);
    assistantMessage.content = assistantText.textContent;
  } catch (error) {
    if (error.name === "AbortError") {
      assistantMessage.content = assistantText.textContent;
    } else {
      assistantText.textContent = error.message;
      assistantText.parentElement.classList.add("error");
      const index = messages.indexOf(assistantMessage);
      if (index !== -1) messages.splice(index, 1);
      console.error("Chat request failed:", error);
    }
  } finally {
    if (activeController === controller) {
      activeController = undefined;
      setGenerating(false);
      messageInput.focus();
    }
  }
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isGenerating) {
    activeController?.abort();
    return;
  }
  const content = messageInput.value.trim();
  if (content && modelSelect.value) {
    void sendMessage(content);
  }
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
  updateSendButton();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

modelSelect.addEventListener("change", updateSendButton);

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.prompt;
    messageInput.dispatchEvent(new Event("input"));
    messageInput.focus();
  });
});

newChatButton.addEventListener("click", () => {
  if (isGenerating) {
    activeController?.abort();
    activeController = undefined;
    setGenerating(false);
  }
  messages = [];
  messagesElement.replaceChildren();
  welcome.hidden = false;
  messageInput.value = "";
  messageInput.style.height = "auto";
  updateSendButton();
  messageInput.focus();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newChatButton.click();
  }
});

void loadModels();
