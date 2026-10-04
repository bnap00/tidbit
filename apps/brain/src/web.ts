// Network actions for the pal: read a web page, search, call an owner-defined HTTP
// action. Everything the model gets back is short, plain text and treated as data.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const PAGE_TEXT_MAX = 3000;
export const RESPONSE_BYTES_MAX = 512 * 1024;
const REDIRECTS_MAX = 3;
const UA = "tidbit/0.1 (+companion pet; reads pages on its owner's request)";

export type Lookup = (host: string) => Promise<string[]>;
export const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4Parts(ip: string): number[] | undefined {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined;
}

/**
 * Where an address points: the brain's own machine ("local"), a private network
 * ("private", including Tailscale's 100.64/10), or the public internet.
 */
export function addressScope(ip: string): "local" | "private" | "public" {
  let v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) v = mapped[1]!;
  const p = ipv4Parts(v);
  if (p) {
    const [a, b] = p as [number, number];
    if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return "local";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private";
    return "public";
  }
  if (v === "::" || v === "::1" || /^fe[89ab]/.test(v) || v.startsWith("ff")) return "local";
  if (/^f[cd]/.test(v)) return "private";
  return isIP(v) ? "public" : "local";
}

/**
 * Refuse URLs the pal must not reach: non-http(s), embedded credentials, the brain's own
 * machine, and (unless allowed) private networks. Checked again on every redirect.
 * DNS can change between this check and the request; the check stops the common cases.
 */
export async function checkUrl(
  raw: string,
  opts: { allowPrivate?: boolean; lookup?: Lookup } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw.slice(0, 80)}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("only http and https links can be opened");
  if (url.username || url.password) throw new Error("links with passwords are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host))
    throw new Error("that address is on a private network");
  const addresses = isIP(host) ? [host] : await (opts.lookup ?? defaultLookup)(host);
  if (!addresses.length) throw new Error(`could not find ${host}`);
  for (const a of addresses) {
    const scope = addressScope(a);
    if (scope === "local" || (scope === "private" && !opts.allowPrivate))
      throw new Error("that address is on a private network");
  }
  return url;
}

/** Read at most `max` bytes of a response body as text. */
export async function readCapped(res: Response, max = RESPONSE_BYTES_MAX): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= buf.length) break;
    buf.set(c.subarray(0, buf.length - off), off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: drops scripts, styles and markup; keeps paragraph breaks. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const main = /<(main|article)[\s>][\s\S]*<\/\1>/i.exec(html)?.[0] ?? html;
  const text = decodeEntities(
    main
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|head|nav|footer|form|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(
        /<\/?(p|div|section|article|li|ul|ol|h[1-6]|br|tr|table|blockquote|pre)[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  return { title, text };
}

export interface WebDeps {
  fetch: typeof fetch;
  lookup?: Lookup;
}

/** GET a public page and return its readable text, following a few checked redirects. */
export async function fetchPage(deps: WebDeps, raw: string, signal: AbortSignal): Promise<string> {
  let url = await checkUrl(raw, { lookup: deps.lookup });
  for (let hop = 0; ; hop++) {
    const res = await deps.fetch(url, {
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      if (hop >= REDIRECTS_MAX) throw new Error("too many redirects");
      url = await checkUrl(new URL(res.headers.get("location")!, url).href, {
        lookup: deps.lookup,
      });
      continue;
    }
    if (!res.ok) throw new Error(`the page answered ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (type && !/text\/|json|xml/i.test(type)) throw new Error(`can't read ${type.split(";")[0]}`);
    const body = await readCapped(res);
    const { title, text } =
      /html/i.test(type) || /^\s*</.test(body)
        ? htmlToText(body)
        : { title: "", text: body.trim() };
    const clipped = text.length > PAGE_TEXT_MAX ? `${text.slice(0, PAGE_TEXT_MAX)}…` : text;
    return `${title ? `${title}\n` : ""}${url.href}\n\n${clipped || "(no readable text)"}`;
  }
}

export interface SearchConfig {
  /** A SearXNG instance with the JSON format enabled. */
  searxngUrl?: string;
  braveKey?: string;
}

export const searchEnabled = (c: SearchConfig) => !!(c.searxngUrl || c.braveKey);

/** Top results as "title — url — snippet" lines. Uses whichever provider is configured. */
export async function webSearch(
  deps: WebDeps,
  config: SearchConfig,
  query: string,
  signal: AbortSignal,
): Promise<string> {
  let results: { title: string; url: string; snippet: string }[];
  if (config.braveKey) {
    const res = await deps.fetch(
      `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(query)}`,
      { signal, headers: { Accept: "application/json", "X-Subscription-Token": config.braveKey } },
    );
    if (!res.ok) throw new Error(`search failed (${res.status})`);
    const data = (await res.json()) as {
      web?: { results?: { title: string; url: string; description?: string }[] };
    };
    results = (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? "",
    }));
  } else if (config.searxngUrl) {
    const base = config.searxngUrl.replace(/\/+$/, "");
    const res = await deps.fetch(`${base}/search?format=json&q=${encodeURIComponent(query)}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`search failed (${res.status})`);
    const data = (await res.json()) as {
      results?: { title: string; url: string; content?: string }[];
    };
    results = (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? "",
    }));
  } else throw new Error("web search is not set up");
  if (!results.length) return "No results.";
  return results
    .slice(0, 5)
    .map((r, i) => {
      const snippet = htmlToText(r.snippet).text.replace(/\s+/g, " ").slice(0, 200);
      return `${i + 1}. ${htmlToText(r.title).text} — ${r.url}${snippet ? ` — ${snippet}` : ""}`;
    })
    .join("\n");
}

export interface HttpAction {
  name: string;
  method: "GET" | "POST";
  url: string;
  headers: [string, string][];
  bodyTemplate: string;
}

/** Fill an action's templates: `{input}` is URL-encoded in the URL and JSON-escaped in the body. */
export function actionRequest(action: HttpAction, input: string): { url: string; body?: string } {
  const url = action.url.replaceAll("{input}", encodeURIComponent(input));
  if (action.method === "GET") return { url };
  const escaped = JSON.stringify(input).slice(1, -1);
  const body = action.bodyTemplate
    ? action.bodyTemplate.replaceAll("{input}", escaped)
    : JSON.stringify({ input });
  return { url, body };
}

/** Run an owner-defined HTTP action. Redirects are not followed. */
export async function runHttpAction(
  deps: WebDeps & { allowPrivate?: boolean },
  action: HttpAction,
  input: string,
  signal: AbortSignal,
): Promise<string> {
  const req = actionRequest(action, input);
  const url = await checkUrl(req.url, { allowPrivate: deps.allowPrivate, lookup: deps.lookup });
  const headers: Record<string, string> = { "User-Agent": UA };
  if (req.body !== undefined) headers["Content-Type"] = "application/json";
  for (const [k, v] of action.headers) headers[k] = v;
  const res = await deps.fetch(url, {
    method: action.method,
    signal,
    redirect: "manual",
    headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const text = (await readCapped(res, 64 * 1024)).trim();
  const readable = /^\s*</.test(text) ? htmlToText(text).text : text;
  const clipped = readable.replace(/\s+/g, " ").slice(0, 1000);
  if (!res.ok)
    throw new Error(`${action.name} answered ${res.status}${clipped ? `: ${clipped}` : ""}`);
  return `${action.name} done (${res.status}).${clipped ? ` Response: ${clipped}` : ""}`;
}
