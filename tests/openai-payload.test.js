import assert from "node:assert/strict";
import test from "node:test";
import {
  TUTOR_SYSTEM_PROMPT,
  buildOpenAiInput,
  buildOpenAiResponseRequest,
  extractTextFromSseEvent,
  normalizeMessages,
} from "../src/openai-payload.js";

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
  const messages = buildOpenAiInput(
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
  assert.equal(messages[0].content[0].type, "input_text");
  assert.match(messages[0].content[0].text, /task\.txt/);
  assert.match(messages[0].content[0].text, /Найти корни/);
});

test("adds PDF attachments as Responses API input files", () => {
  const request = buildOpenAiResponseRequest({
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
    model: "gpt-5.5",
  });

  assert.equal(request.stream, true);
  assert.equal(request.input[0].content[1].type, "input_file");
  assert.equal(request.input[0].content[1].filename, "task.pdf");
});

test("extracts text from OpenAI Responses SSE chunks", () => {
  const text = extractTextFromSseEvent(
    [
      'data: {"type":"response.output_text.delta","delta":"При"}',
      'data: {"type":"response.output_text.delta","delta":"вет"}',
      "data: [DONE]",
    ].join("\n"),
  );

  assert.equal(text, "Привет");
});
