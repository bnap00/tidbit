# How it works

The AI never draws anything. It picks from a menu, and a procedural renderer does
the rest. This page walks through that split.

## Two tiny payloads

| Payload  | Made                        | Size                | Holds                                                    |
| -------- | --------------------------- | ------------------- | -------------------------------------------------------- |
| **DNA**  | Once, when a pal is created | ~400 bytes          | Which parts, which colours, what temperament, what voice |
| **Turn** | Every reply                 | ~150 bytes per beat | Mood, gesture, gaze, effect, words                       |

A turn the model sends back:

```json
{
  "v": 1,
  "beats": [
    {
      "mood": "surprised",
      "intensity": 2,
      "say": "Wait, it's your birthday?",
      "action": "jump",
      "look": "user",
      "fx": "exclaim"
    },
    {
      "mood": "excited",
      "intensity": 3,
      "say": "Happy birthday!!",
      "action": "cheer",
      "look": "user",
      "fx": "sparkles"
    }
  ],
  "bond": "up"
}
```

That's the whole interface between the model and the screen. No coordinates, no
SVG, no keyframes, no generated images.

## The renderer is a puppet rig

`packages/rig` holds all the artistic knowledge:

- **Parts** are drawn from five primitives (ellipses, rounded rectangles, triangles,
  lines and arcs). Every pal fits in at most 96 draw calls.
- **A mood** maps to a 17-channel pose vector (eye openness, brow angle, mouth
  curve, squash, arm positions...). Springs ease the face toward it.
- **A gesture** is a short keyframe track stored in the rig. The model says `"jump"`,
  and the rig knows what a jump looks like.
- **Idle life** (breathing, blinking, glancing, activities like the paper plane) is a
  pure function of time and the pal's seed, so it runs with zero model calls and
  every viewer sees the same thing at the same moment.
- **The renderer is total.** Every schema-valid input renders something sensible. A
  property test pushes 1,000 random pals through every gesture and checks that
  nothing throws, leaves the circle or draws an empty frame.

Making every pal look better is a renderer change, with no change to stored data.

## The brain is a pi agent

`apps/brain` wraps the [pi SDK](https://pi.dev) agent loop. Swapping providers is an
environment variable. The model gets a small set of tools:

| Group        | Tools                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Expression   | `perform` (the turn above), `create_character`, `update_self`                  |
| Memory       | `remember`, `recall`, `forget`                                                 |
| Time         | `set_reminder`, `list_reminders`, `cancel_reminder`, `get_time`, `get_weather` |
| Second brain | `add_task`, `list_tasks`, `complete_task`, `file_capture`                      |
| Abilities    | `use_skill`, `save_skill`, `web_fetch`, `web_search`, `run_action`             |

Model output is checked against strict schemas, and `normalize*()` repairs common
mistakes instead of failing. A bad hue wraps around and a missing intensity defaults
to 2.

Prompts are built to keep the provider's prompt cache warm. The system prompt is
append-only, memories are shown once per session, and skills appear as a short
index that's loaded on demand.

`ScriptedBrain` implements the same interface with rules instead of a model. It's
why everything works offline, and why the tests never call a real LLM.

## One rig, two screens

The browser draws the rig on a canvas with lighting, shading and parallax added in
`PetTarget`. The ESP32 firmware doesn't port the rig. The brain runs the same rig
and streams each frame's draw commands (250 to 500 bytes) over Wi-Fi, and the device
only rasterises them. There's one implementation and it matches pixel for pixel.

## Layout

```
packages/protocol   schemas, enums, normalizers, rig data (the single source of truth)
packages/rig        the procedural renderer
apps/brain          server, ScriptedBrain and PiBrain, tools, SQLite store, scheduler
apps/web            the browser UI (vanilla TypeScript + Vite)
firmware/           ESP-IDF firmware for the Waveshare ESP32-S3 AMOLED 1.8
e2e/                Playwright tests, including the 60 fps gate
```
