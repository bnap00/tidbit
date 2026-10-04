// A stand-in for the ESP32 pal (docs/DEVICE.md): pairs like the device does and drives
// the same HTTP API, so the whole flow can be tried before the hardware arrives.
//
//   pnpm device-sim pair                       show a code, wait for approval in the browser
//   pnpm device-sim home                       what the home screen would show
//   pnpm device-sim capture "buy filament"     the capture button (text)
//   pnpm device-sim capture note.wav           the capture button (audio; needs PAL_STT_URL)
//   pnpm device-sim keep "a long thought"      Classic mode: keep as a note, no filing
//   pnpm device-sim ask "what's on today?"     the ask button
//   pnpm device-sim brief day|week             double press
//   pnpm device-sim speak "hello" out.wav      the pal's voice (needs PAL_TTS_URL)
//
// PAL_DEVICE_URL picks the server (default http://127.0.0.1:5174, the web server's proxy).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

process.on("uncaughtException", (e) => {
  console.error(e.message);
  process.exit(1);
});

const base = (process.env.PAL_DEVICE_URL ?? "http://127.0.0.1:5174").replace(/\/+$/, "");
const tokenFile = resolve(process.env.PAL_DEVICE_TOKEN_FILE ?? ".device-token");
const [command = "home", ...args] = process.argv.slice(2);

function token(): string {
  if (!existsSync(tokenFile)) throw new Error("Not paired. Run: pnpm device-sim pair");
  return readFileSync(tokenFile, "utf8").trim();
}

async function call(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(auth ? { Authorization: `Bearer ${token()}` } : {}), ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`${res.status}: ${body.error ?? res.statusText}`);
  }
  return res;
}
const post = (path: string, body: unknown, auth = true) =>
  call(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    auth,
  );

const AUDIO: Record<string, string> = {
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  webm: "audio/webm",
};

async function captureBody(arg: string): Promise<{ body: string | Uint8Array; type: string }> {
  const ext = arg.split(".").pop()?.toLowerCase() ?? "";
  if (AUDIO[ext] && existsSync(arg)) return { body: readFileSync(arg), type: AUDIO[ext]! };
  return { body: arg, type: "text/plain" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

switch (command) {
  case "pair": {
    const start = (await (
      await post("/api/device/pair/start", { name: args[0] ?? "Device simulator" }, false)
    ).json()) as {
      code: string;
      pollToken: string;
      expiresAt: number;
    };
    console.log(`\n  Pairing code: ${start.code.slice(0, 3)} ${start.code.slice(3)}\n`);
    console.log("  Open your pal → Your devices → Connect a device, and enter it.\n");
    for (;;) {
      await sleep(2000);
      const res = await fetch(`${base}/api/device/pair/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollToken: start.pollToken }),
      });
      const poll = (await res.json()) as { status: string; token?: string };
      if (poll.status === "paired" && poll.token) {
        writeFileSync(tokenFile, poll.token, { mode: 0o600 });
        console.log(`Paired. Token saved to ${tokenFile}`);
        break;
      }
      if (poll.status !== "pending") throw new Error("The code expired. Try again.");
    }
    break;
  }
  case "home": {
    const home = (await (await call("/api/device/home")).json()) as {
      pal: { name: string; mood: string };
      needs: { energy: number; hunger: number; bond: number };
      agenda: {
        date: string;
        open: number;
        overdue: number;
        tasks: { text: string; due: number | null; allDay: boolean; overdue: boolean }[];
        events: { text: string; at: number }[];
      };
      speech: { stt: boolean; tts: boolean };
    };
    const a = home.agenda;
    const t = (ms: number) =>
      new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    console.log(`┌ ${home.pal.name} · feeling ${home.pal.mood} · ${a.date}`);
    console.log(
      `│ ${a.open} open task${a.open === 1 ? "" : "s"}${a.overdue ? `, ${a.overdue} overdue` : ""}`,
    );
    for (const task of a.tasks)
      console.log(
        `│  ${task.overdue ? "!" : "○"} ${task.text}${task.due && !task.allDay ? ` · ${t(task.due)}` : ""}`,
      );
    for (const e of a.events)
      console.log(
        `│  ◷ ${new Date(e.at).toLocaleDateString([], { weekday: "short" })} ${t(e.at)} ${e.text}`,
      );
    console.log(
      `└ speech-to-text ${home.speech.stt ? "on" : "off"}, voice ${home.speech.tts ? "on" : "off"}`,
    );
    break;
  }
  case "capture":
  case "keep": {
    const input = args.join(" ");
    if (!input) throw new Error("What should I capture?");
    const { body, type } = await captureBody(input);
    const res = (await (
      await call("/api/device/capture", {
        method: "POST",
        body,
        headers: {
          "Content-Type": type,
          "X-Request-Id": randomUUID(),
          "X-Recorded-At": String(Date.now()),
          ...(command === "keep" ? { "X-File": "0" } : {}),
        },
      })
    ).json()) as { summary: string; transcript: string };
    if (type !== "text/plain") console.log(`Heard: ${res.transcript}`);
    console.log(res.summary);
    break;
  }
  case "ask": {
    const input = args.join(" ");
    const { body, type } = await captureBody(input);
    const res = (await (
      await call("/api/device/ask", { method: "POST", body, headers: { "Content-Type": type } })
    ).json()) as { text: string };
    console.log(res.text);
    break;
  }
  case "brief": {
    const res = (await (
      await post("/api/device/brief", { scope: args[0] === "week" ? "week" : "day" })
    ).json()) as { text: string };
    console.log(res.text);
    break;
  }
  case "speak": {
    const out = args[1] ?? "speech.wav";
    const res = await post("/api/device/speak", { text: args[0] ?? "Hello!" });
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    console.log(`Wrote ${out}`);
    break;
  }
  default:
    console.log("Commands: pair, home, capture, keep, ask, brief, speak");
}
