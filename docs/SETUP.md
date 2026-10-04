# Setup: models, network, voice and search

Tidbit works with nothing configured ([FEATURES.md](FEATURES.md)). Each section here
adds one optional extra. Copy `.env.example` to `.env` and uncomment what you need.
All settings live in that one file.

## Connect any AI provider

The brain runs on the [pi SDK](https://pi.dev), so any provider pi supports works.
Set two variables and the key for that provider:

```bash
PAL_PROVIDER=anthropic
PAL_MODEL=claude-sonnet-5
ANTHROPIC_API_KEY=sk-ant-...
```

| Provider                  | `PAL_PROVIDER` | Key variable                           |
| ------------------------- | -------------- | -------------------------------------- |
| Anthropic                 | `anthropic`    | `ANTHROPIC_API_KEY`                    |
| OpenAI                    | `openai`       | `OPENAI_API_KEY`                       |
| Google                    | `google`       | `GEMINI_API_KEY`                       |
| Groq                      | `groq`         | `GROQ_API_KEY`                         |
| ChatGPT Plus/Pro (no key) | `openai-codex` | `pnpm login openai-codex`              |
| Ollama, LM Studio, vLLM   | (leave unset)  | `PAL_BASE_URL`, optional `PAL_API_KEY` |

The model only ever picks values from a fixed schema: a mood, a gesture, some words.
That means small, cheap and local models do fine.

### ChatGPT subscription, no API key

```bash
pnpm login openai-codex          # writes ./auth.json (gitignored)
echo 'PAL_PROVIDER=openai-codex' >> .env
echo 'PAL_MODEL=gpt-5.5' >> .env
pnpm smoke                       # creates a pal and chats with it using the real model
```

### Fully local

```bash
PAL_BASE_URL=http://127.0.0.1:11434/v1   # Ollama
PAL_MODEL=llama3.2
```

`PAL_THINKING` (`off`, `minimal`, `low`, `medium`, `high`) sets the reasoning
effort on models that support it.

## Open it on your phone or another computer

The brain only listens on loopback. The web server proxies `/ws` and `/api` to it, so
exposing the web UI never exposes the brain.

```bash
PAL_WEB_HOST=100.x.y.z pnpm dev   # your Tailscale IP
PAL_WEB_HOST=0.0.0.0 pnpm dev     # LAN and Tailscale
```

Then pair the new browser from **Your devices** to see the same pals.

**Get https for free.** `tailscale serve 5174` gives you an https URL on your
tailnet. The mic button needs https (or localhost), and the natural voice runs about
twice as fast over https because it can use several threads.

## Web search

`web_fetch` (reading a page) always works. Searching needs a provider. Set either:

```bash
PAL_BRAVE_API_KEY=...                      # Brave Search API
PAL_SEARXNG_URL=http://127.0.0.1:8888      # your own SearXNG, JSON output enabled
```

The pal only offers `web_search` to the model when one of these is set.

## Reaching your home network

HTTP actions (see [INTEGRATIONS.md](INTEGRATIONS.md)) can reach public URLs by
default. To let them reach LAN or Tailscale hosts like Home Assistant:

```bash
PAL_ALLOW_PRIVATE_ACTIONS=1
```

Everyone you pair with shares this brain, so that's why this is opt-in. The brain's
own machine is always refused.

## Speech servers for the device

The browser does its own speech. The ESP32 device sends audio to the brain, which
needs OpenAI-compatible speech servers. One command runs both locally:

```bash
docker compose -f compose.speech.yaml up -d   # NVIDIA GPU; see the file for CPU images
```

```bash
PAL_STT_URL=http://127.0.0.1:8000/v1
PAL_STT_MODEL=Systran/faster-whisper-small
PAL_TTS_URL=http://127.0.0.1:8880/v1
PAL_TTS_MODEL=kokoro
```

OpenAI's own audio endpoints work too. The hardware side is in [DEVICE.md](DEVICE.md).

## Running it somewhere else

| Variable        | Default           | Does                                                   |
| --------------- | ----------------- | ------------------------------------------------------ |
| `PAL_PORT`      | `18790`           | Brain port                                             |
| `PAL_WEB_PORT`  | `5174`            | Web port                                               |
| `PAL_HOST`      | `127.0.0.1`       | Brain bind address; anything else requires `PAL_TOKEN` |
| `PAL_DATA_DIR`  | `apps/brain/data` | SQLite database and pal data                           |
| `PAL_AUTH_FILE` | `./auth.json`     | OAuth credentials from `pnpm login`                    |

Back up `PAL_DATA_DIR` and you've backed up every pal, memory and note.
