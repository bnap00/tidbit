import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  utf8Length,
  WIRE_MAX_BYTES,
} from "../src/index.js";
import { loadDnaFixtures, loadTurnFixtures } from "../src/fixtures-node.js";

describe("wire", () => {
  it("parses each client message type", () => {
    const hello = {
      type: "hello",
      clientId: "web-1",
      caps: { w: 240, h: 240, colors: 65536, input: ["text"] },
    };
    expect(parseClientMessage(JSON.stringify(hello)).ok).toBe(true);
    expect(parseClientMessage('{"type":"say","text":"hi"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"touch","kind":"pet"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"create"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"create","prompt":"a grumpy cactus cat"}').ok).toBe(true);
  });

  it("reports unknown types, bad JSON, invalid payloads and oversize frames", () => {
    expect(parseClientMessage('{"type":"dance"}')).toMatchObject({
      ok: false,
      code: "unknown_type",
    });
    expect(parseClientMessage("{nope")).toMatchObject({ ok: false, code: "bad_json" });
    expect(parseClientMessage('{"type":"touch","kind":"tickle"}')).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "say", text: "x".repeat(5000) })),
    ).toMatchObject({
      ok: false,
      code: "too_large",
    });
    expect(parseClientMessage('{"type":"toString"}')).toMatchObject({
      ok: false,
      code: "unknown_type",
    });
  });

  it("server messages built from fixtures are valid and under 1 KB", () => {
    const needs = { energy: 100, hunger: 100, bond: 100 };
    for (const { value: dna } of loadDnaFixtures()) {
      const text = JSON.stringify({ type: "character", dna });
      expect(parseServerMessage(text).ok).toBe(true);
      expect(utf8Length(text)).toBeLessThan(WIRE_MAX_BYTES);
    }
    for (const { value: turn } of loadTurnFixtures()) {
      const text = JSON.stringify({ type: "turn", id: "t_0000000001", turn, needs });
      expect(parseServerMessage(text).ok).toBe(true);
      expect(utf8Length(text)).toBeLessThan(WIRE_MAX_BYTES);
    }
    expect(parseServerMessage(JSON.stringify({ type: "needs", ...needs })).ok).toBe(true);
    expect(parseServerMessage('{"type":"mood","mood":"happy"}').ok).toBe(true);
    expect(parseServerMessage('{"type":"mood","mood":"ecstatic"}').ok).toBe(false);
    expect(parseServerMessage('{"type":"growth","stage":1}').ok).toBe(true);
    expect(parseServerMessage('{"type":"growth","stage":3}').ok).toBe(false);
  });
});
