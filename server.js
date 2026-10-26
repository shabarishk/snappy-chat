const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createDatabase, createError } = require("./database");

const port = Number(process.env.PORT || 3000);
const publicDirectory = path.join(__dirname, "public");
const sessionCookieName = "snappy_session";
const secureCookies = process.env.COOKIE_SECURE === "true";
const vendorFiles = new Map([
  ["/vendor/marked.umd.js", path.join(__dirname, "node_modules", "marked", "lib", "marked.umd.js")],
  ["/vendor/purify.min.js", path.join(__dirname, "node_modules", "dompurify", "dist", "purify.min.js")],
]);
const configuredOllamaUrl = process.env.OLLAMA_BASE_URL || "http://192.168.1.100:11434";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

let ollamaBaseUrl;
try {
  const parsedUrl = new URL(configuredOllamaUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("OLLAMA_BASE_URL must use http or https.");
  }
  ollamaBaseUrl = parsedUrl.toString().replace(/\/+$/, "");
} catch (error) {
  console.error(`Invalid OLLAMA_BASE_URL: ${error.message}`);
  process.exit(1);
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD must be set.");
}

const database = createDatabase({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  response.end(JSON.stringify(data));
}

function sendError(response, error) {
  if (!response.headersSent) {
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : "An unexpected server error occurred.",
    });
  } else if (!response.destroyed) {
    response.destroy();
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw createError(413, "Request body exceeds 1 MB.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw createError(400, "Request body must be valid JSON.");
  }
}

function getSessionToken(request) {
  const cookieHeader = request.headers.cookie || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  return cookie ? cookie.slice(sessionCookieName.length + 1) : "";
}

function setSessionCookie(response, token, maxAge) {
  const flags = [
    `${sessionCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secureCookies) flags.push("Secure");
  response.setHeader("Set-Cookie", flags.join("; "));
}

function validateSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw createError(403, "Cross-origin requests are not allowed.");
  }
  if (
    !["http:", "https:"].includes(parsedOrigin.protocol) ||
    parsedOrigin.host.toLowerCase() !== (request.headers.host || "").toLowerCase()
  ) {
    throw createError(403, "Cross-origin requests are not allowed.");
  }
}

function validateChatRequest(body) {
  if (!body || typeof body.model !== "string" || body.model.length === 0 || body.model.length > 200) {
    throw createError(400, "Choose a valid model.");
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0 || body.message.length > 100_000) {
    throw createError(400, "Message must contain between 1 and 100,000 characters.");
  }
  let conversationId = null;
  if (body.conversationId !== null && body.conversationId !== undefined) {
    if (typeof body.conversationId !== "string" || !/^[1-9]\d*$/.test(body.conversationId)) {
      throw createError(400, "Conversation ID is invalid.");
    }
    conversationId = body.conversationId;
  }
  return { model: body.model, message: body.message, conversationId };
}

async function getOllamaModels(response) {
  let upstream;
  try {
    upstream = await fetch(`${ollamaBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    sendJson(response, 502, { error: `Could not reach Ollama: ${error.message}` });
    return;
  }
  if (!upstream.ok) {
    sendJson(response, 502, { error: `Ollama returned HTTP ${upstream.status}.` });
    return;
  }
  let data;
  try {
    data = await upstream.json();
  } catch {
    sendJson(response, 502, { error: "Ollama returned an invalid model list." });
    return;
  }
  sendJson(response, 200, {
    models: data && Array.isArray(data.models)
      ? data.models.filter((model) => model && typeof model.name === "string").map((model) => model.name)
      : [],
  });
}

async function getModelContext(response, model) {
  if (!model || model.length > 200) {
    sendJson(response, 400, { error: "Choose a valid model." });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(`${ollamaBaseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    sendJson(response, 502, { error: `Could not reach Ollama: ${error.message}` });
    return;
  }
  if (!upstream.ok) {
    sendJson(response, 502, { error: `Ollama returned HTTP ${upstream.status} for model details.` });
    return;
  }

  let details;
  try {
    details = await upstream.json();
  } catch {
    sendJson(response, 502, { error: "Ollama returned invalid model details." });
    return;
  }
  const contextLength = Object.entries(details.model_info || {})
    .find(([key, value]) => key.endsWith(".context_length") && Number.isSafeInteger(value) && value > 0)?.[1] || null;
  sendJson(response, 200, { contextLength });
}

async function streamChat(request, response, user, body) {
  const { model, message, conversationId } = validateChatRequest(body);
  const turn = await database.startUserTurn(user.id, conversationId, model, message);
  const requestStartedAt = process.hrtime.bigint();
  const abortController = new AbortController();
  const abortWhenDisconnected = () => {
    if (!response.writableEnded) abortController.abort();
  };
  response.on("close", abortWhenDisconnected);
  request.on("aborted", abortWhenDisconnected);

  let upstream;
  try {
    upstream = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: turn.messages, stream: true }),
      signal: abortController.signal,
    });
  } catch (error) {
    if (!response.destroyed) {
      sendJson(response, 502, { error: `Could not reach Ollama: ${error.message}` });
    }
    return;
  }
  if (!upstream.ok) {
    const detail = await upstream.text();
    sendJson(response, 502, { error: detail || `Ollama returned HTTP ${upstream.status}.` });
    return;
  }
  if (!upstream.body) {
    sendJson(response, 502, { error: "Ollama returned an empty response." });
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "X-Conversation-Id": String(turn.id),
  });

  let assistantContent = "";
  let streamError = false;
  let firstTokenMs = null;
  let pending = "";
  const decoder = new TextDecoder();
  const consumeLine = async (line, delimiter) => {
    if (!line.trim()) {
      if (delimiter && !response.write(delimiter)) await new Promise((resolve) => response.once("drain", resolve));
      return;
    }
    const data = JSON.parse(line);
    if (typeof data.message?.content === "string" && data.message.content.length > 0) {
      if (firstTokenMs === null) {
        firstTokenMs = Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000;
      }
      assistantContent += data.message.content;
    }
    if (data.error) streamError = true;
    if (data.done === true) {
      const stats = {
        model,
        firstTokenMs,
        totalDuration: Number.isFinite(data.total_duration) ? data.total_duration : null,
        loadDuration: Number.isFinite(data.load_duration) ? data.load_duration : null,
        promptEvalCount: Number.isFinite(data.prompt_eval_count) ? data.prompt_eval_count : null,
        promptEvalDuration: Number.isFinite(data.prompt_eval_duration) ? data.prompt_eval_duration : null,
        evalCount: Number.isFinite(data.eval_count) ? data.eval_count : null,
        evalDuration: Number.isFinite(data.eval_duration) ? data.eval_duration : null,
      };
      data.snappy_stats = stats;
      if (!streamError && assistantContent.length > 0 && !abortController.signal.aborted) {
        await database.saveAssistantMessage(user.id, turn.id, assistantContent, stats);
      }
    }
    const output = `${JSON.stringify(data)}${delimiter}`;
    if (!response.write(output)) await new Promise((resolve) => response.once("drain", resolve));
  };

  try {
    for await (const chunk of upstream.body) {
      if (response.destroyed) {
        abortController.abort();
        return;
      }
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) await consumeLine(line, "\n");
    }
    pending += decoder.decode();
    if (pending.trim()) await consumeLine(pending, "");
    response.end();
  } catch (error) {
    if (!abortController.signal.aborted) {
      console.error(`Ollama stream failed: ${error.message}`);
      if (!response.destroyed) response.destroy();
    }
  }
}

async function handleApi(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/login") {
    validateSameOrigin(request);
    const body = await readJson(request);
    const user = await database.authenticate(body?.username, body?.password);
    const session = await database.createSession(user.id);
    setSessionCookie(response, session.token, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    sendJson(response, 200, { user });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    const user = await database.getSession(getSessionToken(request));
    if (!user) {
      sendJson(response, 401, { error: "Sign in to continue." });
      return;
    }
    sendJson(response, 200, { user });
    return;
  }

  const user = await database.getSession(getSessionToken(request));
  if (!user) {
    sendJson(response, 401, { error: "Sign in to continue." });
    return;
  }

  if (request.method === "POST") validateSameOrigin(request);

  if (request.method === "POST" && url.pathname === "/api/logout") {
    await database.deleteSession(getSessionToken(request));
    setSessionCookie(response, "", 0);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/models") {
    await getOllamaModels(response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/model-context") {
    await getModelContext(response, url.searchParams.get("model"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    sendJson(response, 200, { conversations: await database.listConversations(user.id) });
    return;
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([1-9]\d*)$/);
  if (request.method === "GET" && conversationMatch) {
    sendJson(response, 200, {
      conversation: await database.getConversation(user.id, conversationMatch[1]),
    });
    return;
  }

  if (url.pathname === "/api/admin/users") {
    if (!user.isAdmin) throw createError(403, "Administrator access is required.");
    if (request.method === "GET") {
      sendJson(response, 200, { users: await database.listUsers() });
      return;
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      const createdUser = await database.createUser(body?.username, body?.password);
      sendJson(response, 201, { user: createdUser });
      return;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    await streamChat(request, response, user, await readJson(request));
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  let filePath = vendorFiles.get(url.pathname);
  if (!filePath) {
    let requestedPath;
    try {
      requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    } catch {
      sendJson(response, 400, { error: "Invalid page path." });
      return;
    }
    filePath = path.resolve(publicDirectory, requestedPath);
    if (!filePath.startsWith(`${publicDirectory}${path.sep}`) && filePath !== path.join(publicDirectory, "index.html")) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      sendJson(response, error.code === "ENOENT" ? 404 : 500, { error: "Could not load this page." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const handler = url.pathname.startsWith("/api/")
    ? handleApi(request, response, url)
    : serveStatic(request, response, url);
  void handler.catch((error) => {
    if (error.statusCode !== 401 && error.statusCode !== 403 && error.statusCode !== 400 && error.statusCode !== 404 && error.statusCode !== 409) {
      console.error("Request failed:", error);
    }
    sendError(response, error);
  });
});

async function start() {
  await database.initialize(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
  server.listen(port, "0.0.0.0", () => {
    console.log(`Snappy Chat listening on port ${port}; Ollama: ${ollamaBaseUrl}`);
  });
}

start().catch(async (error) => {
  console.error("Could not initialize Snappy Chat:", error);
  await database.pool.end();
  process.exitCode = 1;
});
