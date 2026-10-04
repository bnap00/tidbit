# The pal on a device

Target hardware: **Waveshare ESP32-S3-Touch-AMOLED-1.8**
([docs](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.8)).

| Part    | On the board                                                               | What the pal uses it for                                                                          |
| ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| MCU     | ESP32-S3R8, 8 MB PSRAM, 16 MB flash                                        | Framebuffer (368×448×2 ≈ 330 KB in PSRAM), recording buffer                                       |
| Screen  | 1.8" 368×448 AMOLED, QSPI (V1: SH8601 + FT3168 touch, V2: CO5300 + CST820) | Pet in a circle on top, agenda strip below. Black pixels are off, so an always-on agenda is cheap |
| Audio   | ES8311 codec, onboard mic and speaker (I²S)                                | Captures, questions, spoken replies                                                               |
| Storage | TF card slot                                                               | Recordings made offline, uploaded later                                                           |
| RTC     | PCF85063                                                                   | Correct "said at" times while offline (`X-Recorded-At`)                                           |
| IMU     | QMI8658                                                                    | Shake → `touch: shake`; pick-up wakes the screen                                                  |
| Power   | AXP2101, LiPo connector                                                    | Battery level on the home screen; PWR short/long press                                            |
| Buttons | BOOT, PWR                                                                  | See controls below                                                                                |

The device never talks to a model. It is a thin client of the brain: everything in
this document already works and is tested against the brain today
(`apps/brain/test/second-brain.test.ts`), and `pnpm device-sim` drives it from a
terminal the same way the firmware will.

## Controls

The board has two buttons, so touch and motion carry the rest. These follow the
Palanote 2.0 interaction (one button to capture, one to ask, double presses for
briefings, both held for connection mode).

| Input                              | Action                      | API                                       |
| ---------------------------------- | --------------------------- | ----------------------------------------- |
| BOOT press-and-hold, talk, release | Capture a thought           | `POST /api/device/capture`                |
| BOOT double press                  | Today's briefing            | `POST /api/device/brief {"scope":"day"}`  |
| Swipe up on the screen, hold, talk | Ask a question              | `POST /api/device/ask`                    |
| BOOT triple press                  | The week's briefing         | `POST /api/device/brief {"scope":"week"}` |
| Tap / stroke the pet               | Poke / pet                  | WebSocket `touch`                         |
| Shake                              | Shake                       | WebSocket `touch`                         |
| PWR short                          | Screen on / off             | (device only)                             |
| PWR long (3 s)                     | Pairing mode                | `POST /api/device/pair/start`             |
| While recording, tap the screen    | Add a marker (Classic mode) | `X-Markers`                               |

## Network

The brain listens on loopback only. The device reaches it through the web server's
`/api` and `/ws` proxies, so the web server must listen on the LAN:

```bash
PAL_WEB_HOST=0.0.0.0 pnpm dev      # or the machine's LAN address
```

The ESP32 cannot join Tailscale. It needs the brain machine's LAN address (or a
LAN-reachable name) and Wi-Fi it knows. When Wi-Fi is missing it keeps recording to the
TF card and uploads later.

## Pairing

1. PWR long press. The device calls `POST /api/device/pair/start {"name":"Desk pal"}`
   and gets `{code, pollToken, expiresAt}`. It shows the 6-digit code.
2. The owner opens the pal in a browser → **Your devices** → **Connect a device** and
   enters the code.
3. The device polls `POST /api/device/pair/poll {"pollToken"}` every 2 s:
   `{"status":"pending"}` until approved, then once `{"status":"paired","token"}`.
   It stores the token in NVS. Codes expire after 10 minutes.
4. Every later request carries `Authorization: Bearer <token>`. The owner can remove
   the device under **Your devices**, which revokes the token.

## API

All bodies are JSON unless noted. Errors are `{"error": "..."}` with a 4xx/5xx status.

### `GET /api/device/home`

Everything the home screen needs, in one response.

```json
{
  "now": 1790838925878,
  "offsetMinutes": 330,
  "pal": { "id": "pal_…", "name": "Poko", "mood": "happy", "growth": 1 },
  "dna": { "...": "the pal's DNA, for the rig" },
  "needs": { "energy": 79, "hunger": 20, "bond": 50 },
  "agenda": {
    "type": "agenda",
    "date": "2026-10-01",
    "open": 3,
    "overdue": 1,
    "tasks": [
      { "id": 4, "text": "Order filament", "due": 1790793000000, "allDay": true, "overdue": false }
    ],
    "events": [{ "id": 9, "text": "Dentist", "at": 1793250000000 }]
  },
  "speech": { "stt": true, "tts": true }
}
```

`agenda` is the same compact message the WebSocket pushes. At most 5 tasks and 3
events, texts cut to 48 characters, always under 1 KB.

### `POST /api/device/capture`

The capture button. The body is the recording or text:

| Content-Type                                | Body                                                    |
| ------------------------------------------- | ------------------------------------------------------- |
| `audio/wav`                                 | 16 kHz, 16-bit, mono PCM WAV (simplest from the ES8311) |
| `audio/ogg`                                 | Ogg/Opus (smaller; needs an encoder on the device)      |
| `text/plain` or `application/json {"text"}` | Text                                                    |

| Header          | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `X-Request-Id`  | A UUID stored with the recording. Retries never file twice             |
| `X-Recorded-At` | Epoch ms from the RTC when it was said. "Tomorrow" is relative to this |
| `X-Markers`     | `12.5,40` seconds where the screen was tapped while recording          |
| `X-File: 0`     | Classic mode: keep it as a note, don't file tasks or dates             |

Response: `{"noteId", "filed": ["task #3"], "summary": "Task: Order filament (today)", "transcript", "replayed"}`.
Show `summary` on screen; the pet also nods on every connected screen.

Audio is limited to 8 MB, about 4 minutes of 16 kHz WAV. Longer Classic recordings should
be split into parts with consecutive `X-Request-Id`s.

### `POST /api/device/ask`

The ask button, with the same bodies as capture. The question goes into the current
conversation, so browsers see it. Response: `{"question", "text", "turn"}`. `turn` holds
the beats (mood, gesture, words) to perform.

### `POST /api/device/brief`

`{"scope": "day" | "week"}` → `{"text", "turn"}`.

### `POST /api/device/speak`

`{"text"}` → `audio/wav` in the pal's own Kokoro voice (from its DNA timbre and speed).
Play it through the ES8311 while performing the turn's beats.

### WebSocket `/ws` (optional, for a live pet)

Send `hello` with `ownerToken` and
`caps: {"w":368,"h":448,"colors":65536,"input":["button","touch","imu","mic"]}`.
The brain pushes `character` (DNA), `turn`, `mood`, `needs`, `growth` and `agenda`, and
accepts `touch`, `capture` (text, up to 1,000 characters) and `brief`. Every frame is
under 1 KB. A device that only polls `GET /api/device/home` every minute still works.

## Speech servers

Speech-to-text and text-to-speech are any OpenAI-compatible servers, configured on the
brain (`.env`):

```bash
# Local, free: faster-whisper behind the OpenAI API
docker run -d -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
PAL_STT_URL=http://127.0.0.1:8000/v1
PAL_STT_MODEL=Systran/faster-whisper-small

# Local Kokoro, the same voices the browser uses
docker run -d -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
PAL_TTS_URL=http://127.0.0.1:8880/v1
```

OpenAI's own API works too (`PAL_STT_URL=https://api.openai.com/v1`, `PAL_STT_KEY`,
`PAL_STT_MODEL=whisper-1`). That has per-use costs, like Palanote's API key.

## Firmware: the pal on the screen

`firmware/` is an ESP-IDF 5.3 project that puts the pal on the AMOLED over Wi-Fi, and
lets you talk to it through the onboard microphone and speaker. The brain runs the same rig the browser uses
and streams each frame's draw commands. The firmware rasterises them with the browser
pal's top-left light, so the pal, its moods, actions, effects and idle activities match
the browser exactly.

| On the device           | What happens                                      |
| ----------------------- | ------------------------------------------------- |
| Tap the pal             | Poke                                              |
| Stroke across the pal   | Pet; the pal watches your finger while it is down |
| BOOT tap                | Feed                                              |
| BOOT hold, talk, let go | Ask the pal; it answers on screen and out loud    |
| BOOT held 10 s, silent  | Wi-Fi setup (any hold of 10 s off the pal screen) |
| Swipe down from the top | Settings: drag the Brightness and Volume bars     |
| Swipe up, or BOOT       | Close settings (they also close after 15 s)       |
| Shake it                | Shake                                             |
| Tilt it                 | The pal glances downhill, then settles            |
| Leave it alone 30 s     | The pal dozes off and the screen fades to off     |
| Touch, BOOT, pick it up | The screen fades in and the pal wakes and waves   |
| The strip under the pal | Its words, typed out as in the browser            |

The touch or press that wakes the screen does nothing else. The pal starting to speak (a
reminder, a reply from a browser) also wakes it. The delay is `menuconfig` → Tidbit →
Screen off (0 = never). The IMU (QMI8658) reading is in `GET /info` as `accel` (g) and
`gyro` (°/s) in screen axes: x right, y down, z out of the screen.

**Voice.** Holding BOOT records 24 kHz mono from the ES8311 (up to 30 s, in PSRAM) and
shows "Listening…". On release the WAV goes to `POST /api/device/ask`; the answer's turn
reaches the screen through the stream, and its words come back from
`POST /api/device/speak` as WAV, played as they download. The brain needs `PAL_STT_URL`
and `PAL_TTS_URL`; `compose.speech.yaml` runs speaches (faster-whisper) and Kokoro-FastAPI
on an NVIDIA GPU:

```bash
docker compose -f compose.speech.yaml up -d
# .env
PAL_STT_URL=http://127.0.0.1:8000/v1
PAL_STT_MODEL=Systran/faster-distil-whisper-large-v3
PAL_TTS_URL=http://127.0.0.1:8880/v1
PAL_TTS_MODEL=kokoro
```

`GET /info` reports `"voice": true` when the codec answered. Holds under 0.4 s are taps,
and a recording with nothing louder than the room is dropped ("I didn't hear anything").

**Build and flash** (Docker, nothing else to install):

```bash
PAL_WEB_HOST=0.0.0.0 pnpm dev            # the pal must reach the web server on the LAN
cd firmware
./idf.sh build
./idf.sh -p /dev/ttyACM0 flash                    # only once, over USB
./ota.sh waveshare-amoled-18 tidbit-xxxx.local     # every update after that, over Wi-Fi
```

The first USB flash installs a layout with two app slots. After that, `ota.sh` builds and
sends the firmware to `http://tidbit-xxxx.local/ota` (the name is the last bytes of the
pal's MAC address, also logged at boot). The password is generated into the gitignored
`firmware/sdkconfig.local` on the first build, so only builds from this checkout are
accepted. A new build that does not stay up for 30 s is rolled back. Opening the USB
serial port resets the board, so wait 30 s after an update before reading the log.
`GET /info` shows the board, the build and the slot.

Boards flashed before the rename still answer as `a-pal-xxxx.local`. Send the first
update to the board's IP address instead: once it boots, it advertises
`tidbit-xxxx.local`, so a check against the old name would time out. Wi-Fi, server
and pairing settings survive the update.

For serial access from Docker under rootless Docker, allow Espressif ports once:
`echo 'SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", MODE="0666"' | sudo tee /etc/udev/rules.d/99-esp32.rules`
and reload udev.

If no `/dev/ttyACM*` appears, use a data USB-C cable (not a charge-only one), or hold
BOOT while plugging in to force the download mode.

**First start.** The pal opens a Wi-Fi network called `tidbit-XXXX`. Join it from a phone;
the setup page asks for your Wi-Fi and the Tidbit server (`<LAN address>:5174`, not a
Tailscale address). The pal restarts, joins your Wi-Fi and shows a 6-digit code. Enter
it in the browser under **Your devices → Connect a device**. To skip the setup network,
copy `firmware/sdkconfig.local.example` to `firmware/sdkconfig.local` with your Wi-Fi and
server before building.

**How it streams.** The device says `hello` with
`caps: {"stream": "rig", "fps": 24, ...}`. The brain keeps a rig for that socket, fed
by the same messages a browser gets (`apps/brain/src/rig-stream.ts`). Instead of JSON it
sends:

- `{"type":"stream","name","palette":[[r,g,b]×8],"fps"}` when the pal (DNA) changes;
- one binary message per frame: `0x46, 1, u16 count, u32 ms`, then per command
  `u8 op | slot << 4` and int16 parameters (1/16 virtual pixel; arc angles in
  milliradians). That is 250–500 bytes, about 10 KB/s at 24 fps;
- `{"type":"caption","text","charMs"}` when a beat with words starts, and `""` when it ends;
- `{"type":"thinking","on"}` and errors.

It sends back `touch`, `{"type":"attend","x","y"}` (finger or tilt, or `x: null`) and
`{"type":"rest","on"}` when its screen turns off or on. Resting, the stream plays a
sleepy beat, stops sending frames after 4 s, and on waking plays a surprised, then
waving beat (unless a turn is already playing).
Frames are skipped while 16 KB is still queued on a slow link. Without a connection the
last frame stays up, dimmed, with "Reconnecting…".

The dark backdrop (`menuconfig` → Tidbit → Dark backdrop, on by default) draws the pal's
backdrop colour as a glow behind it that falls to black, so most AMOLED pixels are off.
The backdrop is worked out per pixel in full colour and dithered once to RGB565
(`Raster::paint_backdrop565`): through the 32-level palette it banded into rings.

**Checks without hardware.** `firmware/test/host.cpp` builds the firmware's rasteriser
and text on the PC, and `firmware/test/conformance.ts` compares it with the rig's
`IndexedBufferTarget` on streamed frames (under 0.2 % of pixels differ, all on edges).
It also writes previews of the screen:

```bash
g++ -O2 -std=c++17 -o /tmp/palhost firmware/test/host.cpp firmware/main/raster.cpp firmware/main/text.cpp
pnpm exec tsx firmware/test/conformance.ts /tmp/palhost /tmp/pal-preview
```

The board revision (V1 SH8601/FT3168 or V2 CO5300/CST820) is detected from the touch
controller. `idf.py menuconfig` → Tidbit can force it.

## Firmware plan

ESP-IDF ≥ 5.3.1, as in Waveshare's examples (`01_AXP2101` … `06_I2SCodec`). Check
whether the board is V1 (SH8601/FT3168) or V2 (CO5300/CST820) when it arrives.

1. **Bring-up.** Flash Waveshare's demos, then the stock XiaoZhi firmware
   (`waveshare/esp32-s3-touch-amoled-1.8[-v2]` board) to confirm the screen, touch,
   mic and speaker work.
2. **Thin client.** Wi-Fi provisioning, pairing screen, `GET /api/device/home` every
   minute, rendering the agenda strip (LVGL is fine here), battery from the AXP2101.
3. **Capture and ask.** Record 16 kHz WAV from the ES8311 into PSRAM while BOOT is held,
   `POST` it, show `summary`. Play `/api/device/speak` audio.
4. **Offline.** No Wi-Fi: write `<uuid>.wav` plus a sidecar with `recordedAt` and markers
   to the TF card; upload in order when a known network appears; delete after a 200.
5. **The pet.** Port the rig to C++ (PLAN §7): ≤ 96 axis-aligned primitives, the same
   PRNG, at 368 px in a circle at the top of the screen. Until then, show the mood as a
   face, the way XiaoZhi does.
6. **Web flasher.** Serve an ESP Web Tools manifest from the web app so the firmware
   installs from the browser over USB.

## Try it without the device

```bash
pnpm dev                                  # brain + web
pnpm device-sim pair                      # enter the code in the browser
pnpm device-sim capture "I need to order filament today. Dentist on the 29th at 10am."
pnpm device-sim keep "Idea: a magnetic lid for the enclosure"
pnpm device-sim home
pnpm device-sim ask "what idea did I have for the enclosure?"
pnpm device-sim brief week
pnpm device-sim capture recording.wav     # with PAL_STT_URL set
pnpm device-sim speak "Hello!" hello.wav  # with PAL_TTS_URL set
```
