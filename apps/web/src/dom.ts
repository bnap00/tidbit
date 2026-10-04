/** Tiny element helper. Text is always set with textContent, never innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | number | boolean | EventListener>> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function nav(active: string): HTMLElement {
  const link = (href: string, label: string) =>
    h("a", { href, class: href === active ? "active" : "", "data-link": true }, label);
  return h(
    "nav",
    { class: "topnav" },
    h("span", { class: "brand" }, "Tidbit"),
    link("/", "Pal"),
    link("/playground", "Playground"),
    link("/gallery", "Gallery"),
  );
}
