const languageOptions = [
  { label: "Русский", value: "ru-RU" },
  { label: "English", value: "en-US" },
  { label: "Deutsch", value: "de-DE" },
  { label: "Español", value: "es-ES" },
  { label: "Français", value: "fr-FR" },
  { label: "Italiano", value: "it-IT" },
];

const serverTtsVoices = [
  {
    gender: "female",
    label: "Svetlana Neural - русский женский",
    value: "ru-RU-SvetlanaNeural",
  },
  {
    gender: "male",
    label: "Dmitry Neural - русский мужской",
    value: "ru-RU-DmitryNeural",
  },
];

const maxAttachmentCount = 5;
const maxTextFileChars = 18_000;
const maxBinaryFileBytes = 6 * 1024 * 1024;
const textFilePattern =
  /\.(txt|md|csv|json|xml|html|css|js|jsx|ts|tsx|py|java|cs|cpp|c|sql|yaml|yml)$/i;

const state = {
  gender: "female",
  language: "ru-RU",
  messages: [
    {
      content:
        "Здравствуйте. Пришлите условие, свою попытку решения или файл. Я помогу разобраться без готового ответа за вас.",
      id: createId("welcome"),
      role: "assistant",
    },
  ],
  micPermission: "unknown",
  mode: "text",
  selectedFiles: [],
  speakReplies: false,
  ttsProvider: "server",
  voices: [],
};

let abortController = null;
let activeAudio = null;
let isRecognizing = false;
let isSending = false;
let recognition = null;
let speechBuffer = "";
let speechDraft = "";
let ttsAbortController = null;
let ttsQueue = Promise.resolve();

const elements = {
  browserTtsButton: document.querySelector("#browserTtsButton"),
  clearChatButton: document.querySelector("#clearChatButton"),
  composer: document.querySelector("#composer"),
  femaleVoiceButton: document.querySelector("#femaleVoiceButton"),
  fileButton: document.querySelector("#fileButton"),
  fileInput: document.querySelector("#fileInput"),
  languageSelect: document.querySelector("#languageSelect"),
  maleVoiceButton: document.querySelector("#maleVoiceButton"),
  messageInput: document.querySelector("#messageInput"),
  messages: document.querySelector("#messages"),
  micButton: document.querySelector("#micButton"),
  micPermissionButton: document.querySelector("#micPermissionButton"),
  micPermissionStatus: document.querySelector("#micPermissionStatus"),
  modelBadge: document.querySelector("#modelBadge"),
  selectedFiles: document.querySelector("#selectedFiles"),
  sendButton: document.querySelector("#sendButton"),
  serverTtsButton: document.querySelector("#serverTtsButton"),
  speakRepliesToggle: document.querySelector("#speakRepliesToggle"),
  speechSupportNote: document.querySelector("#speechSupportNote"),
  statusLine: document.querySelector("#statusLine"),
  stopButton: document.querySelector("#stopButton"),
  textModeButton: document.querySelector("#textModeButton"),
  voiceModeButton: document.querySelector("#voiceModeButton"),
  voiceSelect: document.querySelector("#voiceSelect"),
};

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function setStatus(text = "") {
  elements.statusLine.textContent = text;
}

function formatBytes(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "размер неизвестен";
  }

  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} МБ`;
  }

  if (size >= 1024) {
    return `${Math.round(size / 1024)} КБ`;
  }

  return `${size} Б`;
}

function isTextFile(file) {
  return file.type.startsWith("text/") || textFilePattern.test(file.name);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

async function prepareFile(file) {
  const base = {
    id: createId("file"),
    mimeType: file.type || "application/octet-stream",
    name: file.name,
    size: file.size,
  };

  if (isTextFile(file)) {
    const rawText = await file.text();
    return {
      ...base,
      kind: "text",
      text: rawText.slice(0, maxTextFileChars),
      truncated: rawText.length > maxTextFileChars,
    };
  }

  if (file.size > maxBinaryFileBytes) {
    return {
      ...base,
      kind: "unsupported",
    };
  }

  if (/^image\/(?:png|jpe?g|webp|gif)$/i.test(file.type)) {
    return {
      ...base,
      dataUrl: await readFileAsDataUrl(file),
      kind: "image",
    };
  }

  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return {
      ...base,
      dataUrl: await readFileAsDataUrl(file),
      kind: "pdf",
    };
  }

  return {
    ...base,
    kind: "unsupported",
  };
}

function guessVoiceGender(voiceName) {
  const name = voiceName.toLocaleLowerCase();
  const femaleMarkers = [
    "female",
    "woman",
    "жен",
    "alena",
    "anna",
    "aria",
    "daria",
    "elena",
    "irina",
    "jenny",
    "maria",
    "milena",
    "natasha",
    "oksana",
    "svetlana",
    "tatyana",
    "victoria",
    "yulia",
    "zira",
  ];
  const maleMarkers = [
    "male",
    "man",
    "муж",
    "alex",
    "anton",
    "daniel",
    "david",
    "denis",
    "dmitry",
    "george",
    "ivan",
    "mark",
    "maxim",
    "pavel",
    "sergey",
  ];

  if (femaleMarkers.some((marker) => name.includes(marker))) {
    return "female";
  }

  if (maleMarkers.some((marker) => name.includes(marker))) {
    return "male";
  }

  return "unknown";
}

function getFilteredBrowserVoices() {
  const languagePrefix = state.language.split("-")[0].toLocaleLowerCase();
  const languageVoices = state.voices.filter((voice) =>
    voice.lang.toLocaleLowerCase().startsWith(languagePrefix),
  );
  const source = languageVoices.length > 0 ? languageVoices : state.voices;
  const naturalVoices = source.filter((voice) => {
    const name = voice.name.toLocaleLowerCase();
    return name.includes("natural") || name.includes("online") || name.includes("neural");
  });
  const rankedSource = naturalVoices.length > 0 ? naturalVoices : source;
  const genderMatches = rankedSource.filter(
    (voice) => guessVoiceGender(voice.name) === state.gender,
  );

  return genderMatches.length > 0 ? genderMatches : rankedSource;
}

function getFilteredServerTtsVoices() {
  const genderMatches = serverTtsVoices.filter((voice) => voice.gender === state.gender);
  return [...genderMatches, ...serverTtsVoices.filter((voice) => voice.gender === "neutral")];
}

function getSelectedBrowserVoice() {
  const filteredVoices = getFilteredBrowserVoices();
  return (
    state.voices.find((voice) => voice.voiceURI === elements.voiceSelect.value) ||
    filteredVoices[0] ||
    null
  );
}

function renderVoiceOptions() {
  elements.voiceSelect.innerHTML = "";

  if (state.ttsProvider === "server") {
    elements.voiceSelect.disabled = false;
    for (const voice of getFilteredServerTtsVoices()) {
      const option = document.createElement("option");
      option.textContent = voice.label;
      option.value = voice.value;
      elements.voiceSelect.append(option);
    }
    return;
  }

  const filteredVoices = getFilteredBrowserVoices();
  if (filteredVoices.length === 0) {
    const option = document.createElement("option");
    option.textContent = "Системные голоса не найдены";
    option.value = "";
    elements.voiceSelect.append(option);
    elements.voiceSelect.disabled = true;
    return;
  }

  elements.voiceSelect.disabled = false;
  for (const voice of filteredVoices) {
    const option = document.createElement("option");
    option.textContent = `${voice.name} · ${voice.lang}`;
    option.value = voice.voiceURI;
    elements.voiceSelect.append(option);
  }
}

function loadVoices() {
  if (!("speechSynthesis" in window)) {
    if (state.ttsProvider === "browser") {
      elements.speakRepliesToggle.disabled = true;
      elements.voiceSelect.disabled = true;
    }
    elements.speechSupportNote.hidden = false;
    elements.speechSupportNote.textContent =
      "Браузерный TTS недоступен, но серверный TTS может работать через API.";
    return;
  }

  state.voices = speechSynthesis.getVoices();
  renderVoiceOptions();
}

function splitSpeechText(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const parts = [];
  let rest = compact;

  while (rest.length > 320) {
    const splitAt = Math.max(
      rest.lastIndexOf(" ", 320),
      rest.lastIndexOf(",", 320),
      rest.lastIndexOf(";", 320),
    );
    const index = splitAt > 100 ? splitAt : 320;
    parts.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }

  if (rest) {
    parts.push(rest);
  }

  return parts;
}

function cancelSpeech() {
  speechBuffer = "";
  ttsAbortController?.abort();
  ttsAbortController = null;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = "";
    activeAudio = null;
  }
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }
  ttsQueue = Promise.resolve();
}

function playAudioBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) {
        activeAudio = null;
      }
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось воспроизвести TTS."));
    };
    audio.play().catch((error) => {
      URL.revokeObjectURL(url);
      reject(error);
    });
  });
}

async function speakWithServerTts(text) {
  const controller = new AbortController();
  ttsAbortController = controller;
  const fallbackVoice = state.gender === "male" ? "ru-RU-DmitryNeural" : "ru-RU-SvetlanaNeural";
  const response = await fetch("/api/tts", {
    body: JSON.stringify({
      text,
      voice: elements.voiceSelect.value || fallbackVoice,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: controller.signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || "Серверный TTS не сработал.");
  }

  await playAudioBlob(await response.blob());
}

function speakWithBrowser(text) {
  if (!("speechSynthesis" in window)) {
    return Promise.reject(new Error("Браузерный TTS недоступен."));
  }

  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = getSelectedBrowserVoice();
    utterance.lang = selectedVoice?.lang || state.language;
    utterance.pitch = state.gender === "male" ? 0.93 : 1.03;
    utterance.rate = 0.97;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();

    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    speechSynthesis.speak(utterance);
  });
}

function speakText(text) {
  if (!state.speakReplies) {
    return;
  }

  for (const part of splitSpeechText(text)) {
    ttsQueue = ttsQueue
      .then(async () => {
        if (state.ttsProvider === "server") {
          try {
            await speakWithServerTts(part);
            return;
          } catch (error) {
            console.warn(error);
            setStatus("Серверный TTS не сработал, использую браузерный голос.");
          }
        }

        await speakWithBrowser(part).catch(() => {
          setStatus("TTS недоступен в этом браузере.");
        });
      })
      .catch(() => undefined);
  }
}

function queueSpeechChunk(chunk, force = false) {
  if (!state.speakReplies) {
    return;
  }

  speechBuffer += chunk.replace(/\s+/g, " ");
  let buffer = speechBuffer;
  const sentencePattern = /(.+?[.!?…]+)(\s+|$)/u;
  let match = sentencePattern.exec(buffer);

  while (match) {
    const sentence = match[1]?.trim() || "";
    if (sentence.length > 8) {
      speakText(sentence);
    }
    buffer = buffer.slice(match[0].length);
    match = sentencePattern.exec(buffer);
  }

  speechBuffer = buffer;

  if (force && speechBuffer.trim()) {
    speakText(speechBuffer.trim());
    speechBuffer = "";
  }
}

function renderMessages() {
  elements.messages.innerHTML = "";

  for (const message of state.messages) {
    const row = document.createElement("article");
    row.className = `message-row ${message.role}${message.error ? " error" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = message.role === "assistant" ? "AI" : "Вы";

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const text = document.createElement("p");
    text.className = "bubble-text";
    text.textContent = message.content || "Печатает...";
    bubble.append(text);

    if (message.pending) {
      const caret = document.createElement("span");
      caret.className = "typing-caret";
      bubble.append(caret);
    }

    if (message.attachments?.length) {
      const list = document.createElement("div");
      list.className = "attachment-list";
      for (const attachment of message.attachments) {
        const chip = document.createElement("span");
        chip.className = "attachment-chip";
        chip.textContent = `${attachment.name} · ${formatBytes(attachment.size)}`;
        list.append(chip);
      }
      bubble.append(list);
    }

    row.append(avatar, bubble);
    elements.messages.append(row);
  }

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderSelectedFiles() {
  elements.selectedFiles.innerHTML = "";

  for (const [index, file] of state.selectedFiles.entries()) {
    const chip = document.createElement("button");
    chip.className = "file-chip";
    chip.type = "button";
    chip.title = "Убрать файл";
    chip.textContent = `${file.name} · ${formatBytes(file.size)}`;
    chip.addEventListener("click", () => {
      state.selectedFiles.splice(index, 1);
      renderSelectedFiles();
      syncSendButton();
    });
    elements.selectedFiles.append(chip);
  }
}

function syncSendButton() {
  elements.sendButton.disabled =
    isSending || (!elements.messageInput.value.trim() && state.selectedFiles.length === 0);
  elements.stopButton.hidden = !isSending;
  elements.stopButton.style.display = isSending ? "inline-flex" : "none";
}

function syncMicStatus() {
  const recognitionAvailable = Boolean(getRecognitionConstructor());
  const permissionText =
    state.micPermission === "granted"
      ? "Микрофон разрешен."
      : state.micPermission === "denied"
        ? "Микрофон запрещен в браузере."
        : state.micPermission === "prompt"
          ? "Браузер спросит разрешение при запуске."
          : "Разрешение еще не проверялось.";
  const recognitionText = recognitionAvailable
    ? "Распознавание речи доступно."
    : "Распознавание речи недоступно в этом браузере.";

  elements.micPermissionStatus.textContent = `${permissionText} ${recognitionText}`;
  elements.micButton.disabled = !recognitionAvailable || state.micPermission === "denied";
}

function setMode(mode) {
  state.mode = mode;
  elements.textModeButton.classList.toggle("segment-active", mode === "text");
  elements.voiceModeButton.classList.toggle("segment-active", mode === "voice");

  if (mode === "voice") {
    state.speakReplies = true;
    elements.speakRepliesToggle.checked = true;
  }
}

function setTtsProvider(provider) {
  if (provider === "server" && elements.serverTtsButton.disabled) {
    return;
  }

  state.ttsProvider = provider;
  elements.serverTtsButton.classList.toggle("segment-active", provider === "server");
  elements.browserTtsButton.classList.toggle("segment-active", provider === "browser");
  renderVoiceOptions();
}

function setGender(gender) {
  state.gender = gender;
  elements.femaleVoiceButton.classList.toggle("segment-active", gender === "female");
  elements.maleVoiceButton.classList.toggle("segment-active", gender === "male");
  renderVoiceOptions();
}

function getRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

async function readMicrophonePermission() {
  if (!navigator.permissions?.query) {
    return "unknown";
  }

  try {
    const result = await navigator.permissions.query({ name: "microphone" });
    result.onchange = () => {
      state.micPermission = result.state;
      syncMicStatus();
    };
    return result.state;
  } catch {
    return "unknown";
  }
}

async function requestMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    state.micPermission = "denied";
    syncMicStatus();
    setStatus("Браузер не дает доступ к getUserMedia.");
    return false;
  }

  try {
    setStatus("Браузер должен запросить разрешение на микрофон...");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    state.micPermission = "granted";
    setStatus("Микрофон разрешен. Теперь можно нажать «Микрофон» и говорить.");
    syncMicStatus();
    return true;
  } catch (error) {
    state.micPermission = "denied";
    syncMicStatus();
    setStatus(
      error?.name === "NotAllowedError"
        ? "Доступ к микрофону запрещен. Разрешите его в настройках браузера."
        : "Не удалось получить доступ к микрофону.",
    );
    return false;
  }
}

function stopVoiceInput() {
  recognition?.stop();
}

async function startVoiceInput() {
  const Recognition = getRecognitionConstructor();
  if (!Recognition) {
    setStatus("Распознавание речи недоступно в этом браузере. Попробуйте Chrome или Edge.");
    syncMicStatus();
    return;
  }

  if (isRecognizing) {
    stopVoiceInput();
    return;
  }

  if (state.micPermission !== "granted") {
    const granted = await requestMicrophonePermission();
    if (!granted) {
      return;
    }
  }

  recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = state.language;
  speechDraft = "";

  recognition.onresult = (event) => {
    let interimText = "";
    let finalText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript || "";

      if (result?.isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalText) {
      speechDraft = `${speechDraft} ${finalText}`.trim();
    }

    elements.messageInput.value = `${speechDraft} ${interimText}`.trim();
    setStatus(interimText ? `Слышу: ${interimText}` : "Слушаю...");
    syncSendButton();
  };

  recognition.onerror = (event) => {
    setStatus(
      event.error
        ? `Ошибка распознавания: ${event.error}`
        : "Ошибка распознавания речи.",
    );
    isRecognizing = false;
    elements.micButton.textContent = "Микрофон";
    elements.micButton.classList.remove("active-danger");
  };

  recognition.onend = () => {
    isRecognizing = false;
    elements.micButton.textContent = "Микрофон";
    elements.micButton.classList.remove("active-danger");
    recognition = null;

    const finalText = speechDraft.trim();
    if (state.mode === "voice" && finalText) {
      elements.messageInput.value = "";
      void sendMessage(finalText);
      return;
    }

    setStatus(finalText ? "Текст с микрофона готов." : "Голос не распознан.");
  };

  try {
    setStatus("Слушаю...");
    isRecognizing = true;
    elements.micButton.textContent = "Слушаю";
    elements.micButton.classList.add("active-danger");
    recognition.start();
  } catch {
    isRecognizing = false;
    setStatus("Не удалось запустить распознавание речи.");
  }
}

function buildHistory(nextUserMessage) {
  return [...state.messages, nextUserMessage]
    .filter((message) => !message.pending && message.content.trim())
    .slice(-12)
    .map((message) => ({
      content: message.content,
      role: message.role,
    }));
}

async function sendMessage(explicitText = "") {
  const prompt = (explicitText || elements.messageInput.value).trim();
  if ((!prompt && state.selectedFiles.length === 0) || isSending) {
    return;
  }

  isSending = true;
  syncSendButton();
  cancelSpeech();
  setStatus(state.selectedFiles.length > 0 ? "Подготавливаю файлы..." : "");

  const userMessage = {
    content: prompt || "Посмотрите прикрепленные файлы.",
    id: createId("user"),
    role: "user",
  };
  const assistantMessage = {
    content: "",
    id: createId("assistant"),
    pending: true,
    role: "assistant",
  };
  const history = buildHistory(userMessage);

  try {
    const attachments = await Promise.all(state.selectedFiles.map(prepareFile));
    userMessage.attachments = attachments;
    state.messages.push(userMessage, assistantMessage);
    state.selectedFiles = [];
    elements.fileInput.value = "";
    elements.messageInput.value = "";
    renderSelectedFiles();
    renderMessages();
    setStatus("Генерирую ответ...");

    abortController = new AbortController();
    const response = await fetch("/api/chat", {
      body: JSON.stringify({
        attachments,
        messages: history,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || "Не удалось получить ответ модели.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) {
        continue;
      }

      assistantText += chunk;
      queueSpeechChunk(chunk);
      assistantMessage.content = assistantText;
      renderMessages();
    }

    const tail = decoder.decode();
    if (tail) {
      assistantText += tail;
      queueSpeechChunk(tail);
    }

    queueSpeechChunk("", true);
    assistantMessage.content =
      assistantText.trim() ||
      "Я не получил текст ответа. Попробуйте переформулировать вопрос.";
    assistantMessage.pending = false;
    renderMessages();
    setStatus("");
  } catch (error) {
    assistantMessage.content =
      error.name === "AbortError"
        ? "Генерация остановлена."
        : error.message || "Неизвестная ошибка.";
    assistantMessage.error = true;
    assistantMessage.pending = false;
    if (!state.messages.some((message) => message.id === assistantMessage.id)) {
      state.messages.push(userMessage, assistantMessage);
    }
    renderMessages();
    setStatus("");
  } finally {
    abortController = null;
    isSending = false;
    syncSendButton();
  }
}

function clearChat() {
  cancelSpeech();
  state.messages = [
    {
      content:
        "Начнем заново. Пришлите задание или вашу попытку, и я помогу найти следующий шаг.",
      id: createId("welcome"),
      role: "assistant",
    },
  ];
  renderMessages();
}

async function loadHealth() {
  const response = await fetch("/api/health").catch(() => null);
  if (!response?.ok) {
    return;
  }

  const payload = await response.json().catch(() => null);
  if (payload?.model) {
    elements.modelBadge.textContent = `${payload.provider || "OpenRouter"} · ${payload.model}`;
  }

  if (payload && !payload.hasApiKey) {
    setStatus("Добавьте OPENROUTER_API_KEY в .env и перезапустите сервер.");
  }

  if (payload && !payload.hasServerTts) {
    elements.serverTtsButton.disabled = true;
    elements.serverTtsButton.title = "Серверный Edge TTS сейчас недоступен.";
    if (state.ttsProvider === "server") {
      setTtsProvider("browser");
    }
  }
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

elements.messageInput.addEventListener("input", syncSendButton);
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});

elements.fileButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  const incomingFiles = Array.from(elements.fileInput.files || []);
  state.selectedFiles = [...state.selectedFiles, ...incomingFiles].slice(
    0,
    maxAttachmentCount,
  );
  renderSelectedFiles();
  syncSendButton();
});

elements.micButton.addEventListener("click", startVoiceInput);
elements.micPermissionButton.addEventListener("click", requestMicrophonePermission);
elements.stopButton.addEventListener("click", () => {
  abortController?.abort();
  cancelSpeech();
});
elements.clearChatButton.addEventListener("click", clearChat);
elements.textModeButton.addEventListener("click", () => setMode("text"));
elements.voiceModeButton.addEventListener("click", () => setMode("voice"));
elements.serverTtsButton.addEventListener("click", () => setTtsProvider("server"));
elements.browserTtsButton.addEventListener("click", () => setTtsProvider("browser"));
elements.femaleVoiceButton.addEventListener("click", () => setGender("female"));
elements.maleVoiceButton.addEventListener("click", () => setGender("male"));
elements.languageSelect.addEventListener("change", () => {
  state.language = elements.languageSelect.value;
  renderVoiceOptions();
});
elements.speakRepliesToggle.addEventListener("change", () => {
  state.speakReplies = elements.speakRepliesToggle.checked;
  if (!state.speakReplies) {
    cancelSpeech();
  }
});

for (const option of languageOptions) {
  if (![...elements.languageSelect.options].some((item) => item.value === option.value)) {
    const selectOption = document.createElement("option");
    selectOption.value = option.value;
    selectOption.textContent = option.label;
    elements.languageSelect.append(selectOption);
  }
}

const initialPermission = await readMicrophonePermission();
state.micPermission = initialPermission;

if (!getRecognitionConstructor()) {
  elements.speechSupportNote.hidden = false;
  elements.speechSupportNote.textContent =
    "Распознавание речи доступно не во всех браузерах. Лучше Chrome или Edge.";
}

loadVoices();
if ("speechSynthesis" in window) {
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
}
renderMessages();
renderSelectedFiles();
renderVoiceOptions();
syncMicStatus();
syncSendButton();
void loadHealth();
