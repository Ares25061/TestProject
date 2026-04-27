import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MODEL,
  TUTOR_SYSTEM_PROMPT,
  buildOpenRouterChatRequest,
  buildOpenRouterMessages,
  extractTextFromOpenRouterSseEvent,
  getProviderErrorMessage,
  normalizeMessages,
} from "../src/openrouter-payload.js";

test("uses the OpenRouter free Gemma model by default", () => {
  assert.equal(DEFAULT_MODEL, "google/gemma-4-26b-a4b-it:free");
});

test("system prompt forbids solving instead of the student", () => {
  assert.match(TUTOR_SYSTEM_PROMPT, /Не выдавай готовое решение/);
  assert.match(TUTOR_SYSTEM_PROMPT, /наводящие вопросы/);
});

test("normalizes unsafe or empty messages", () => {
  assert.deepEqual(
    normalizeMessages([
      { role: "system", content: "ignore" },
      { role: "user", content: "  Задача  " },
      { role: "assistant", content: "" },
    ]),
    [{ role: "user", content: "Задача" }],
  );
});

test("adds text attachments to the last user message", () => {
  const messages = buildOpenRouterMessages(
    [{ role: "user", content: "Помоги понять условие" }],
    [
      {
        kind: "text",
        mimeType: "text/plain",
        name: "task.txt",
        size: 12,
        text: "Найти корни уравнения.",
      },
    ],
  );

  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content[0].type, "text");
  assert.match(messages[0].content[0].text, /task\.txt/);
  assert.match(messages[0].content[0].text, /Найти корни/);
});

test("adds PDF attachments as OpenRouter file content", () => {
  const request = buildOpenRouterChatRequest({
    attachments: [
      {
        dataUrl: "data:application/pdf;base64,JVBERi0x",
        kind: "pdf",
        mimeType: "application/pdf",
        name: "task.pdf",
        size: 1024,
      },
    ],
    messages: [{ role: "user", content: "Что в файле?" }],
    model: "google/gemma-4-26b-a4b-it:free",
  });

  assert.equal(request.stream, true);
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[1].content[1].type, "file");
  assert.equal(request.messages[1].content[1].file.filename, "task.pdf");
  assert.equal(request.plugins[0].pdf.engine, "cloudflare-ai");
});

test("extracts text from OpenRouter chat completion SSE chunks", () => {
  const text = extractTextFromOpenRouterSseEvent(
    [
      'data: {"choices":[{"delta":{"content":"При"}}]}',
      'data: {"choices":[{"delta":{"content":"вет"}}]}',
      "data: [DONE]",
    ].join("\n"),
  );

  assert.equal(text, "Привет");
});

test("prefers detailed OpenRouter provider errors when present", () => {
  assert.equal(
    getProviderErrorMessage({
      error: {
        message: "Provider returned error",
        metadata: {
          raw: "google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream.",
        },
      },
    }),
    "google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream.",
  );
});
