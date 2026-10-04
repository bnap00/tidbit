# Development

Requires Node 22.19+ and pnpm 10.

```bash
pnpm install
pnpm dev                          # brain on 127.0.0.1:18790, web on 127.0.0.1:5174
pnpm verify                       # codegen check, typecheck, lint, unit + snapshot tests
pnpm e2e                          # Playwright: chat, pairing, outbox, second brain, 60 fps
UPDATE_SNAPSHOTS=1 pnpm test      # accept intended rig changes
```

| Script                        | Does                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `pnpm smoke`                  | Creates a pal with your configured model and chats with it  |
| `pnpm device-sim`             | Plays the part of an ESP32 device against a running brain   |
| `pnpm codegen`                | Regenerates schemas and rig tables from `packages/protocol` |
| `pnpm login <provider>`       | pi's OAuth login, writes `./auth.json`                      |
| `tsx scripts/sheet.ts random` | Renders a contact sheet of random pals to `/tmp`            |

If e2e fails to start file watchers on Linux, run it with `CHOKIDAR_USEPOLLING=1`.

## Ground rules

Keep these when you change things:

1. `packages/protocol` is the single source of truth. Don't hand-write a type, enum or
   table elsewhere if it can be imported or generated.
2. The model never produces drawing data. If you need a new visual, add an enum value
   and implement it in the rig.
3. The renderer is total. Every schema-valid input renders something sensible.
4. Every feature works with `ScriptedBrain`. Tests never call a real LLM.

## Firmware

Plain ESP-IDF, built in Docker. See [DEVICE.md](DEVICE.md).

```bash
cd firmware
./idf.sh build
./idf.sh -p /dev/ttyACM0 flash                     # first flash only
./ota.sh waveshare-amoled-18 tidbit-xxxx.local     # every update after that
```
