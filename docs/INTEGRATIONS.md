# Integrations: Home Assistant, notifications, webhooks

Your pal can call any HTTP endpoint you give it. That's the whole integration
system: an **action** is a named web request, and a **skill** is a page of
instructions that tells the pal when and how to use it. Neither one runs code on your
machine.

Open **Skills & actions** in the pal's side pane to add them.

## How an action works

| Field       | Example                                                      | Notes                                                  |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Name        | `lamp-on`                                                    | What the pal calls it                                  |
| Description | `Turn on a light. Input is the light's entity name.`         | The pal reads this to decide when to use it            |
| Method      | `POST`                                                       | `GET` or `POST`                                        |
| URL         | `http://homeassistant.local:8123/api/services/light/turn_on` | `{input}` is URL-encoded here                          |
| Headers     | `Authorization: Bearer eyJ...`                               | Write-only. Never shown again, never sent to the model |
| Body        | `{"entity_id": "light.{input}"}`                             | `{input}` is JSON-escaped here                         |

The pal fills `{input}` from the conversation. It sees the first 1,000 characters of
the response, so a `GET` can answer questions too.

Two rules to know:

- Actions to LAN or Tailscale hosts need `PAL_ALLOW_PRIVATE_ACTIONS=1` in `.env`.
- Redirects are not followed, and the brain's own machine is always refused.

## Home Assistant

First, create a long-lived access token in Home Assistant under
**Profile → Security → Long-lived access tokens**. Then set
`PAL_ALLOW_PRIVATE_ACTIONS=1` and restart the brain. If `homeassistant.local` doesn't
resolve on the machine running the brain, use Home Assistant's IP address instead.

Every action below uses the same header:

```
Authorization: Bearer <your long-lived token>
```

### Turn lights on and off

| Name        | Method | URL                                                           | Body                             |
| ----------- | ------ | ------------------------------------------------------------- | -------------------------------- |
| `light-on`  | POST   | `http://homeassistant.local:8123/api/services/light/turn_on`  | `{"entity_id": "light.{input}"}` |
| `light-off` | POST   | `http://homeassistant.local:8123/api/services/light/turn_off` | `{"entity_id": "light.{input}"}` |

Description: `Turn a light on (or off). Input is the entity name without "light.", e.g. living_room.`

Now "turn on the living room light" works, and the pal acts it out.

### Read a sensor

| Name          | Method | URL                                                         |
| ------------- | ------ | ----------------------------------------------------------- |
| `read-sensor` | GET    | `http://homeassistant.local:8123/api/states/sensor.{input}` |

Description: `Read a Home Assistant sensor. Input is the sensor name without "sensor.", e.g. bedroom_temperature.`

"Is it cold in the bedroom?" now gets a real answer.

### Hand anything to Assist

This one is the most flexible. It passes your words straight to Home Assistant's
own conversation agent, so anything Assist understands works without one action per
device.

| Name       | Method | URL                                                        | Body                                    |
| ---------- | ------ | ---------------------------------------------------------- | --------------------------------------- |
| `ask-home` | POST   | `http://homeassistant.local:8123/api/conversation/process` | `{"text": "{input}", "language": "en"}` |

Description: `Control or ask about the house (lights, covers, climate, media). Input is a plain English command like "close the blinds".`

### Scenes and scripts

| Name     | Method | URL                                                           | Body                              |
| -------- | ------ | ------------------------------------------------------------- | --------------------------------- |
| `scene`  | POST   | `http://homeassistant.local:8123/api/services/scene/turn_on`  | `{"entity_id": "scene.{input}"}`  |
| `script` | POST   | `http://homeassistant.local:8123/api/services/script/turn_on` | `{"entity_id": "script.{input}"}` |

### Put it on a schedule

Routines carry out a task with the pal's tools when they fire. Just ask:

> Every weekday at 7, turn on the kitchen light and give me a morning briefing.

> Every day at 11pm, run the goodnight scene.

### Teach it a habit with a skill

A skill bundles the steps. Paste this into **Skills & actions → New skill**:

```markdown
---
name: goodnight
description: Wind the house down when the user says goodnight.
---

1. Call run_action "scene" with "goodnight".
2. Call list_tasks and mention anything due tomorrow morning, briefly.
3. Wish the user a good night in your own style, sleepy mood, sleep action.
```

## Notifications with ntfy

Let the pal push to your phone. Install the ntfy app and subscribe to a topic that
only you know.

| Name           | Method | URL               | Body                                                   |
| -------------- | ------ | ----------------- | ------------------------------------------------------ |
| `notify-phone` | POST   | `https://ntfy.sh` | `{"topic": "your-secret-topic", "message": "{input}"}` |

Description: `Send a push notification to the user's phone. Input is the message.`

Combine it with a routine: "Every day at 6pm, check the weather for tomorrow and
notify my phone if it's going to rain."

Self-hosted ntfy on your LAN works the same way with `PAL_ALLOW_PRIVATE_ACTIONS=1`.

## Any webhook

n8n, Zapier, Make, IFTTT, a Cloudflare Worker, your own API: anything that takes an
HTTP request is an action. Some ideas:

- **Log to a spreadsheet**: an n8n webhook that appends `{input}` to a Google Sheet.
  "Log that I ran 5 km."
- **Start a timer or a playlist** through a home server endpoint.
- **Query your own data**: a `GET` endpoint that returns today's stats as short JSON.

Keep responses short. The pal only reads the first 1,000 characters.

## Web search

Set `PAL_BRAVE_API_KEY` or `PAL_SEARXNG_URL` (see [SETUP.md](SETUP.md)) and the
built-in **look it up** skill starts searching before it answers.

## A pal on your desk

The same brain drives a Waveshare ESP32-S3 AMOLED board: the pal on a 1.8" screen,
hold-to-talk voice, touch, shake and tilt. The device has no model of its own. The
brain streams the drawing commands to it, so it matches the browser exactly. See
[DEVICE.md](DEVICE.md).

Building your own client? The device API (`/api/device/*`) is small and documented
in the same file, and `pnpm device-sim` exercises it without hardware.

## What actions can't do

On purpose, there are no shell, file or code-execution tools. Skills are
instructions, and actions are requests that you defined. A pal can write its own
skills, but it can't create new actions or reach anything you didn't give it.
