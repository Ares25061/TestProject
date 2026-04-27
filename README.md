# AI-преподаватель

Отдельное веб-приложение с темной темой, потоковым ответом через OpenRouter Chat Completions API, загрузкой файлов, голосовым вводом и бесплатной серверной озвучкой через Edge TTS.

## Важно про OpenRouter

Для работы чата нужен `OPENROUTER_API_KEY`: https://openrouter.ai/keys. Ключ хранится только на сервере в `.env` и не вставляется в клиентский код.

## Запуск

1. Создайте `.env` рядом с `.env.example`.
2. Укажите `OPENROUTER_API_KEY`.
3. Запустите:

```bash
npm start
```

По умолчанию приложение открывается на `http://localhost:3000/tutor`.

## Настройки

- `OPENROUTER_API_KEY` - ключ OpenRouter API. Его нельзя вставлять в клиентский код.
- `OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free` - модель преподавателя.
- `OPENROUTER_REASONING_EFFORT` - необязательное значение `minimal`, `low`, `medium`, `high` или `xhigh`.
- `OPENROUTER_APP_TITLE` - название приложения для OpenRouter.
- `EDGE_TTS_PROXY` - необязательный proxy URL для Edge TTS, если прямое подключение к сервису недоступно.
- `PORT=3000` - порт локального сервера.
- `APP_PUBLIC_URL` - публичный URL приложения, если понадобится в дальнейшем.

Голосовой ввод сначала запрашивает разрешение микрофона через `getUserMedia`, затем использует Web Speech API для распознавания речи. Если браузер не поддерживает распознавание речи, попробуйте Chrome или Edge.

Серверный TTS использует бесплатный Edge TTS без API-ключа и возвращает MP3. По умолчанию доступны русские нейроголоса `ru-RU-SvetlanaNeural` и `ru-RU-DmitryNeural`. Браузерный TTS оставлен запасным вариантом.
