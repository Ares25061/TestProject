import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL,
  buildOpenAiResponseRequest,
  extractTextFromSseEvent,
  getOpenAiErrorMessage,
  normalizeMessages,
} from "./src/openai-payload.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const maxJsonBodyBytes = 12 * 1024 * 1024;
const maxTtsChars = 1_200;
const openAiBaseUrl = "https://api.openai.com/v1";
const openAiResponsesUrl = `${openAiBaseUrl}/responses`;
const openAiSpeechUrl = `${openAiBaseUrl}/audio/speech`;
const defaultTtsModel = "gpt-4o-mini-tts";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function loadDotEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = join(__dirname, fileName);
    if (!existsSync(filePath)) {
      continue;
    }

    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      const value = rawValue.replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let totalBytes = 0;
    let bodyTooLarge = false;

    request.on("data", (chunk) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxJsonBodyBytes) {
        bodyTooLarge = true;
        rejectBody(new Error("request_body_too_large"));
        return;
      }

      if (!bodyTooLarge) {
        chunks.push(chunk);
      }
    });

    request.on("end", () => {
      if (bodyTooLarge) {
        return;
      }

      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        rejectBody(new Error("invalid_json"));
      }
    });

    request.on("error", rejectBody);
  });
}

async function streamOpenAiToResponse(upstreamBody, response) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done || response.destroyed) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      try {
        const text = extractTextFromSseEvent(event);
        if (text && !response.destroyed) {
          response.write(text);
        }
      } catch {
        // Ignore keepalive events and unknown streaming fragments.
      }
    }
  }

  if (buffer.trim() && !response.destroyed) {
    try {
      const text = extractTextFromSseEvent(buffer);
      if (text) {
        response.write(text);
      }
    } catch {
      // The response is ending anyway; avoid turning a partial keepalive into an app error.
    }
  }

  if (!response.destroyed) {
    response.end();
  }
}

function getApiKey() {
  return process.env.OPENAI_API_KEY?.trim() ?? "";
}

function getChatModel() {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function getReasoningEffort() {
  const value = process.env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() || "";
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value) ? value : "";
}

async function handleChat(request, response) {
  const apiKey = getApiKey();
  if (!apiKey) {
    sendJson(response, 500, {
      error:
        "OPENAI_API_KEY не задан на сервере. Создайте API key на platform.openai.com, добавьте его в .env и перезапустите сервер.",
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.message === "request_body_too_large" ? 413 : 400, {
      error:
        error.message === "request_body_too_large"
          ? "Слишком большой запрос."
          : "Некорректный JSON.",
    });
    return;
  }

  const messages = normalizeMessages(body?.messages);
  if (!messages.some((message) => message.role === "user")) {
    sendJson(response, 400, { error: "Нужно отправить сообщение ученика." });
    return;
  }

  const payload = buildOpenAiResponseRequest({
    attachments: body?.attachments,
    messages,
    model: getChatModel(),
    reasoningEffort: getReasoningEffort(),
  });

  const upstream = await fetch(openAiResponsesUrl, {
    body: JSON.stringify(payload),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  }).catch((error) => ({ networkError: error }));

  if (upstream.networkError) {
    sendJson(response, 502, { error: "Не удалось подключиться к OpenAI API." });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const payloadText = await upstream.text().catch(() => "");
    let parsed = null;
    try {
      parsed = payloadText ? JSON.parse(payloadText) : null;
    } catch {
      parsed = null;
    }

    sendJson(response, upstream.status || 502, {
      error:
        getOpenAiErrorMessage(parsed) ||
        "OpenAI API не вернул потоковый ответ.",
    });
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Accel-Buffering": "no",
  });

  await streamOpenAiToResponse(upstream.body, response);
}

function normalizeTtsVoice(value) {
  const voice = typeof value === "string" ? value.trim().toLowerCase() : "";
  const allowedVoices = new Set([
    "alloy",
    "ash",
    "ballad",
    "cedar",
    "coral",
    "echo",
    "fable",
    "marin",
    "nova",
    "onyx",
    "sage",
    "shimmer",
    "verse",
  ]);

  return allowedVoices.has(voice) ? voice : "marin";
}

function normalizeTtsInput(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replaceAll("\u0000", "").trim().slice(0, maxTtsChars);
}

async function handleTts(request, response) {
  const apiKey = getApiKey();
  if (!apiKey) {
    sendJson(response, 500, { error: "OPENAI_API_KEY не задан." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: "Некорректный JSON." });
    return;
  }

  const input = normalizeTtsInput(body?.text);
  if (!input) {
    sendJson(response, 400, { error: "Нет текста для озвучивания." });
    return;
  }

  const voice = normalizeTtsVoice(body?.voice);
  const ttsModel = process.env.OPENAI_TTS_MODEL?.trim() || defaultTtsModel;
  const upstream = await fetch(openAiSpeechUrl, {
    body: JSON.stringify({
      input,
      instructions:
        "Говори естественно, тепло и спокойно, как внимательный преподаватель. Не звучать как диктор новостей. Сохраняй язык исходного текста.",
      model: ttsModel,
      response_format: "mp3",
      voice,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  }).catch((error) => ({ networkError: error }));

  if (upstream.networkError) {
    sendJson(response, 502, { error: "Не удалось подключиться к OpenAI TTS." });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const payloadText = await upstream.text().catch(() => "");
    let parsed = null;
    try {
      parsed = payloadText ? JSON.parse(payloadText) : null;
    } catch {
      parsed = null;
    }

    sendJson(response, upstream.status || 502, {
      error:
        getOpenAiErrorMessage(parsed) ||
        "OpenAI TTS не вернул аудио.",
    });
    return;
  }

  const contentType = upstream.headers.get("content-type") || "audio/mpeg";
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
  });

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done || response.destroyed) {
      break;
    }
    response.write(Buffer.from(value));
  }

  if (!response.destroyed) {
    response.end();
  }
}

function resolveStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const routePath =
    decodedPath === "/" || decodedPath === "/tutor" ? "/index.html" : decodedPath;
  const safePath = normalize(routePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(publicDir, `.${safePath}`);

  if (!filePath.startsWith(publicDir)) {
    return null;
  }

  return filePath;
}

async function serveStatic(request, response, pathname) {
  const filePath = resolveStaticPath(pathname);
  if (!filePath || !existsSync(filePath)) {
    const indexPath = join(publicDir, "index.html");
    const body = await readFile(indexPath);
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Type": contentTypes[".html"],
    });
    response.end(body);
    return;
  }

  const extension = extname(filePath);
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": contentTypes[extension] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

loadDotEnv();

const port = Number.parseInt(process.env.PORT || "3000", 10);
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        hasApiKey: Boolean(getApiKey()),
        model: getChatModel(),
        ok: true,
        provider: "OpenAI",
        ttsModel: process.env.OPENAI_TTS_MODEL?.trim() || defaultTtsModel,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      await handleChat(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tts") {
      await handleTts(request, response);
      return;
    }

    if (request.method === "GET") {
      await serveStatic(request, response, url.pathname);
      return;
    }

    sendJson(response, 405, { error: "Метод не поддерживается." });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Внутренняя ошибка сервера." });
    } else if (!response.destroyed) {
      response.end();
    }
  }
});

server.listen(port, () => {
  console.log(`AI Tutor App: http://localhost:${port}`);
});
