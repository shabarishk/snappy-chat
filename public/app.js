const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const appShell = document.querySelector("#app-shell");
const modelSelect = document.querySelector("#model-select");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const chatForm = document.querySelector("#chat-form");
const welcome = document.querySelector("#welcome");
const messagesElement = document.querySelector("#messages");
const connectionDot = document.querySelector("#connection-dot");
const connectionLabel = document.querySelector("#connection-label");
const newChatButton = document.querySelector("#new-chat");
const contextDonut = document.querySelector("#context-donut");
const contextTrigger = document.querySelector("#context-trigger");
const contextPercent = document.querySelector("#context-percent");
const contextTooltipUsage = document.querySelector("#context-tooltip-usage");
const conversationList = document.querySelector("#conversation-list");
const adminDialog = document.querySelector("#admin-dialog");
const createUserForm = document.querySelector("#create-user-form");
const createUserError = document.querySelector("#create-user-error");
const usersList = document.querySelector("#users-list");
const userCount = document.querySelector("#user-count");

let currentUser;
let conversationId;
let messages = [];
let isGenerating = false;
let activeController;
const modelContexts = new Map();
const messageStats = new WeakMap();
let currentContextStats = null;

function showLogin(errorMessage = "") {
  cancelGeneration();
  currentUser = undefined;
  conversationId = undefined;
  messages = [];
  messagesElement.replaceChildren();
  conversationList.replaceChildren();
  welcome.hidden = false;
  modelSelect.disabled = true;
  modelSelect.replaceChildren(new Option("Sign in to continue", ""));
  if (adminDialog.open) adminDialog.close();
  appShell.hidden = true;
  loginScreen.hidden = false;
  loginError.textContent = errorMessage;
  loginError.hidden = !errorMessage;
  document.querySelector("#login-password").value = "";
  document.querySelector("#login-username").focus();
}

function showApp(user) {
  currentUser = user;
  loginScreen.hidden = true;
  appShell.hidden = false;
  document.querySelector("#account-name").textContent = user.username;
  document.querySelector("#account-avatar").textContent = user.username.slice(0, 1).toUpperCase();
  document.querySelector("#manage-users").hidden = !user.isAdmin;
  void loadModels();
  void loadConversations();
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an invalid response.");
  }
  if (response.status === 401 && url !== "/api/login") {
    showLogin("Your session expired. Please sign in again.");
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
  }
  return data;
}

function setConnection(connected, label) {
  connectionDot.classList.toggle("is-connected", connected);
  connectionDot.classList.toggle("is-error", !connected);
  connectionLabel.textContent = label;
}

function updateSendButton() {
  sendButton.disabled = !isGenerating && (!modelSelect.value || !messageInput.value.trim());
}

function addMessage(role, content = "", stats = null) {
  const message = document.createElement("article");
  message.className = `message ${role}`;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "assistant" ? "✳" : "◦";

  const text = document.createElement("div");
  text.className = "message-content";
  if (role === "assistant") renderAssistantMarkdown(text, content);
  else text.textContent = content;
  const body = document.createElement("div");
  body.className = "message-body";
  body.append(text);
  message.append(avatar, body);
  if (role === "assistant" && stats) renderMessageStats(message, stats);
  messagesElement.append(message);
  message.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return text;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

function refreshContextIndicator() {
  const model = modelSelect.value;
  const contextLength = modelContexts.get(model);
  const stats = currentContextStats?.model === model ? currentContextStats : null;
  const hasUsage = stats &&
    Number.isFinite(stats.promptEvalCount) &&
    Number.isFinite(stats.evalCount);

  if (!contextLength) {
    contextDonut.style.setProperty("--context-progress", "0");
    contextDonut.classList.remove("is-warning", "is-critical");
    contextPercent.textContent = "—";
    contextTooltipUsage.textContent = model ? "Context capacity unavailable" : "Select a model to see its context window";
    contextTrigger.setAttribute("aria-label", "Context capacity unavailable");
    return;
  }

  if (!hasUsage) {
    contextDonut.style.setProperty("--context-progress", "0");
    contextDonut.classList.remove("is-warning", "is-critical");
    contextPercent.textContent = "—";
    contextTooltipUsage.textContent = `${formatNumber(contextLength)} tokens available · usage appears after a reply`;
    contextTrigger.setAttribute("aria-label", `Context window: ${formatNumber(contextLength)} tokens; usage not available yet`);
    return;
  }

  const usedTokens = stats.promptEvalCount + stats.evalCount;
  const usagePercent = Math.min(100, (usedTokens / contextLength) * 100);
  contextDonut.style.setProperty("--context-progress", String(usagePercent));
  contextDonut.classList.toggle("is-warning", usagePercent >= 70 && usagePercent < 90);
  contextDonut.classList.toggle("is-critical", usagePercent >= 90);
  contextPercent.textContent = `${Math.round(usagePercent)}%`;
  contextTooltipUsage.textContent = `~${formatNumber(usedTokens)} of ${formatNumber(contextLength)} tokens · ${usagePercent.toFixed(1)}%`;
  contextTrigger.setAttribute(
    "aria-label",
    `Estimated context usage: ${formatNumber(usedTokens)} of ${formatNumber(contextLength)} tokens, ${usagePercent.toFixed(1)} percent`,
  );
}

function renderMessageStats(messageElement, stats) {
  messageStats.set(messageElement, stats);
  const body = messageElement.querySelector(".message-body");
  let statsElement = body.querySelector(".message-stats");
  if (!statsElement) {
    statsElement = document.createElement("div");
    statsElement.className = "message-stats";
    statsElement.setAttribute("aria-label", "Model performance");
    body.append(statsElement);
  }

  const items = [];
  if (Number.isFinite(stats.firstTokenMs)) {
    items.push(["First token", formatSeconds(stats.firstTokenMs)]);
  }
  if (Number.isFinite(stats.promptEvalCount)) {
    items.push(["Prompt", `${formatNumber(stats.promptEvalCount)} tok`]);
  }
  if (
    Number.isFinite(stats.promptEvalCount) &&
    Number.isFinite(stats.promptEvalDuration) &&
    stats.promptEvalDuration > 0
  ) {
    const promptSpeed = stats.promptEvalCount / (stats.promptEvalDuration / 1_000_000_000);
    items.push(["Prompt eval", `${promptSpeed.toFixed(1)} tok/s`]);
  }
  if (Number.isFinite(stats.evalCount)) {
    items.push(["Generated", `${formatNumber(stats.evalCount)} tok`]);
  }
  if (Number.isFinite(stats.evalCount) && Number.isFinite(stats.evalDuration) && stats.evalDuration > 0) {
    const speed = stats.evalCount / (stats.evalDuration / 1_000_000_000);
    items.push(["Speed", `${speed.toFixed(1)} tok/s`]);
  }
  if (Number.isFinite(stats.loadDuration)) {
    items.push(["Load", formatSeconds(stats.loadDuration / 1_000_000)]);
  }
  if (Number.isFinite(stats.totalDuration)) {
    items.push(["Total", formatSeconds(stats.totalDuration / 1_000_000)]);
  }

  const contextLength = modelContexts.get(stats.model);
  if (Number.isFinite(stats.promptEvalCount) && Number.isFinite(stats.evalCount) && contextLength) {
    const used = stats.promptEvalCount + stats.evalCount;
    const usage = Math.min(100, (used / contextLength) * 100);
    items.push(["Context", `~${formatNumber(used)} / ${formatNumber(contextLength)} tok (${usage.toFixed(1)}%)`]);
  }

  statsElement.replaceChildren();
  for (const [label, value] of items) {
    const item = document.createElement("span");
    item.className = "stat-item";
    const name = document.createElement("span");
    name.className = "stat-label";
    name.textContent = label;
    const stat = document.createElement("span");
    stat.textContent = value;
    item.append(name, stat);
    statsElement.append(item);
  }
  statsElement.hidden = items.length === 0;
}

function refreshDisplayedStats() {
  const assistantElements = messagesElement.querySelectorAll(".message.assistant");
  for (const element of assistantElements) {
    const stats = messageStats.get(element);
    if (stats) renderMessageStats(element, stats);
  }
}

async function loadModelContext(model) {
  if (!model) {
    refreshContextIndicator();
    return;
  }
  if (modelContexts.has(model)) {
    refreshContextIndicator();
    return;
  }
  try {
    const data = await apiRequest(`/api/model-context?model=${encodeURIComponent(model)}`);
    modelContexts.set(model, data.contextLength);
    if (modelSelect.value === model) refreshContextIndicator();
    refreshDisplayedStats();
  } catch (error) {
    modelContexts.set(model, null);
    if (modelSelect.value === model) refreshContextIndicator();
    console.error(`Could not load context capacity for ${model}:`, error);
  }
}

function renderAssistantMarkdown(element, markdown) {
  const html = window.marked.parse(markdown, { gfm: true });
  element.innerHTML = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function setGenerating(generating) {
  isGenerating = generating;
  sendButton.innerHTML = generating ? "<span aria-hidden=\"true\">■</span>" : "<span aria-hidden=\"true\">↑</span>";
  sendButton.setAttribute("aria-label", generating ? "Stop generating" : "Send message");
  sendButton.title = generating ? "Stop generating" : "Send message";
  updateSendButton();
}

function cancelGeneration() {
  if (!isGenerating) return;
  activeController?.abort();
  activeController = undefined;
  setGenerating(false);
}

async function loadModels() {
  modelSelect.disabled = true;
  modelSelect.replaceChildren(new Option("Loading models…", ""));
  try {
    const data = await apiRequest("/api/models");
    modelSelect.replaceChildren();
    if (!data.models.length) {
      modelSelect.add(new Option("No models installed", ""));
      setConnection(false, "No Ollama models found");
      return;
    }
    for (const model of data.models) modelSelect.add(new Option(model, model));
    modelSelect.disabled = false;
    setConnection(true, "Ollama connected");
    void loadModelContext(modelSelect.value);
  } catch (error) {
    if (!currentUser) return;
    modelSelect.replaceChildren(new Option("Ollama unavailable", ""));
    setConnection(false, "Ollama unavailable");
    console.error("Could not load Ollama models:", error);
  }
  updateSendButton();
}

async function loadConversations() {
  try {
    const data = await apiRequest("/api/conversations");
    conversationList.replaceChildren();
    if (!data.conversations.length) {
      const empty = document.createElement("p");
      empty.className = "empty-history";
      empty.textContent = "Your conversations will show up here.";
      conversationList.append(empty);
      return;
    }
    for (const conversation of data.conversations) {
      const button = document.createElement("button");
      button.className = "conversation-item";
      button.classList.toggle("is-selected", String(conversation.id) === String(conversationId));
      button.type = "button";
      button.textContent = conversation.title;
      button.title = conversation.title;
      button.addEventListener("click", () => void openConversation(String(conversation.id)));
      conversationList.append(button);
    }
  } catch (error) {
    if (currentUser) console.error("Could not load conversations:", error);
  }
}

async function openConversation(id) {
  cancelGeneration();
  try {
    const data = await apiRequest(`/api/conversations/${encodeURIComponent(id)}`);
    conversationId = String(data.conversation.id);
    messages = data.conversation.messages.map(({ role, content, stats }) => ({ role, content, stats }));
    currentContextStats = [...messages].reverse().find((message) => message.role === "assistant" && message.stats)?.stats || null;
    messagesElement.replaceChildren();
    for (const message of messages) addMessage(message.role, message.content, message.stats);
    welcome.hidden = messages.length > 0;
    if (data.conversation.model) {
      const option = [...modelSelect.options].find((item) => item.value === data.conversation.model);
      if (option) {
        modelSelect.value = option.value;
        void loadModelContext(option.value);
      }
    }
    refreshContextIndicator();
    for (const model of new Set(messages.map(({ stats }) => stats?.model).filter(Boolean))) {
      void loadModelContext(model);
    }
    await loadConversations();
    document.querySelector("#sidebar").classList.remove("is-open");
    updateSendButton();
  } catch (error) {
    console.error("Could not open conversation:", error);
  }
}

async function loadUsers() {
  const data = await apiRequest("/api/admin/users");
  usersList.replaceChildren();
  userCount.textContent = String(data.users.length);
  for (const user of data.users) {
    const item = document.createElement("li");
    item.className = "user-row";
    const identity = document.createElement("span");
    identity.className = "user-identity";
    identity.textContent = user.username;
    const role = document.createElement("span");
    role.className = user.isAdmin ? "role-badge is-admin" : "role-badge";
    role.textContent = user.isAdmin ? "Admin" : "User";
    item.append(identity, role);
    usersList.append(item);
  }
}

async function handleStreamLine(line, assistantMessage, assistantText, messageElement) {
  if (!line.trim()) return;
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    throw new Error("Ollama sent an invalid response.");
  }
  if (data.error) throw new Error(data.error);
  if (data.snappy_stats && typeof data.snappy_stats === "object") {
    assistantMessage.stats = data.snappy_stats;
    currentContextStats = assistantMessage.stats;
    refreshContextIndicator();
    renderMessageStats(messageElement, assistantMessage.stats);
  }
  if (typeof data.message?.content === "string") {
    assistantMessage.content += data.message.content;
    renderAssistantMarkdown(assistantText, assistantMessage.content);
    assistantText.parentElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

async function sendMessage(content) {
  const userMessage = { role: "user", content };
  messages.push(userMessage);
  const userText = addMessage("user", content);
  userText.parentElement.scrollIntoView({ block: "nearest", behavior: "smooth" });
  welcome.hidden = true;
  messageInput.value = "";
  messageInput.style.height = "auto";

  const assistantMessage = { role: "assistant", content: "" };
  const assistantText = addMessage("assistant");
  const assistantElement = assistantText.closest(".message");
  messages.push(assistantMessage);
  const controller = new AbortController();
  activeController = controller;
  setGenerating(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ model: modelSelect.value, message: content, conversationId: conversationId || null }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("The server returned an invalid response.");
      }
      if (response.status === 401) showLogin("Your session expired. Please sign in again.");
      throw new Error(data.error || `Request failed with HTTP ${response.status}.`);
    }
    conversationId = response.headers.get("X-Conversation-Id") || conversationId;
    void loadConversations();
    if (!response.body) throw new Error("The browser could not read the streamed response.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) await handleStreamLine(line, assistantMessage, assistantText, assistantElement);
      if (done) break;
    }
    await handleStreamLine(pending, assistantMessage, assistantText, assistantElement);
  } catch (error) {
    if (error.name === "AbortError") {
      renderAssistantMarkdown(assistantText, assistantMessage.content);
    } else {
      assistantText.textContent = error.message;
      assistantText.closest(".message").classList.add("error");
      const index = messages.indexOf(assistantMessage);
      if (index !== -1) messages.splice(index, 1);
      void loadConversations();
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

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = loginForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  loginError.hidden = true;
  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginForm.elements.username.value,
        password: loginForm.elements.password.value,
      }),
    });
    loginForm.reset();
    showApp(data.user);
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isGenerating) {
    cancelGeneration();
    return;
  }
  const content = messageInput.value.trim();
  if (content && modelSelect.value) void sendMessage(content);
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

modelSelect.addEventListener("change", () => {
  updateSendButton();
  refreshContextIndicator();
  void loadModelContext(modelSelect.value);
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.prompt;
    messageInput.dispatchEvent(new Event("input"));
    messageInput.focus();
  });
});

newChatButton.addEventListener("click", () => {
  cancelGeneration();
  conversationId = undefined;
  messages = [];
  currentContextStats = null;
  messagesElement.replaceChildren();
  refreshContextIndicator();
  welcome.hidden = false;
  messageInput.value = "";
  messageInput.style.height = "auto";
  void loadConversations();
  document.querySelector("#sidebar").classList.remove("is-open");
  updateSendButton();
  messageInput.focus();
});

document.querySelector("#logout").addEventListener("click", async () => {
  try {
    await apiRequest("/api/logout", { method: "POST" });
    showLogin();
  } catch (error) {
    console.error("Could not sign out:", error);
  }
});

document.querySelector("#manage-users").addEventListener("click", async () => {
  createUserError.hidden = true;
  adminDialog.showModal();
  try {
    await loadUsers();
  } catch (error) {
    createUserError.textContent = error.message;
    createUserError.hidden = false;
  }
});

document.querySelector("#close-admin").addEventListener("click", () => adminDialog.close());

createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = createUserForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  createUserError.hidden = true;
  try {
    await apiRequest("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: createUserForm.elements.username.value,
        password: createUserForm.elements.password.value,
      }),
    });
    createUserForm.reset();
    await loadUsers();
  } catch (error) {
    createUserError.textContent = error.message;
    createUserError.hidden = false;
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#sidebar-toggle").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.toggle("is-open");
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    newChatButton.click();
  }
});

async function initialize() {
  try {
    const data = await apiRequest("/api/session");
    showApp(data.user);
  } catch (error) {
    if (!loginScreen.hidden) showLogin();
    else {
      console.error("Could not restore session:", error);
      showLogin("Could not connect. Please try again.");
    }
  }
}

void initialize();
