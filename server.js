const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const publicDirectory = path.join(__dirname, "public");
const vendorFiles = new Map([
  ["/vendor/marked.umd.js", path.join(__dirname, "node_modules", "marked", "lib", "marked.umd.js")],
  ["/vendor/purify.min.js", path.join(__dirname, "node_modules", "dompurify", "dist", "purify.min.js")],
]);
const configuredOllamaUrl = process.env.OLLAMA_BASE_URL || "http://192.168.1.100:11434";

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
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("Request body exceeds 1 MB.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function validateChatRequest(body) {
  if (!body || typeof body.model !== "string" || body.model.length === 0 || body.model.length > 200) {
    return "Choose a valid model.";
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) {
    return "Provide between 1 and 100 messages.";
  }
  for (const message of body.messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    ) {
      return "Each message must have a supported role and text content.";
    }
  }
  return null;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/models") {
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
      return;
    }

    const validationError = validateChatRequest(body);
    if (validationError) {
      sendJson(response, 400, { error: validationError });
      return;
    }

    const abortController = new AbortController();
    response.on("close", () => abortController.abort());

    let upstream;
    try {
      upstream = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: body.model,
          messages: body.messages,
          stream: true,
        }),
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
      sendJson(response, 502, {
        error: detail || `Ollama returned HTTP ${upstream.status}.`,
      });
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
    });
    try {
      for await (const chunk of upstream.body) {
        if (response.destroyed) {
          abortController.abort();
          return;
        }
        if (!response.write(chunk)) {
          await new Promise((resolve) => response.once("drain", resolve));
        }
      }
      response.end();
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error(`Ollama stream failed: ${error.message}`);
        if (!response.destroyed) response.destroy();
      }
    }
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }

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
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Snappy Chat listening on port ${port}; Ollama: ${ollamaBaseUrl}`);
});
