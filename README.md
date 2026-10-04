# Tidbit

A tiny AI pet that animates itself live, with no image or video generation. It works
with any AI provider (or offline), remembers things for you, learns skills, and can
call any API or webhook. It lives in your browser and on a small ESP32 screen.

![Chatting with a pal named Prickles, with its tasks in the side pane](docs/images/chat.png)

The model picks moods, gestures and words, and a procedural renderer draws the pet
live at 60 fps. Skipping image generation is what makes it fast, cheap and
consistent: a pal's whole body is about 400 bytes of DNA, and a reply is about 150 bytes.

It's also a real assistant. It files your notes as tasks, reminders and memories,
runs routines, searches the web, and plugs into anything with an API: Home
Assistant, n8n, Zapier, phone notifications or your own services.

## Why I built it

In September 2026 Meta gave its Muse agent a cute companion character and a
Tamagotchi-like gadget, and OpenAI launched Dots, its bubbly always-on agents. Every
assistant was getting a face. I wanted to know how hard it is to build one of these
without generating any images or media, running on my own machine, with whatever AI
provider I like. Turns out, not that hard. The full story is in
[the launch post](https://bnap.dev/blog/tidbit-an-ai-pet-that-never-generates-an-image).

## Try it

```bash
pnpm install
pnpm dev        # open http://127.0.0.1:5174
```

You don't need an API key. Without one, a rule-based brain runs everything offline.
When you want a real model, add a few lines to `.env`. Anthropic, OpenAI, Google, Groq,
your ChatGPT subscription or a local Ollama all work through the [pi SDK](https://pi.dev).

```bash
cp .env.example .env
# PAL_PROVIDER=anthropic
# PAL_MODEL=claude-sonnet-5
# ANTHROPIC_API_KEY=...
```

Requires Node 22.19+ and pnpm 10.

## What's inside

| Out of the box                                       | With a little setup                                            |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| Billions of procedurally drawn pals, 60 fps          | Any AI provider, cloud or local                                |
| Moods, gestures, effects, idle activities            | Any API or webhook as an action, with secrets kept server-side |
| Poke, pet, feed; needs that drift; growth            | Smart home: Home Assistant lights, sensors, scenes, Assist     |
| Memories, reminders, routines, weather               | Web search (Brave or SearXNG)                                  |
| Notes, tasks and briefings that file themselves      | Automations: n8n, Zapier, ntfy phone notifications             |
| SKILL.md skills, natural voice, multi-device pairing | A pal on an ESP32 AMOLED screen with voice                     |

![24 random pals in the gallery](docs/images/gallery.png)

## Docs

- [Features](docs/FEATURES.md): everything that works with zero setup
- [Setup](docs/SETUP.md): models, phone access, voice, search
- [Integrations](docs/INTEGRATIONS.md): connect any API, with recipes for Home Assistant, ntfy and n8n
- [How it works](docs/HOW-IT-WORKS.md): DNA, turns, the rig and the brain
- [Device](docs/DEVICE.md): the ESP32 firmware and device API
- [Development](docs/DEVELOPMENT.md): scripts, tests and ground rules

## License

[MIT](LICENSE)
