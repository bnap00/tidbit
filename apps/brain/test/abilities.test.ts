// Skills, actions, web reading and routines. Never calls a real LLM or the network.
import { afterEach, describe, expect, it } from "vitest";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Model,
} from "@earendil-works/pi-ai";
import { parseSkillMarkdown, skillSlug, skillToMarkdown } from "@tidbit/protocol";
import { AbilitiesStore, nextDue } from "../src/abilities-store.js";
import { PiBrain } from "../src/pi/pi-brain.js";
import { ScriptedBrain } from "../src/scripted-brain.js";
import { startServer } from "../src/server.js";
import { PalService } from "../src/service.js";
import { Store } from "../src/store.js";
import { createTools } from "../src/tools.js";
import {
  actionRequest,
  addressScope,
  checkUrl,
  fetchPage,
  htmlToText,
  runHttpAction,
  type Lookup,
} from "../src/web.js";
import { MemorySession, ctxFor } from "./helpers.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const hosts: Record<string, string[]> = {
  "example.com": ["93.184.215.14"],
  "evil.test": ["127.0.0.1"],
  "lan.test": ["192.168.1.20"],
  "home.test": ["192.168.1.30"],
};
const lookup: Lookup = async (h) => hosts[h] ?? [];

type Call = { url: string; init?: RequestInit };
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

describe("SKILL.md", () => {
  it("parses frontmatter, falls back to headings, and round-trips", () => {
    const md = `---\nname: Plan A Picnic\ndescription: "Plan a picnic with the weather."\n---\n\n# Picnic\n\n1. get_weather\n2. suggest snacks`;
    const skill = parseSkillMarkdown(md)!;
    expect(skill).toEqual({
      name: "plan-a-picnic",
      description: "Plan a picnic with the weather.",
      body: "# Picnic\n\n1. get_weather\n2. suggest snacks",
    });
    expect(parseSkillMarkdown(skillToMarkdown(skill))).toEqual(skill);
    expect(parseSkillMarkdown("# Tea time\n\nBrew tea together.\n\n1. Ask.")?.name).toBe(
      "tea-time",
    );
    expect(parseSkillMarkdown("")).toBeUndefined();
    expect(parseSkillMarkdown("---\nname: ***\n---\n")).toBeUndefined();
    expect(skillSlug("  Héllo, World!! ")).toBe("hello-world");
  });
});

describe("web safety", () => {
  it("classifies addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ])
      expect(addressScope(ip), ip).toBe("local");
    for (const ip of ["10.0.0.1", "172.20.1.1", "192.168.0.5", "100.100.1.1", "fd00::1"])
      expect(addressScope(ip), ip).toBe("private");
    for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700::1111"])
      expect(addressScope(ip), ip).toBe("public");
  });

  it("refuses local, private, credentialed and non-http URLs", async () => {
    await expect(checkUrl("https://example.com/a", { lookup })).resolves.toBeInstanceOf(URL);
    for (const bad of [
      "file:///etc/passwd",
      "http://localhost:18790/health",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest",
      "http://evil.test/",
      "http://lan.test/",
      "https://user:pw@example.com/",
      "not a url",
    ])
      await expect(checkUrl(bad, { lookup }), bad).rejects.toThrow();
    await expect(
      checkUrl("http://lan.test/", { lookup, allowPrivate: true }),
    ).resolves.toBeTruthy();
    await expect(checkUrl("http://evil.test/", { lookup, allowPrivate: true })).rejects.toThrow();
  });

  it("extracts readable text from HTML", () => {
    const { title, text } = htmlToText(
      "<html><head><title>Cats &amp; Dogs</title><style>x{}</style></head><body><nav>menu</nav><script>alert(1)</script><p>Cats&nbsp;purr.</p><p>Dogs &#8212; bark.</p></body></html>",
    );
    expect(title).toBe("Cats & Dogs");
    expect(text).toBe("Cats purr.\nDogs — bark.");
  });

  it("reads a page and re-checks redirects", async () => {
    const ok = fakeFetch(() => html("<title>Hi</title><p>Hello there</p>"));
    const page = await fetchPage(
      { fetch: ok.fetch, lookup },
      "https://example.com/",
      AbortSignal.timeout(1000),
    );
    expect(page).toContain("Hi\nhttps://example.com/");
    expect(page).toContain("Hello there");

    const hop = fakeFetch((url) =>
      url.includes("example.com")
        ? html("", 302, { location: "http://evil.test/admin" })
        : html("secret"),
    );
    await expect(
      fetchPage({ fetch: hop.fetch, lookup }, "https://example.com/", AbortSignal.timeout(1000)),
    ).rejects.toThrow("private network");
    expect(hop.calls).toHaveLength(1);

    const binary = fakeFetch(() => new Response("x", { headers: { "content-type": "image/png" } }));
    await expect(
      fetchPage({ fetch: binary.fetch, lookup }, "https://example.com/", AbortSignal.timeout(1000)),
    ).rejects.toThrow("image/png");
  });

  it("fills action templates safely and sends secret headers", async () => {
    const action = {
      name: "lamp",
      method: "POST" as const,
      url: "https://example.com/hook?room={input}",
      headers: [["Authorization", "Bearer s3cret"]] as [string, string][],
      bodyTemplate: '{"say":"{input}"}',
    };
    const req = actionRequest(action, 'living "room" & more');
    expect(req.url).toBe("https://example.com/hook?room=living%20%22room%22%20%26%20more");
    expect(JSON.parse(req.body!)).toEqual({ say: 'living "room" & more' });
    expect(actionRequest({ ...action, bodyTemplate: "" }, "x").body).toBe('{"input":"x"}');

    const f = fakeFetch(() => new Response("ok", { status: 200 }));
    const res = await runHttpAction(
      { fetch: f.fetch, lookup },
      action,
      "kitchen",
      AbortSignal.timeout(1000),
    );
    expect(res).toBe("lamp done (200). Response: ok");
    expect((f.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer s3cret",
    );
    await expect(
      runHttpAction(
        { fetch: f.fetch, lookup },
        { ...action, url: "http://home.test/" },
        "",
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("private network");
  });
});

describe("routines", () => {
  it("advances repeating reminders and skips missed occurrences", () => {
    const at = (s: string) => new Date(s).getTime();
    const mon9 = at("2026-09-28T09:00:00"); // a Monday
    expect(nextDue(mon9, "none", mon9)).toBeUndefined();
    expect(nextDue(mon9, "daily", mon9)).toBe(at("2026-09-29T09:00:00"));
    expect(nextDue(mon9, "hourly", mon9)).toBe(at("2026-09-28T10:00:00"));
    expect(nextDue(mon9, "weekly", mon9)).toBe(at("2026-10-05T09:00:00"));
    const fri9 = at("2026-10-02T09:00:00");
    expect(nextDue(fri9, "weekdays", fri9)).toBe(at("2026-10-05T09:00:00"));
    // Offline for three days: the next one is tomorrow, not a backlog.
    expect(nextDue(mon9, "daily", at("2026-10-01T12:00:00"))).toBe(at("2026-10-02T09:00:00"));
  });

  it("a repeating reminder fires as a proactive turn and stays scheduled", async () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    let now = Date.parse("2026-09-29T08:59:00");
    const service = new PalService(store, new ScriptedBrain(), { clock: () => now });
    const res = await service.turn({ kind: "say", text: "every day at 9am remind me to stretch" });
    expect(res.turn.beats[0]?.say).toMatch(/Every day at/);
    const [routine] = service.abilitiesState().routines;
    expect(routine).toMatchObject({ text: "stretch", repeat: "daily" });
    now = routine!.dueAt + 1000;
    const due = service.dueReminders();
    expect(due).toHaveLength(1);
    const fired = await service.remind(due[0]!);
    expect(fired.turn.beats.map((b) => b.say).join(" ")).toContain("stretch");
    const after = service.abilitiesState().routines;
    expect(after).toHaveLength(1);
    expect(after[0]!.dueAt).toBe(routine!.dueAt + 86_400_000);
    expect(service.dueReminders()).toEqual([]);
    // Small talk is not a routine.
    await service.turn({ kind: "say", text: "every day I go running" });
    expect(service.abilitiesState().routines).toHaveLength(1);
    await service.manage({ action: "cancel_routine", palId: service.pal.id, itemId: routine!.id });
    expect(service.abilitiesState().routines).toEqual([]);
  });
});

describe("skill and action tools", () => {
  function setup(fetchImpl: typeof fetch = fakeFetch(() => new Response("ok")).fetch) {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const ctx = ctxFor(new MemorySession(), 1, store);
    const abilities = new AbilitiesStore(store);
    const tools = createTools({
      store,
      palId: ctx.dna.id,
      clock: Date.now,
      fetch: fetchImpl,
      abilities,
      lookup,
    });
    return { store, abilities, tools, palId: ctx.dna.id };
  }

  it("seeds starter skills once, loads them by name and counts uses", () => {
    const { abilities, tools, palId } = setup();
    expect(abilities.skills(palId).map((s) => s.name)).toEqual([
      "customize-me",
      "focus-buddy",
      "look-it-up",
      "morning-briefing",
    ]);
    expect(tools.useSkill("Morning Briefing")).toContain("get_weather");
    expect(abilities.skill(palId, "morning-briefing")!.uses).toBe(1);
    const id = abilities.skill(palId, "focus-buddy")!.id;
    abilities.deleteSkill(palId, id);
    expect(abilities.skills(palId)).toHaveLength(3);
    abilities.setSkillEnabled(palId, abilities.skill(palId, "look-it-up")!.id, false);
    expect(() => tools.useSkill("look-it-up")).toThrow(
      /Known skills: customize-me, morning-briefing$/,
    );
  });

  it("lets the pal write and refine its own skills but not the owner's", () => {
    const { abilities, tools, palId } = setup();
    expect(tools.saveSkill("Plan a picnic", "Plan a picnic.", "1. get_weather")).toMatch(/Saved/);
    expect(tools.saveSkill("plan-a-picnic", "Plan a picnic.", "1. get_weather\n2. snacks")).toMatch(
      /Updated/,
    );
    expect(abilities.skill(palId, "plan-a-picnic")).toMatchObject({
      source: "pal",
      body: "1. get_weather\n2. snacks",
    });
    abilities.saveSkill(palId, { name: "tea", description: "Tea.", body: "Brew." }, "owner");
    expect(() => tools.saveSkill("tea", "Tea!", "Boil.")).toThrow(/written by the user/);
    expect(() => tools.saveSkill("morning-briefing", "x", "y")).toThrow(/written by the user/);
    expect(() => tools.saveSkill("customize-me", "x", "y")).toThrow(/written by the user/);
    for (let i = 0; abilities.skills(palId).length < 30; i++)
      abilities.saveSkill(palId, { name: `s${i}`, description: "d", body: "b" }, "owner");
    expect(() => tools.saveSkill("one-too-many", "d", "b")).toThrow(/at most 30/);
  });

  it("runs enabled actions only", async () => {
    const f = fakeFetch(() => new Response('{"ok":true}'));
    const { abilities, tools, palId } = setup(f.fetch);
    abilities.saveAction(palId, {
      name: "lamp-on",
      description: "Turn on a lamp; input is the room.",
      method: "GET",
      url: "https://example.com/lamp?room={input}",
    });
    expect(await tools.runAction("Lamp On", "den")).toBe(
      'lamp-on done (200). Response: {"ok":true}',
    );
    expect(f.calls[0]!.url).toBe("https://example.com/lamp?room=den");
    expect(abilities.action(palId, "lamp-on")!.uses).toBe(1);
    abilities.setActionEnabled(palId, abilities.action(palId, "lamp-on")!.id, false);
    await expect(tools.runAction("lamp-on", "")).rejects.toThrow(/no action/);
    await expect(tools.webSearch("cats")).rejects.toThrow(/not set up/);
  });
});

describe("owner management", () => {
  function setup() {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const service = new PalService(store, new ScriptedBrain());
    const palId = service.pal.id;
    return { store, service, palId };
  }

  it("imports SKILL.md, toggles and deletes skills", async () => {
    const { service, palId } = setup();
    await service.manage({
      action: "save_skill",
      palId,
      skillMarkdown:
        "---\nname: Bedtime story\ndescription: Tell a short story.\n---\n1. Ask for a hero.",
    });
    const skill = service.abilitiesState().skills.find((s) => s.name === "bedtime-story")!;
    expect(skill).toMatchObject({ source: "owner", enabled: true });
    await service.manage({ action: "toggle_skill", palId, itemId: skill.id, enabled: false });
    expect(service.abilitiesState().skills.find((s) => s.id === skill.id)!.enabled).toBe(false);
    await service.manage({ action: "delete_skill", palId, itemId: skill.id });
    expect(service.abilitiesState().skills.some((s) => s.id === skill.id)).toBe(false);
    await expect(
      service.manage({ action: "save_skill", palId, skillMarkdown: "nothing useful" }),
    ).rejects.toThrow(/Couldn't read/);
  });

  it("never exposes action secrets and refuses this machine", async () => {
    const { service, palId } = setup();
    const httpAction = {
      name: "Ping Phone",
      description: "Send a push notification; input is the message.",
      method: "POST",
      url: "https://ntfy.sh/my-topic",
      headers: "Authorization: Bearer top-secret",
    };
    await service.manage({ action: "save_http_action", palId, httpAction });
    const state = service.abilitiesState();
    expect(JSON.stringify(state)).not.toContain("top-secret");
    expect(state.actions[0]).toMatchObject({ name: "ping-phone", headerNames: ["Authorization"] });
    // Editing without headers keeps the stored secret.
    await service.manage({
      action: "save_http_action",
      palId,
      httpAction: { ...httpAction, headers: undefined, description: "Push a note." },
    });
    expect(service.abilities.action(palId, "ping-phone")!.headers).toEqual([
      ["Authorization", "Bearer top-secret"],
    ]);
    for (const url of [
      "http://localhost:18790/api",
      "http://127.0.0.1:5174/",
      "ftp://example.com/",
    ])
      await expect(
        service.manage({ action: "save_http_action", palId, httpAction: { ...httpAction, url } }),
      ).rejects.toThrow();
  });

  it("serves abilities over the authenticated API", async () => {
    const { service: root } = setup();
    const identity = root.companions.createOwner();
    const server = await startServer(root, {
      host: "127.0.0.1",
      port: 0,
      requireIdentity: true,
      schedulerTickMs: 0,
      log: () => {},
    });
    cleanups.push(() => server.close());
    const url = `http://127.0.0.1:${server.port}/api/abilities`;
    expect((await fetch(url)).status).toBe(401);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${identity.token}` } });
    const body = (await res.json()) as { skills: unknown[]; builtins: { name: string }[] };
    expect(body.skills).toHaveLength(4);
    expect(body.builtins.map((b) => b.name)).not.toContain("Web search");
  });
});

describe("PiBrain with abilities", () => {
  let n = 0;
  function setup() {
    const faux = fauxProvider({ provider: `abilities-${++n}` });
    const models = createModels();
    models.setProvider(faux.provider);
    const brain = new PiBrain(models, faux.getModel() as Model<never>, { log: () => {} });
    return { faux, brain };
  }
  const perform = (say: string) =>
    fauxAssistantMessage(
      [
        fauxToolCall("perform", {
          beats: [{ mood: "happy", intensity: 2, say, action: "nod", look: "user", fx: "none" }],
          bond: "same",
        }),
      ],
      { stopReason: "toolUse" },
    );

  it("indexes skills, loads one on demand, and appends index changes without rewriting", async () => {
    const { faux, brain } = setup();
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const service = new PalService(store, brain);
    let seen = "";
    faux.setResponses([
      (ctx) => {
        seen = JSON.stringify(ctx.messages);
        return fauxAssistantMessage([fauxToolCall("use_skill", { name: "morning-briefing" })], {
          stopReason: "toolUse",
        });
      },
      (ctx) => {
        expect(JSON.stringify(ctx.messages)).toContain("list_reminders");
        return perform("Chilly and grey today!");
      },
    ]);
    const first = await service.turn({ kind: "say", text: "brief me" });
    expect(first.turn.beats[0]?.say).toBe("Chilly and grey today!");
    expect(seen).toContain("morning-briefing: Give a short, cosy start-of-day briefing");
    expect(seen).toContain('"name":"use_skill"');
    expect(seen).not.toContain('"name":"run_action"');
    expect(service.abilities.skill(service.pal.id, "morning-briefing")!.uses).toBe(1);

    // The owner adds an action: the model gets a section update and the new tool.
    await service.manage({
      action: "save_http_action",
      palId: service.pal.id,
      httpAction: {
        name: "lamp-on",
        description: "Turn on the lamp.",
        method: "GET",
        url: "https://example.com/lamp",
      },
    });
    const session = store.openSession(service.pal.id, Date.now(), service.conversationId);
    const before = store.loadMessages(session.id);
    let second = "";
    faux.setResponses([
      (ctx) => {
        second = JSON.stringify(ctx.messages);
        return perform("Lamp time?");
      },
    ]);
    await service.turn({ kind: "say", text: "hello again" });
    const after = store.loadMessages(session.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(second).toContain("lamp-on: Turn on the lamp.");
    expect(second).toContain('"name":"run_action"');
  });
});

describe("customize-me: the pal changes itself", () => {
  function setup() {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const service = new PalService(store, new ScriptedBrain());
    return { store, service };
  }

  it("applies a strict patch, keeps identity, and reports what changed", () => {
    const { store, service } = setup();
    const before = service.pal;
    const summary = service.updateSelf({
      name: "Pip",
      look: { hue: 215, accessory: "crown" },
      temper: { playful: 9 },
      personality: { humor: "silly", likes: ["rain", "tea"] },
    });
    expect(summary).toContain('name → "Pip"');
    expect(summary).toContain("look.hue → 215");
    expect(summary).toContain('likes → ["rain","tea"]');
    const after = store.getPal(before.id)!;
    expect(after).toMatchObject({ id: before.id, seed: before.seed, name: "Pip" });
    expect(after.look).toEqual({ ...before.look, hue: 215, accessory: "crown" });
    expect(after.temper.playful).toBe(9);
    expect(service.companions.personality(after)).toMatchObject({
      humor: "silly",
      likes: ["rain", "tea"],
    });
    expect(service.updateSelf({ name: "Pip" })).toMatch(/Nothing changed/);
  });

  it("refuses invalid changes without touching anything", () => {
    const { store, service } = setup();
    const before = structuredClone(service.pal);
    for (const bad of [
      { look: { ears: "wings" } },
      { look: { hue: 400 } },
      { temper: { shy: 12 } },
      { id: "pal_hacked" },
      { seed: 1 },
      { personality: { likes: [] } },
      { name: "" },
      "rename me",
    ])
      expect(() => service.updateSelf(bad), JSON.stringify(bad)).toThrow();
    expect(store.getPal(before.id)).toEqual(before);
  });

  it("works offline in conversation and tells clients to redraw", async () => {
    const { service } = setup();
    const renamed = await service.turn({ kind: "say", text: "Call yourself Biscuit" });
    expect(renamed.dna?.name).toBe("Biscuit");
    expect(renamed.turn.beats[0]).toMatchObject({ action: "spin", fx: "sparkles" });
    // A random pal may already wear a hat, and an unchanged pal sends no DNA.
    service.updateSelf({ look: { accessory: "none" } });
    expect(
      (await service.turn({ kind: "say", text: "please wear a hat" })).dna?.look.accessory,
    ).toBe("hat");
    expect((await service.turn({ kind: "say", text: "turn purple!" })).dna?.look.hue).toBe(270);
    await service.turn({ kind: "say", text: "be sillier" });
    expect(service.companions.personality(service.pal).humor).toBe("silly");
    // Ordinary chat carries no DNA.
    expect((await service.turn({ kind: "say", text: "what's your name?" })).dna).toBeUndefined();
  });

  it("reaches pals seeded before it existed, once", () => {
    const { store, service } = setup();
    const palId = service.pal.id;
    store.setMeta(`skills_seeded:${palId}`, "1");
    expect(service.abilities.skills(palId).map((s) => s.name)).toEqual(["customize-me"]);
    service.abilities.deleteSkill(palId, service.abilities.skill(palId, "customize-me")!.id);
    expect(service.abilities.skills(palId)).toEqual([]);
  });

  it("PiBrain: update_self changes the pal and the character section follows", async () => {
    const faux = fauxProvider({ provider: "customize" });
    const models = createModels();
    models.setProvider(faux.provider);
    const brain = new PiBrain(models, faux.getModel() as Model<never>, { log: () => {} });
    const store = new Store(":memory:");
    cleanups.push(() => store.close());
    const service = new PalService(store, brain);
    const perform = fauxAssistantMessage(
      [
        fauxToolCall("perform", {
          beats: [
            {
              mood: "proud",
              intensity: 3,
              say: "I'm Nova now!",
              action: "spin",
              look: "user",
              fx: "sparkles",
            },
          ],
          bond: "up",
        }),
      ],
      { stopReason: "toolUse" },
    );
    let seen = "";
    faux.setResponses([
      (ctx) => {
        seen = JSON.stringify(ctx.messages);
        return fauxAssistantMessage(
          [fauxToolCall("update_self", { name: "Nova", look: { tail: "fish" } })],
          {
            stopReason: "toolUse",
          },
        );
      },
      (ctx) => {
        expect(JSON.stringify(ctx.messages)).toContain('Changed: name → \\"Nova\\"');
        return perform;
      },
    ]);
    const res = await service.turn({
      kind: "say",
      text: "Your name is Nova and give yourself a fish tail",
    });
    expect(seen).toContain("customize-me");
    expect(res.dna).toMatchObject({ name: "Nova", look: { tail: "fish" } });
    let next = "";
    faux.setResponses([
      (ctx) => {
        next = JSON.stringify(ctx.messages);
        return perform;
      },
    ]);
    await service.turn({ kind: "say", text: "who are you?" });
    expect(next).toContain("You are Nova.");
  });
});
