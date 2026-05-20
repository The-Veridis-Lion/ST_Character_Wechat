# OpenAI-Compatible API Runtime

ST Character WeChat can use one plain `/chat/completions` API runtime for Gemini, DeepSeek, and other OpenAI-compatible services.

Use this when you do not want to run local Codex or Claude Code, and the provider accepts requests shaped like:

```http
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "model": "provider-model",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "stream": true
}
```

Set:

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=api
ST_CHARACTER_WECHAT_API_BASE_URL=https://provider.example/v1
ST_CHARACTER_WECHAT_API_KEY=your_key
ST_CHARACTER_WECHAT_API_MODEL=provider-model
ST_CHARACTER_WECHAT_API_HISTORY_LIMIT=80
```

Gemini setup:

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=gemini
ST_CHARACTER_WECHAT_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
ST_CHARACTER_WECHAT_API_KEY=your_gemini_key
ST_CHARACTER_WECHAT_API_MODEL=gemini-2.0-flash
```

DeepSeek setup:

```dotenv
ST_CHARACTER_WECHAT_RUNTIME=deepseek
ST_CHARACTER_WECHAT_API_BASE_URL=https://api.deepseek.com/v1
ST_CHARACTER_WECHAT_API_KEY=your_deepseek_key
ST_CHARACTER_WECHAT_API_MODEL=deepseek-chat
```

Notes:

- `ST_CHARACTER_WECHAT_API_BASE_URL` may be either the `/v1` root or the full `/chat/completions` URL.
- When `ST_CHARACTER_WECHAT_RUNTIME=gemini`, the default base URL is Google's OpenAI-compatible Gemini endpoint: `https://generativelanguage.googleapis.com/v1beta/openai`.
- When `ST_CHARACTER_WECHAT_RUNTIME=deepseek`, the default base URL is `https://api.deepseek.com/v1`.
- The API key stays in the user's local `.env`; never commit it.
- This runtime is text-only and does not support tool calling or approval prompts.
- Streaming SSE is used when the provider supports it. If the provider buffers or returns a non-SSE response, the full reply is still split into natural WeChat bubbles, and bubble delivery delay is handled by the WeChat channel pacing settings.
- Character thread isolation still uses the shared ST Character WeChat session store.

Reference: [Google Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai).
